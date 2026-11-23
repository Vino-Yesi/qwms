/**
 * The ingestion pipeline.
 *
 *   signed webhook ──▶ raw_events (immutable) ──▶ outbox ──▶ normalise
 *        ──▶ canonical order ──▶ SKU mapping ──▶ order state machine
 *
 * Every step is durable and replayable. Payloads are stored before they are
 * interpreted, so a normaliser bug or a contract change parks the event in the
 * exception queue without losing the source of truth.
 */
import { z } from 'zod';
import {
  DomainError,
  audit,
  decrypt,
  emit,
  exception,
  fail,
  hashJson,
  many,
  maybeOne,
  normalizeDbError,
  one,
  setActorContext,
  tx,
  uid,
  type Client,
} from '../db/index.js';
import { SYSTEM_ACTOR, type Actor } from '../config.js';
import { adapterFor } from './adapters.js';
import { ConnectorContractError, type ConnectorContext, type ConnectorCredentials } from './types.js';
import type { CanonicalOrder } from '../domain/schema.js';
import { cancelOrderTx, transitionOrder } from '../domain/orders.js';

export const connectionRowSchema = z
  .object({
    id: z.uuid(),
    provider: z.enum(['ozon', 'yandex', 'wildberries']),
    name: z.string(),
    account_ref: z.string(),
    mode: z.enum(['sandbox', 'live']),
    status: z.enum(['enabled', 'paused', 'error']),
    credentials_ciphertext: z.string().nullable(),
    webhook_secret_ciphertext: z.string(),
    previous_secret_ciphertext: z.string().nullable().optional(),
    previous_secret_expires_at: z.any().optional(),
    webhook_scheme: z.string().optional(),
    config: z.record(z.string(), z.unknown()),
    cursor: z.record(z.string(), z.unknown()),
    last_error: z.string().nullable().optional(),
    last_sync_at: z.any().optional(),
    last_webhook_at: z.any().optional(),
    version: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

export type ConnectionRow = z.infer<typeof connectionRowSchema>;

export async function loadConnection(c: Client, connectionId: string, options: { enabledOnly?: boolean } = {}): Promise<ConnectionRow> {
  const row = await maybeOne(c, 'SELECT * FROM connections WHERE id=$1', [connectionId]);
  if (!row) fail(404, 'CONNECTION_NOT_FOUND', 'Connector does not exist');
  if (options.enabledOnly && row.status !== 'enabled') {
    fail(409, 'CONNECTION_PAUSED', 'Connector is paused; resume it before sending traffic');
  }
  return connectionRowSchema.parse(row);
}

export function credentialsOf(connection: ConnectionRow): ConnectorCredentials {
  if (!connection.credentials_ciphertext) return {};
  try {
    return JSON.parse(decrypt(connection.credentials_ciphertext)) as ConnectorCredentials;
  } catch (error) {
    throw new DomainError(422, 'CREDENTIALS_UNREADABLE', 'Stored connector credentials cannot be decrypted with this master key');
  }
}

export function contextOf(connection: ConnectionRow): ConnectorContext {
  return {
    connectionId: connection.id,
    provider: connection.provider,
    accountRef: connection.account_ref,
    mode: connection.mode,
    credentials: credentialsOf(connection),
    config: connection.config || {},
  };
}

/** Stable identity for a native payload before it is normalised. */
export function nativeEventIdentity(provider: string, payload: any): string {
  try {
    if (provider === 'ozon' && payload?.posting_number) {
      return `ozon:${payload.posting_number}:${payload.status || 'awaiting_packaging'}:${payload.in_process_at || ''}`;
    }
    if (provider === 'yandex' && payload?.id !== undefined) {
      return `yandex:${payload.id}:${payload.status || ''}:${payload.updatedAt || payload.createdAt || ''}`;
    }
    if (provider === 'wildberries' && payload?.id !== undefined) {
      return `wb:${payload.id}:${payload.status || ''}:${payload.createdAt || payload.ddate || ''}`;
    }
  } catch {
    /* fall through to content hash */
  }
  return `${provider}:payload:${hashJson(payload)}`;
}

type StoreInput = {
  connection: ConnectionRow;
  payload: unknown;
  eventType?: string;
  externalEventId?: string;
  headers?: Record<string, unknown>;
  signatureVerified: boolean;
};

/**
 * Persist a native payload exactly once. A content mismatch for the same event
 * identity is an integrity event, not an overwrite.
 */
export async function storeRawEvent(input: StoreInput): Promise<{
  raw_event_id: string;
  duplicate: boolean;
  conflict: boolean;
  status: string;
}> {
  const payloadHash = hashJson(input.payload);
  const externalEventId = input.externalEventId || nativeEventIdentity(input.connection.provider, input.payload);
  return tx(async (c) => {
    const existing = await maybeOne<any>(
      c,
      'SELECT * FROM raw_events WHERE connection_id=$1 AND external_event_id=$2',
      [input.connection.id, externalEventId],
    );
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        await exception(c, {
          kind: 'EVENT_PAYLOAD_CONFLICT',
          severity: 'HIGH',
          entityType: 'raw_event',
          entityId: existing.id,
          message: 'The same marketplace event id arrived with different content',
          details: { external_event_id: externalEventId, stored_hash: existing.payload_hash, received_hash: payloadHash },
        });
        await audit(c, SYSTEM_ACTOR, 'connector.event_conflict', 'raw_event', existing.id, null, {
          external_event_id: externalEventId,
          stored_hash: existing.payload_hash,
          received_hash: payloadHash,
        });
        return { raw_event_id: existing.id, duplicate: true, conflict: true, status: existing.status };
      }
      return { raw_event_id: existing.id, duplicate: true, conflict: false, status: existing.status };
    }
    const id = uid();
    await c.query(
      `INSERT INTO raw_events(id, connection_id, provider, external_event_id, event_type, payload, payload_hash,
         headers, signature_verified) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        input.connection.id,
        input.connection.provider,
        externalEventId,
        input.eventType || 'order',
        JSON.stringify(input.payload),
        payloadHash,
        JSON.stringify(input.headers || {}),
        input.signatureVerified,
      ],
    );
    await c.query('UPDATE connections SET last_webhook_at=now() WHERE id=$1', [input.connection.id]);
    await emit(c, {
      topic: 'connector.ingest',
      aggregateType: 'raw_event',
      aggregateId: id,
      payload: { raw_event_id: id, connection_id: input.connection.id, provider: input.connection.provider },
    });
    await audit(c, { ...SYSTEM_ACTOR, requestId: 'connector-store' }, 'connector.event_received', 'raw_event', id, null, {
      external_event_id: externalEventId,
      provider: input.connection.provider,
      signature_verified: input.signatureVerified,
    });
    return { raw_event_id: id, duplicate: false, conflict: false, status: 'RECEIVED' };
  });
}

async function markRaw(c: Client, rawId: string, status: string, orderId?: string | null): Promise<void> {
  await c.query('UPDATE raw_events SET status=$2, order_id=COALESCE($3, order_id), processed_at=now(), last_error=NULL WHERE id=$1', [
    rawId,
    status,
    orderId ?? null,
  ]);
}

/** Core order ingestion. Runs in the caller's transaction. */
async function ingestOrderTx(
  c: Client,
  actor: Actor,
  connection: ConnectionRow,
  raw: any,
  order: CanonicalOrder,
): Promise<{ order_id: string; status: string; duplicate: boolean }> {
  const { event_id: _eventId, ...source } = order;
  const sourceHash = hashJson(source);
  const existing = await maybeOne<any>(
    c,
    'SELECT * FROM orders WHERE connection_id=$1 AND external_id=$2 FOR UPDATE',
    [connection.id, order.external_id],
  );

  if (existing) {
    if (existing.source_hash !== sourceHash) {
      await exception(c, {
        kind: 'ORDER_REVISION',
        severity: 'HIGH',
        entityType: 'order',
        entityId: existing.id,
        message: 'Marketplace sent a revised order after ingestion; the original is preserved for review',
        details: {
          external_id: order.external_id,
          raw_event_id: raw.id,
          stored_hash: existing.source_hash,
          received_hash: sourceHash,
        },
      });
      await markRaw(c, raw.id, 'PROCESSED', existing.id);
      await audit(c, actor, 'order.revision_rejected', 'order', existing.id, null, { raw_event_id: raw.id });
      return { order_id: existing.id, status: existing.status, duplicate: true };
    }
    await markRaw(c, raw.id, 'DUPLICATE', existing.id);
    await audit(c, actor, 'order.duplicate_suppressed', 'order', existing.id, null, { raw_event_id: raw.id });
    return { order_id: existing.id, status: existing.status, duplicate: true };
  }

  const orderId = uid();
  await c.query(
    `INSERT INTO orders(id, connection_id, external_id, status, version, customer_ref, currency, total_minor,
       priority, ship_by, placed_at, raw_event_id, source_hash)
     VALUES($1,$2,$3,'RECEIVED',1,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      orderId,
      connection.id,
      order.external_id,
      order.customer_ref,
      order.currency,
      order.total_minor,
      order.priority || 'STANDARD',
      order.ship_by,
      order.placed_at || new Date().toISOString(),
      raw.id,
      sourceHash,
    ],
  );

  const externalSkus = order.lines.map((line) => line.external_sku);
  const params = [connection.id, ...externalSkus];
  const placeholders = externalSkus.map((_, index) => `$${index + 2}`).join(',');
  const mappings = await many<any>(
    c,
    `SELECT external_sku, sku FROM sku_mappings
     WHERE connection_id=$1 AND external_sku IN (${placeholders}) AND status='APPROVED'`,
    params,
  );
  const map = new Map(mappings.map((row) => [row.external_sku, row.sku]));

  const unmapped: Array<{ external_sku: string; external_name?: string }> = [];
  for (const line of order.lines) {
    const sku = map.get(line.external_sku) || null;
    if (!sku) unmapped.push({ external_sku: line.external_sku, external_name: line.external_name });
    await c.query(
      `INSERT INTO order_lines(id, order_id, external_sku, external_name, sku, quantity, unit_price_minor)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [uid(), orderId, line.external_sku, line.external_name ?? null, sku, line.quantity, line.unit_price_minor],
    );
  }

  await c.query('UPDATE connections SET last_sync_at=now(), last_error=NULL WHERE id=$1', [connection.id]);

  if (unmapped.length) {
    await transitionOrder(c, actor, orderId, 'EXCEPTION', 1, { reason: 'sku mapping required', exceptionCode: 'SKU_UNMAPPED' });
    await exception(c, {
      kind: 'SKU_UNMAPPED',
      severity: 'HIGH',
      entityType: 'order',
      entityId: orderId,
      message: `${unmapped.length} marketplace SKU(s) need an approved mapping`,
      details: { connection_id: connection.id, provider: connection.provider, external_id: order.external_id, unmapped },
      replayable: false,
    });
  } else {
    await transitionOrder(c, actor, orderId, 'MAPPED', 1, { reason: 'auto-mapped' });
  }

  const after = await one<any>(c, 'SELECT * FROM orders WHERE id=$1', [orderId]);
  await audit(c, actor, 'order.ingested', 'order', orderId, null, {
    external_id: order.external_id,
    connection_id: connection.id,
    raw_event_id: raw.id,
    status: after.status,
    total_minor: order.total_minor,
  });
  await emit(c, {
    topic: 'order.created',
    aggregateType: 'order',
    aggregateId: orderId,
    payload: {
      order_id: orderId,
      external_id: order.external_id,
      connection_id: connection.id,
      provider: connection.provider,
      status: after.status,
      version: Number(after.version),
      total_minor: Number(order.total_minor),
      unmapped: unmapped.length,
    },
  });
  await markRaw(c, raw.id, 'PROCESSED', orderId);
  return { order_id: orderId, status: after.status, duplicate: false };
}

async function ingestCancellationTx(
  c: Client,
  actor: Actor,
  connection: ConnectionRow,
  raw: any,
  externalId: string,
  reason: string,
): Promise<{ order_id: string | null; status: string }> {
  const order = await maybeOne<any>(
    c,
    'SELECT * FROM orders WHERE connection_id=$1 AND external_id=$2 FOR UPDATE',
    [connection.id, externalId],
  );
  if (!order) {
    await exception(c, {
      kind: 'CANCEL_UNKNOWN_ORDER',
      severity: 'LOW',
      entityType: 'raw_event',
      entityId: raw.id,
      message: `Marketplace cancelled ${externalId}, which is not in this system`,
      details: { provider: connection.provider, external_id: externalId, reason },
    });
    await markRaw(c, raw.id, 'IGNORED');
    return { order_id: null, status: 'IGNORED' };
  }
  if (['SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED'].includes(order.status)) {
    await exception(c, {
      kind: 'CANCELLATION_TOO_LATE',
      severity: 'HIGH',
      entityType: 'order',
      entityId: order.id,
      message: `Marketplace cancelled ${externalId} after it reached ${order.status}; returns workflow required`,
      details: { provider: connection.provider, status: order.status, reason },
    });
    await markRaw(c, raw.id, 'IGNORED');
    return { order_id: order.id, status: order.status };
  }
  const result = await cancelOrderTx(c, actor, order.id, Number(order.version), `marketplace: ${reason}`);
  await markRaw(c, raw.id, 'PROCESSED', order.id);
  return { order_id: order.id, status: result.status };
}

async function markFailure(rawId: string, error: unknown): Promise<void> {
  const normalized = normalizeDbError(error) as any;
  const message = String(normalized?.message || error).slice(0, 500);
  const retryable = !(error instanceof ConnectorContractError) && !(normalized instanceof DomainError && normalized.status < 500);
  await tx(async (c) => {
    const raw = await maybeOne<any>(c, 'SELECT * FROM raw_events WHERE id=$1', [rawId]);
    if (!raw) return;
    await c.query('UPDATE raw_events SET status=$2, last_error=$3 WHERE id=$1', [rawId, retryable ? 'RECEIVED' : 'FAILED', message]);
    await exception(c, {
      kind: error instanceof ConnectorContractError ? 'CONTRACT_MISMATCH' : 'INGESTION_FAILED',
      severity: 'HIGH',
      entityType: 'raw_event',
      entityId: rawId,
      message,
      details:
        error instanceof ConnectorContractError
          ? { provider: error.provider, details: error.details, retryable: false }
          : { code: normalized?.code, retryable },
      replayable: true,
    });
    await audit(c, SYSTEM_ACTOR, 'connector.ingest_failed', 'raw_event', rawId, null, { message, retryable });
  });
}

/** Normalise and ingest one stored event. Safe to call repeatedly. */
export async function processRawEvent(rawEventId: string): Promise<'processed' | 'duplicate' | 'failed' | 'skipped'> {
  const actor: Actor = { ...SYSTEM_ACTOR, requestId: `raw:${rawEventId}` };
  try {
    return await tx(async (c) => {
      const raw = await maybeOne<any>(c, 'SELECT * FROM raw_events WHERE id=$1 FOR UPDATE', [rawEventId]);
      if (!raw) fail(404, 'RAW_EVENT_NOT_FOUND', 'Raw event does not exist');
      if (['PROCESSED', 'DUPLICATE', 'IGNORED'].includes(raw.status)) return 'skipped';
      const connection = await loadConnection(c, raw.connection_id, { enabledOnly: true });
      if (connection.mode !== 'sandbox' && connection.mode !== 'live') fail(409, 'MODE_INVALID', 'Unsupported connector mode');
      await c.query(`UPDATE raw_events SET status='PROCESSING', attempts=attempts+1 WHERE id=$1`, [rawEventId]);
      await setActorContext(c, actor, 'ingest');

      const adapter = adapterFor(connection.provider);
      const normalized = adapter.normalize(raw.payload, contextOf(connection));
      if (normalized.kind === 'cancel') {
        const result = await ingestCancellationTx(c, actor, connection, raw, normalized.externalId, normalized.reason || 'marketplace cancellation');
        return result.status === 'IGNORED' ? 'processed' : 'processed';
      }
      const canonical = normalized.order;
      if (!canonical) throw new DomainError(422, 'CONTRACT_MISMATCH', 'Adapter produced no canonical order');
      const result = await ingestOrderTx(c, actor, connection, raw, canonical);
      return result.duplicate ? 'duplicate' : 'processed';
    });
  } catch (error) {
    await markFailure(rawEventId, error);
    const normalized = normalizeDbError(error) as any;
    if (error instanceof ConnectorContractError) return 'failed';
    if (normalized instanceof DomainError && normalized.status < 500) return 'failed';
    throw normalized;
  }
}

/** Operator-initiated replay of a parked raw event. */
export async function replayRawEvent(actor: Actor, rawEventId: string): Promise<{ status: string }> {
  return tx(async (c) => {
    const raw = await maybeOne<any>(c, 'SELECT * FROM raw_events WHERE id=$1 FOR UPDATE', [rawEventId]);
    if (!raw) fail(404, 'RAW_EVENT_NOT_FOUND', 'Raw event does not exist');
    if (['RECEIVED', 'PROCESSING'].includes(raw.status)) fail(409, 'ALREADY_PENDING', 'Event is already queued');
    await c.query(
      `UPDATE raw_events SET status='RECEIVED', attempts=0, last_error=NULL, processed_at=NULL WHERE id=$1`,
      [rawEventId],
    );
    await c.query(
      `UPDATE exceptions SET status='RESOLVED', resolved_by=$2, resolved_at=now(), resolution='raw event replayed'
       WHERE status='OPEN' AND entity_type='raw_event' AND entity_id=$1`,
      [rawEventId, actor.id],
    );
    await emit(c, {
      topic: 'connector.ingest',
      aggregateType: 'raw_event',
      aggregateId: rawEventId,
      payload: { raw_event_id: rawEventId, connection_id: raw.connection_id, provider: raw.provider, replay: true },
    });
    await audit(c, actor, 'connector.event_replayed', 'raw_event', rawEventId, raw, { status: 'RECEIVED' });
    return { status: 'queued' };
  });
}
