/**
 * Marketplace connector hub.
 *
 * Owns connector lifecycle (credentials, secret rotation, pause/resume),
 * signature verification, pull synchronisation, outbound status/stock/shipment
 * calls, and the certified sandbox simulator. Every provider call is recorded
 * with a stable idempotency key so retries are observable and safe.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  audit,
  db,
  decrypt,
  emit,
  encrypt,
  exception,
  fail,
  hashJson,
  many,
  maybeOne,
  one,
  query,
  recordProviderOperation,
  tx,
  uid,
} from '../db/index.js';
import { config, providers, type Actor, type ConnectorProvider } from '../config.js';
import { adapterFor, marketplaceStatus } from './adapters.js';
import { callAdapter, UpstreamError } from './transport.js';
import { credentialsOf, loadConnection, nativeEventIdentity, storeRawEvent, type ConnectionRow } from './ingestion.js';
import { credentialsSchema } from './credentials.js';

const SIGNATURE_HEADERS = {
  'yesi-hmac-v1': { signature: 'x-yesi-signature', timestamp: 'x-yesi-timestamp' },
  'wildberries-hmac-v1': { signature: 'x-wb-signature', timestamp: 'x-wb-timestamp' },
  'yandex-hmac-v1': { signature: 'x-yandex-signature', timestamp: 'x-yandex-timestamp' },
} as const;

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function secretsOf(connection: ConnectionRow): string[] {
  const secrets = [decrypt(connection.webhook_secret_ciphertext)];
  const row = connection as any;
  if (row.previous_secret_ciphertext && row.previous_secret_expires_at) {
    if (new Date(row.previous_secret_expires_at).getTime() > Date.now()) {
      secrets.push(decrypt(row.previous_secret_ciphertext));
    }
  }
  return secrets;
}

export type WebhookCheck = { ok: boolean; scheme: string; reason?: string };

/** Verify a webhook with the scheme configured for the connector. */
export function verifyWebhook(
  connection: ConnectionRow,
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
): WebhookCheck {
  const scheme = (connection as any).webhook_scheme || 'yesi-hmac-v1';
  const mapping = SIGNATURE_HEADERS[scheme as keyof typeof SIGNATURE_HEADERS];
  if (!mapping) return { ok: false, scheme, reason: 'Unknown signature scheme' };
  const header = (name: string): string => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : String(value ?? '');
  };
  const signature = header(mapping.signature).replace(/^sha256=/, '');
  if (!signature) return { ok: false, scheme, reason: `Missing ${mapping.signature}` };
  const timestampHeader = header(mapping.timestamp);
  if (scheme === 'yesi-hmac-v1') {
    const timestamp = Number(timestampHeader);
    if (!Number.isFinite(timestamp)) return { ok: false, scheme, reason: 'Missing or invalid timestamp' };
    const skew = Math.abs(Date.now() / 1000 - timestamp);
    if (skew > config.webhookToleranceSeconds) return { ok: false, scheme, reason: 'Timestamp outside the replay window' };
  }
  const body = rawBody.toString('utf8');
  for (const secret of secretsOf(connection)) {
    const signed = scheme === 'yesi-hmac-v1' ? `${timestampHeader}.${body}` : body;
    const expected = createHmac('sha256', secret).update(signed).digest('hex');
    if (safeEqual(expected, signature.toLowerCase())) return { ok: true, scheme };
  }
  return { ok: false, scheme, reason: 'Signature mismatch' };
}

/** Build the headers a caller (simulator or partner gateway) must send. */
export function signWebhook(connection: ConnectionRow, rawBody: string): Record<string, string> {
  const scheme = (connection as any).webhook_scheme || 'yesi-hmac-v1';
  const secret = decrypt(connection.webhook_secret_ciphertext);
  const timestamp = String(Math.floor(Date.now() / 1000));
  if (scheme === 'yesi-hmac-v1') {
    return {
      'content-type': 'application/json',
      'x-yesi-timestamp': timestamp,
      'x-yesi-signature': 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex'),
    };
  }
  const header = scheme === 'wildberries-hmac-v1' ? 'x-wb-signature' : 'x-yandex-signature';
  return {
    'content-type': 'application/json',
    [header]: createHmac('sha256', secret).update(rawBody).digest('hex'),
  };
}

// ------------------------------------------------------------ connector CRUD --
export async function listConnections() {
  const rows = await many(
    db,
    `SELECT c.id, c.provider, c.name, c.account_ref, c.mode, c.status, c.config, c.cursor,
            c.last_sync_at, c.last_webhook_at, c.last_error, c.created_at,
            (SELECT count(*)::int FROM raw_events r WHERE r.connection_id=c.id) AS events_received,
            (SELECT count(*)::int FROM raw_events r WHERE r.connection_id=c.id AND r.status='FAILED') AS failed_events,
            (SELECT count(*)::int FROM orders o WHERE o.connection_id=c.id) AS orders,
            (SELECT count(*)::int FROM provider_operations p WHERE p.connection_id=c.id AND p.status='FAILED') AS failed_operations,
            (SELECT max(cr.started_at) FROM connector_runs cr WHERE cr.connection_id=c.id) AS last_run_at,
            (SELECT cr.status FROM connector_runs cr WHERE cr.connection_id=c.id ORDER BY cr.started_at DESC LIMIT 1) AS last_run_status,
            (SELECT count(*)::int FROM sku_mappings m WHERE m.connection_id=c.id AND m.status='APPROVED') AS mappings
     FROM connections c ORDER BY c.provider, c.name`,
  );
  return rows;
}

export async function connectionDetail(connectionId: string) {
  const connection = await one(
    db,
    `SELECT id, provider, name, account_ref, mode, status, config, cursor, last_sync_at, last_webhook_at,
            last_error, webhook_scheme, created_at, updated_at, version,
            (credentials_ciphertext IS NOT NULL) AS has_credentials
     FROM connections WHERE id=$1`,
    [connectionId],
  );
  const [runs, operations, rawEvents] = await Promise.all([
    many(db, 'SELECT * FROM connector_runs WHERE connection_id=$1 ORDER BY started_at DESC LIMIT 30', [connectionId]),
    many(db, 'SELECT * FROM provider_operations WHERE connection_id=$1 ORDER BY created_at DESC LIMIT 50', [connectionId]),
    many(
      db,
      `SELECT id, external_event_id, event_type, status, attempts, last_error, order_id, received_at, processed_at, payload_hash
       FROM raw_events WHERE connection_id=$1 ORDER BY received_at DESC LIMIT 50`,
      [connectionId],
    ),
  ]);
  return { ...connection, runs, operations, raw_events: rawEvents };
}

export async function createConnection(
  actor: Actor,
  input: {
    provider: ConnectorProvider;
    name: string;
    accountRef: string;
    webhookSecret: string;
    mode?: 'sandbox' | 'live';
    webhookScheme?: keyof typeof SIGNATURE_HEADERS;
    credentials?: unknown;
    config?: Record<string, unknown>;
  },
) {
  if (!providers.includes(input.provider)) fail(422, 'UNKNOWN_PROVIDER', 'Unsupported marketplace provider');
  const mode = input.mode || 'sandbox';
  const credentials = input.credentials ? credentialsSchema.parse(input.credentials) : undefined;
  if (mode === 'live' && !credentials?.apiKey) {
    fail(422, 'CREDENTIALS_REQUIRED', 'Live connectors require API credentials');
  }
  return tx(async (c) => {
    const id = uid();
    await c.query(
      `INSERT INTO connections(id, provider, name, account_ref, mode, credentials_ciphertext,
         webhook_secret_ciphertext, webhook_scheme, config)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        input.provider,
        input.name,
        input.accountRef,
        mode,
        credentials ? encrypt(JSON.stringify(credentials)) : null,
        encrypt(input.webhookSecret),
        input.webhookScheme || 'yesi-hmac-v1',
        JSON.stringify(input.config || {}),
      ],
    );
    await audit(c, actor, 'connector.created', 'connection', id, null, {
      provider: input.provider,
      account_ref: input.accountRef,
      mode,
      has_credentials: Boolean(credentials),
    });
    await emit(c, {
      topic: 'connector.updated',
      aggregateType: 'connection',
      aggregateId: id,
      payload: { connection_id: id, provider: input.provider, status: 'enabled' },
    });
    return { id, mode };
  });
}

export async function updateConnection(
  actor: Actor,
  connectionId: string,
  patch: {
    name?: string;
    status?: 'enabled' | 'paused';
    mode?: 'sandbox' | 'live';
    credentials?: unknown;
    config?: Record<string, unknown>;
  },
) {
  return tx(async (c) => {
    const before = await one<any>(c, 'SELECT * FROM connections WHERE id=$1 FOR UPDATE', [connectionId]);
    const credentials = patch.credentials ? credentialsSchema.parse(patch.credentials) : null;
    const mode = patch.mode || before.mode;
    if (mode === 'live' && !credentials && !before.credentials_ciphertext) {
      fail(422, 'CREDENTIALS_REQUIRED', 'Live mode requires API credentials');
    }
    await c.query(
      `UPDATE connections SET name=$2, status=$3, mode=$4,
         credentials_ciphertext=COALESCE($5, credentials_ciphertext),
         config=$6, last_error=NULL, version=version+1, updated_at=now()
       WHERE id=$1`,
      [
        connectionId,
        patch.name ?? before.name,
        patch.status ?? before.status,
        mode,
        credentials ? encrypt(JSON.stringify(credentials)) : null,
        JSON.stringify(patch.config ?? before.config),
      ],
    );
    const after = await one<any>(c, 'SELECT * FROM connections WHERE id=$1', [connectionId]);
    await audit(c, actor, 'connector.updated', 'connection', connectionId, before, {
      name: after.name,
      status: after.status,
      mode: after.mode,
      config: after.config,
    });
    await emit(c, {
      topic: 'connector.updated',
      aggregateType: 'connection',
      aggregateId: connectionId,
      payload: { connection_id: connectionId, provider: after.provider, status: after.status, mode: after.mode },
    });
    return { id: connectionId, status: after.status, mode: after.mode };
  });
}

export async function rotateWebhookSecret(actor: Actor, connectionId: string, newSecret: string) {
  return tx(async (c) => {
    const before = await one<any>(c, 'SELECT * FROM connections WHERE id=$1 FOR UPDATE', [connectionId]);
    await c.query(
      `UPDATE connections SET previous_secret_ciphertext=webhook_secret_ciphertext,
         previous_secret_expires_at=now()+interval '24 hours',
         webhook_secret_ciphertext=$2, version=version+1, updated_at=now()
       WHERE id=$1`,
      [connectionId, encrypt(newSecret)],
    );
    await audit(c, actor, 'connector.secret_rotated', 'connection', connectionId, null, {
      previous_valid_until: new Date(Date.now() + 86_400_000).toISOString(),
    });
    return { id: connectionId, previous_valid_for_hours: 24 };
  });
}

// ------------------------------------------------------------------- pulls --
function sandboxBatch(connection: ConnectionRow, count: number): { payloads: any[]; nextSeq: number } {
  const cursor = (connection.cursor || {}) as any;
  let seq = Number(cursor.pull_seq || 0);
  const payloads: any[] = [];
  for (let i = 0; i < count; i++) {
    seq += 1;
    const scenario =
      seq % 11 === 0 ? 'unmapped' : seq % 5 === 0 ? 'multi_line' : 'normal';
    const prefix = connection.provider === 'ozon' ? 'OZ' : connection.provider === 'yandex' ? 'YM' : 'WB';
    const externalId =
      connection.provider === 'wildberries'
        ? String(7_700_000 + seq)
        : `${prefix}-SIM-${String(seq).padStart(6, '0')}`;
    payloads.push(adapterFor(connection.provider).sample(scenario as any, seq, externalId));
  }
  return { payloads, nextSeq: seq };
}

export async function runPull(connectionId: string, actor: Actor, trigger: 'manual' | 'schedule' = 'manual') {
  const connection = await tx((c) => loadConnection(c, connectionId, { enabledOnly: true }));
  // Backpressure: a scheduled pull never grows an already deep backlog. Manual
  // pulls are operator intent and bypass the gate. This mirrors the rate-limit
  // and quota guards a production connector must respect.
  if (trigger === 'schedule' && connection.mode === 'sandbox') {
    const backlog = await maybeOne<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM orders WHERE status NOT IN ('SHIPPED','DELIVERED','CANCELLED','RETURNED')`,
    );
    if ((backlog?.n ?? 0) >= 60) {
      return { run_id: null, fetched: 0, stored: 0, duplicates: 0, skipped: 'backpressure' as const };
    }
  }
  const runId = uid();
  const startedAt = Date.now();
  await tx((c) =>
    c.query('INSERT INTO connector_runs(id, connection_id, kind, status) VALUES($1,$2,\'pull\',\'RUNNING\')', [runId, connectionId]),
  );
  try {
    const adapter = adapterFor(connection.provider);
    let payloads: any[] = [];
    let nextCursor: Record<string, unknown> = connection.cursor || {};

    if (connection.mode === 'sandbox') {
      const batch = sandboxBatch(connection, trigger === 'manual' ? 2 : 1);
      payloads = batch.payloads;
      nextCursor = { ...nextCursor, pull_seq: batch.nextSeq, last_since: new Date().toISOString() };
    } else {
      const call = await callAdapter(
        adapter,
        {
          connectionId: connection.id,
          provider: connection.provider,
          accountRef: connection.account_ref,
          mode: connection.mode,
          credentials: credentialsOf(connection),
          config: connection.config,
        },
        'pull_orders',
        { since: (connection.cursor as any)?.last_since, offset: 0, next: (connection.cursor as any)?.next ?? 0 },
        `pull:${connection.id}:${new Date().toISOString().slice(0, 16)}`,
      );
      const data = call.data as any;
      if (connection.provider === 'ozon') payloads = data?.result?.postings ?? [];
      else if (connection.provider === 'yandex') payloads = data?.orders ?? [];
      else payloads = data?.orders ?? [];
      if (!Array.isArray(payloads)) {
        throw new Error('Pull response did not contain an order array');
      }
      nextCursor = {
        ...nextCursor,
        last_since: new Date().toISOString(),
        next: connection.provider === 'wildberries' ? data?.next ?? 0 : undefined,
      };
      await tx((c) =>
        recordProviderOperation(c, {
          connectionId,
          provider: connection.provider,
          operation: 'pull_orders',
          direction: 'OUT',
          idempotencyKey: `pull:${connection.id}:${new Date().toISOString().slice(0, 16)}`,
          request: call.request.body,
          response: data,
          httpStatus: call.status,
          status: 'OK',
          latencyMs: call.latencyMs,
        }),
      );
    }

    let stored = 0;
    let duplicates = 0;
    for (const payload of payloads) {
      const result = await storeRawEvent({
        connection,
        payload,
        eventType: 'order',
        externalEventId: nativeEventIdentity(connection.provider, payload),
        signatureVerified: true,
        headers: { 'x-yesi-source': trigger === 'manual' ? 'manual-pull' : 'scheduled-pull' },
      });
      if (result.duplicate) duplicates += 1;
      else stored += 1;
    }
    await tx(async (c) => {
      await c.query('UPDATE connections SET cursor=$2, last_sync_at=now(), last_error=NULL, status=status WHERE id=$1', [
        connectionId,
        JSON.stringify(nextCursor),
      ]);
      await c.query(
        `UPDATE connector_runs SET status='OK', stats=$2, finished_at=now(), duration_ms=$3 WHERE id=$1`,
        [runId, JSON.stringify({ fetched: payloads.length, stored, duplicates }), Date.now() - startedAt],
      );
      await audit(c, actor, 'connector.pulled', 'connection', connectionId, null, {
        run_id: runId,
        fetched: payloads.length,
        stored,
        duplicates,
        trigger,
      });
      await emit(c, {
        topic: 'connector.sync',
        aggregateType: 'connection',
        aggregateId: connectionId,
        payload: { connection_id: connectionId, provider: connection.provider, fetched: payloads.length, stored, duplicates, trigger },
      });
    });
    return { run_id: runId, fetched: payloads.length, stored, duplicates };
  } catch (error) {
    const message = (error as Error).message;
    await tx(async (c) => {
      await c.query(`UPDATE connector_runs SET status='FAILED', error=$2, finished_at=now(), duration_ms=$3 WHERE id=$1`, [
        runId,
        message.slice(0, 500),
        Date.now() - startedAt,
      ]);
      await c.query('UPDATE connections SET last_error=$2 WHERE id=$1', [connectionId, message.slice(0, 500)]);
      await exception(c, {
        kind: 'CONNECTOR_SYNC_FAILED',
        severity: 'HIGH',
        entityType: 'connection',
        entityId: connectionId,
        message: `Pull failed: ${message}`,
        details: { provider: connection.provider, run_id: runId, http_status: error instanceof UpstreamError ? error.httpStatus : undefined },
        replayable: true,
      });
      await audit(c, actor, 'connector.pull_failed', 'connection', connectionId, null, { run_id: runId, message });
    });
    throw error;
  }
}

// --------------------------------------------------------------- outbound --
async function performOutbound(params: {
  connection: ConnectionRow;
  operation: 'push_status' | 'push_stock' | 'confirm_shipment';
  input: Record<string, unknown>;
  idempotencyKey: string;
  actor: Actor;
}) {
  const adapter = adapterFor(params.connection.provider);
  const context = {
    connectionId: params.connection.id,
    provider: params.connection.provider,
    accountRef: params.connection.account_ref,
    mode: params.connection.mode,
    credentials: credentialsOf(params.connection),
    config: params.connection.config,
  };
  try {
    const result = await callAdapter(adapter, context, params.operation, params.input, params.idempotencyKey);
    await tx(async (c) => {
      await recordProviderOperation(c, {
        connectionId: params.connection.id,
        provider: params.connection.provider,
        operation: params.operation,
        direction: 'OUT',
        idempotencyKey: params.idempotencyKey,
        request: result.request.body,
        response: result.data,
        httpStatus: result.status,
        status: 'OK',
        latencyMs: result.latencyMs,
      });
      await c.query('UPDATE connections SET last_sync_at=now(), last_error=NULL WHERE id=$1', [params.connection.id]);
      await emit(c, {
        topic: 'connector.operation',
        aggregateType: 'connection',
        aggregateId: params.connection.id,
        payload: {
          connection_id: params.connection.id,
          provider: params.connection.provider,
          operation: params.operation,
          status: 'OK',
          mode: result.mode,
        },
      });
    });
    return { ok: true, mode: result.mode, data: result.data };
  } catch (error) {
    const message = (error as Error).message;
    await tx(async (c) => {
      await recordProviderOperation(c, {
        connectionId: params.connection.id,
        provider: params.connection.provider,
        operation: params.operation,
        direction: 'OUT',
        idempotencyKey: params.idempotencyKey,
        request: params.input,
        status: 'FAILED',
        error: message,
        httpStatus: error instanceof UpstreamError ? error.httpStatus : undefined,
      });
      await c.query('UPDATE connections SET last_error=$2 WHERE id=$1', [params.connection.id, message.slice(0, 500)]);
      await audit(c, params.actor, 'connector.operation_failed', 'connection', params.connection.id, null, {
        operation: params.operation,
        idempotency_key: params.idempotencyKey,
        message,
      });
      await emit(c, {
        topic: 'connector.operation',
        aggregateType: 'connection',
        aggregateId: params.connection.id,
        payload: {
          connection_id: params.connection.id,
          provider: params.connection.provider,
          operation: params.operation,
          status: 'FAILED',
          message,
        },
      });
    });
    throw error;
  }
}

export async function pushOrderStatus(order: any, connection: ConnectionRow, actor: Actor) {
  const status = marketplaceStatus(connection.provider, order.status);
  const lines = await many<any>(db, 'SELECT external_sku, quantity FROM order_lines WHERE order_id=$1', [order.id]);
  return performOutbound({
    connection,
    operation: 'push_status',
    input: {
      external_id: order.external_id,
      status: order.status,
      marketplace_status: status,
      products: lines.map((line) => ({
        external_sku: line.external_sku,
        quantity: Number(line.quantity),
      })),
    },
    idempotencyKey: `status:${order.id}:${order.version}`,
    actor,
  });
}

export async function pushStockForSkus(skus: string[], connections: ConnectionRow[], actor: Actor) {
  const results: Array<{ connection_id: string; pushed: number; skipped: number }> = [];
  for (const connection of connections) {
    if (connection.status !== 'enabled') continue;
    const stocks: Array<{ external_sku: string; available: number }> = [];
    for (const sku of [...new Set(skus)]) {
      const mapping = await maybeOne<any>(
        db,
        `SELECT external_sku FROM sku_mappings WHERE connection_id=$1 AND sku=$2 AND status='APPROVED'`,
        [connection.id, sku],
      );
      if (!mapping) continue;
      const row = await maybeOne<{ available: number }>(
        db,
        'SELECT coalesce(sum(on_hand - reserved - damaged),0)::int AS available FROM inventory WHERE sku=$1',
        [sku],
      );
      stocks.push({ external_sku: mapping.external_sku, available: Math.max(0, Number(row?.available || 0)) });
    }
    if (!stocks.length) {
      results.push({ connection_id: connection.id, pushed: 0, skipped: skus.length });
      continue;
    }
    const key = `stock:${connection.id}:${hashJson(stocks).slice(0, 24)}`;
    await performOutbound({ connection, operation: 'push_stock', input: { stocks }, idempotencyKey: key, actor });
    results.push({ connection_id: connection.id, pushed: stocks.length, skipped: 0 });
  }
  return results;
}

export async function confirmShipmentWithMarketplace(order: any, shipment: any, connection: ConnectionRow, actor: Actor) {
  return performOutbound({
    connection,
    operation: 'confirm_shipment',
    input: {
      external_id: order.external_id,
      status: order.status,
      tracking_number: shipment.tracking_number,
      carrier: shipment.carrier,
      products: (await many<any>(db, 'SELECT external_sku, quantity FROM order_lines WHERE order_id=$1', [order.id])).map(
        (line) => ({ external_sku: line.external_sku, quantity: Number(line.quantity) }),
      ),
    },
    idempotencyKey: `ship:${shipment.id}:${connection.provider}`,
    actor,
  });
}

// --------------------------------------------------------------- simulator --
/**
 * Runs the exact webhook path: native payload -> signature -> raw event.
 * This is how a connector is certified in sandbox before live credentials.
 */
export async function simulateInbound(
  actor: Actor,
  connectionId: string,
  scenario: 'normal' | 'multi_line' | 'unmapped' | 'cancelled' | 'malformed',
  seed?: number,
  externalId?: string,
) {
  const connection = await tx((c) => loadConnection(c, connectionId));
  const adapter = adapterFor(connection.provider);
  const useSeed = seed ?? Math.floor(Date.now() / 1000) % 1_000_000;
  const payload = adapter.sample(scenario, useSeed, externalId);
  const rawBody = JSON.stringify(payload);
  const headers = signWebhook(connection, rawBody);
  const check = verifyWebhook(connection, headers, Buffer.from(rawBody));
  if (!check.ok) fail(500, 'SIMULATOR_SIGNATURE_FAILED', `Simulator signature rejected: ${check.reason}`);
  const result = await storeRawEvent({
    connection,
    payload,
    eventType: scenario === 'cancelled' ? 'order.cancelled' : 'order',
    externalEventId: nativeEventIdentity(connection.provider, payload),
    headers: { ...headers, 'x-yesi-source': 'simulator' },
    signatureVerified: true,
  });
  await tx(async (c) => {
    await c.query(
      'INSERT INTO connector_runs(id, connection_id, kind, status, stats, finished_at, duration_ms) VALUES($1,$2,\'simulate\',\'OK\',$3,now(),0)',
      [uid(), connectionId, JSON.stringify({ scenario, seed: useSeed, raw_event_id: result.raw_event_id })],
    );
    await audit(c, actor, 'connector.simulated', 'connection', connectionId, null, {
      scenario,
      seed: useSeed,
      raw_event_id: result.raw_event_id,
      duplicate: result.duplicate,
    });
  });
  return { ...result, scenario, seed: useSeed };
}

export async function connectorSummary() {
  const rows = await query<{ provider: string; connections: number; orders: number; failed_events: number; last_sync_at: string }>(
    `SELECT c.provider, count(*)::int AS connections,
            (SELECT count(*)::int FROM orders o JOIN connections c2 ON c2.id=o.connection_id
              WHERE c2.provider=c.provider) AS orders,
            (SELECT count(*)::int FROM raw_events r JOIN connections c3 ON c3.id=r.connection_id
              WHERE c3.provider=c.provider AND r.status='FAILED') AS failed_events,
            max(c.last_sync_at) AS last_sync_at
     FROM connections c GROUP BY c.provider`,
  );
  return rows;
}
