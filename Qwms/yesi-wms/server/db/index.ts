/**
 * Data access primitives shared by every domain service.
 *
 * The rules enforced here are the spine of the platform:
 *  - every business effect runs inside one transaction
 *  - outbox events are buffered and published only after COMMIT
 *  - audit entries form a hash chain under an advisory lock
 *  - idempotent commands bind a key to a canonical request hash
 *  - stock only moves through an append-only ledger with balances
 */
import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config, type Actor } from '../config.js';
import { createDatabase, type Client, type Queryable } from './driver.js';
import { publishEvent, type DomainEvent } from '../bus.js';

export type { Client, Queryable } from './driver.js';

export const db = await createDatabase(config.databaseUrl);
/** Alias kept for readability in services that only read. */
export const pool = db;

export class DomainError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const fail = (status: number, code: string, message: string, details?: unknown): never => {
  throw new DomainError(status, code, message, details);
};

/** Map low-level PostgreSQL integrity errors to honest HTTP semantics. */
export function normalizeDbError(error: unknown): unknown {
  if (error instanceof DomainError) return error;
  const err = error as any;
  const message = String(err?.message || '');
  const code = String(err?.code || '');
  const conflict = (c: string, text: string) => new DomainError(409, c, text);
  if (/ILLEGAL_TRANSITION/i.test(message)) return conflict('ILLEGAL_TRANSITION', message.replace(/^error:\s*/i, ''));
  if (/VERSION_CONFLICT/i.test(message)) return conflict('VERSION_CONFLICT', 'The record changed since you loaded it');
  if (/APPEND_ONLY_VIOLATION/i.test(message)) return conflict('APPEND_ONLY', 'This record is append-only');
  if (/JOURNAL_UNBALANCED/i.test(message)) return conflict('FINANCE_INTEGRITY', message);
  if (/ORDER_TOTAL_MISMATCH/i.test(message)) return conflict('ORDER_INTEGRITY', message);
  if (/INVENTORY_CONSTRAINT|INVENTORY_VERSION|reserved_within_on_hand/i.test(message)) {
    return conflict('STOCK_CONSTRAINT', 'Inventory constraint rejected the move');
  }
  if (code === '23505') return conflict('DUPLICATE', 'A record with this identity already exists');
  if (code === '23503') return conflict('REFERENCE_CONFLICT', 'Referenced record does not exist');
  if (code === '23514') return conflict('CONSTRAINT', 'A data integrity rule rejected this change');
  if (code === '23502') return new DomainError(400, 'REQUIRED_FIELD', 'A required field is missing');
  if (code === '22P02' || code === '22007' || code === '22003') {
    return new DomainError(400, 'INVALID_VALUE', 'A field has an invalid format');
  }
  if (code === '57014') return new DomainError(503, 'TIMEOUT', 'The operation timed out; retry');
  return error;
}

type EventBuffer = { events: DomainEvent[] };
const eventContext = new AsyncLocalStorage<EventBuffer>();
type TransactionContext = { client: Client; buffer: EventBuffer };
const transactionContext = new AsyncLocalStorage<TransactionContext>();

/**
 * Run one unit of work in a transaction, publishing events only on commit.
 *
 * Nested calls are re-entrant: a service method can call another service method
 * without opening a second connection. The outermost transaction owns COMMIT,
 * and every buffered event is published exactly once afterwards. This is what
 * lets the API add idempotency on top of domain services that are themselves
 * transactional, with no risk of a partially committed business effect.
 */
export async function tx<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const active = transactionContext.getStore();
  if (active) return fn(active.client);

  const client = await db.connect();
  const buffer: EventBuffer = { events: [] };
  try {
    await client.query('BEGIN');
    const result = await eventContext.run(buffer, () =>
      transactionContext.run({ client, buffer }, () => fn(client)),
    );
    await client.query('COMMIT');
    for (const event of buffer.events) publishEvent(event);
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already failed */
    }
    throw normalizeDbError(error);
  } finally {
    client.release();
  }
}

export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  try {
    return (await db.query(sql, params)).rows as T[];
  } catch (error) {
    throw normalizeDbError(error);
  }
}

export async function maybeOne<T = any>(c: Queryable, sql: string, params: any[] = []): Promise<T | null> {
  const result = await c.query(sql, params);
  return (result.rows[0] as T) ?? null;
}

export async function one<T = any>(c: Queryable, sql: string, params: any[] = []): Promise<T> {
  const row = await maybeOne<T>(c, sql, params);
  if (row === null || row === undefined) fail(404, 'NOT_FOUND', 'Record not found');
  return row as T;
}

export async function many<T = any>(c: Queryable, sql: string, params: any[] = []): Promise<T[]> {
  return (await c.query(sql, params)).rows as T[];
}

export const uid = (): string => randomUUID();
export const token = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const hashJson = (value: unknown): string => hash(canonicalJson(value));

export function canonicalJson(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  return (
    '{' +
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key]))
      .join(',') +
    '}'
  );
}

// --------------------------------------------------------------- encryption --
// AES-256-GCM with a key id prefix so keys can be rotated without a flag day.
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.masterKey, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [config.keyId, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

export function decrypt(value: string): string {
  const [, iv, tag, data] = value.split('.');
  const decipher = createDecipheriv('aes-256-gcm', config.masterKey, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

// ------------------------------------------------------------ command keys --
/**
 * Idempotent command. A key is bound to the canonical hash of the request; the
 * first successful response is replayed for every retry. A different body with
 * the same key is rejected, never silently applied.
 */
export async function command<T>(
  c: Client,
  scope: string,
  key: string,
  input: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [scope + ':' + key]);
  const bodyHash = hashJson(input);
  const inserted = await c.query(
    `INSERT INTO idempotency_keys(scope, key, request_hash) VALUES($1,$2,$3)
     ON CONFLICT DO NOTHING RETURNING scope`,
    [scope, key, bodyHash],
  );
  if (inserted.rowCount === 0) {
    const previous = await one(c, 'SELECT * FROM idempotency_keys WHERE scope=$1 AND key=$2', [scope, key]);
    if (previous.request_hash !== bodyHash) {
      fail(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with a different request body');
    }
    if (!previous.response) fail(409, 'COMMAND_IN_PROGRESS', 'This command is still in progress; retry shortly');
    return previous.response as T;
  }
  const response = await fn();
  await c.query(
    'UPDATE idempotency_keys SET response=$3, status_code=200, completed_at=now() WHERE scope=$1 AND key=$2',
    [scope, key, JSON.stringify(response)],
  );
  return response;
}

// -------------------------------------------------------------------- audit --
export async function audit(
  c: Client,
  actor: Actor,
  action: string,
  entityType: string,
  entityId: string,
  before: unknown = null,
  after: unknown = null,
  ip?: string | null,
): Promise<number> {
  // Serialize the chain so two writers can never both read the same tail.
  await c.query('SELECT pg_advisory_xact_lock(742001)');
  const tail = await c.query('SELECT entry_hash FROM audit_logs ORDER BY seq DESC LIMIT 1');
  const previous_hash = tail.rows[0]?.entry_hash || 'genesis';
  const created_at = new Date().toISOString();
  const payload = {
    actor_id: actor.id,
    actor_type: actor.type || 'user',
    actor_ip: ip ?? actor.ip ?? null,
    action,
    entity_type: entityType,
    entity_id: entityId,
    before_data: before,
    after_data: after,
    request_id: actor.requestId,
    previous_hash,
    created_at,
  };
  const entry_hash = hashJson(payload);
  const inserted = await c.query(
    `INSERT INTO audit_logs(id, actor_id, actor_type, actor_ip, action, entity_type, entity_id,
       before_data, after_data, request_id, previous_hash, entry_hash, created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING seq`,
    [
      uid(),
      actor.id,
      actor.type || 'user',
      ip ?? actor.ip ?? null,
      action,
      entityType,
      entityId,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      actor.requestId,
      previous_hash,
      entry_hash,
      created_at,
    ],
  );
  return inserted.rows[0].seq;
}

/** Walk the chain and recompute every hash. O(n) but runnable at any time. */
export async function verifyAudit(): Promise<{
  valid: boolean;
  entries: number;
  head: string | null;
  broken_at?: number;
  reason?: string;
}> {
  let previous = 'genesis';
  let count = 0;
  let after = 0;
  let head: string | null = null;
  for (;;) {
    const page = await db.query('SELECT * FROM audit_logs WHERE seq > $1 ORDER BY seq LIMIT 500', [after]);
    if (!page.rows.length) break;
    for (const row of page.rows as any[]) {
      const payload = {
        actor_id: row.actor_id,
        actor_type: row.actor_type,
        actor_ip: row.actor_ip,
        action: row.action,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        before_data: row.before_data,
        after_data: row.after_data,
        request_id: row.request_id,
        previous_hash: row.previous_hash,
        created_at: new Date(row.created_at).toISOString(),
      };
      if (row.previous_hash !== previous) {
        return { valid: false, entries: count, head, broken_at: Number(row.seq), reason: 'previous_hash mismatch' };
      }
      if (hashJson(payload) !== row.entry_hash) {
        return { valid: false, entries: count, head, broken_at: Number(row.seq), reason: 'entry_hash mismatch' };
      }
      previous = row.entry_hash;
      head = row.entry_hash;
      count += 1;
      after = Number(row.seq);
    }
    if (page.rows.length < 500) break;
  }
  return { valid: true, entries: count, head };
}

// ------------------------------------------------------------------ outbox --
export async function emit(
  c: Client,
  input: {
    topic: string;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
    headers?: Record<string, unknown>;
  },
): Promise<DomainEvent> {
  const id = uid();
  const inserted = await c.query(
    `INSERT INTO outbox(id, topic, aggregate_type, aggregate_id, payload, headers)
     VALUES($1,$2,$3,$4,$5,$6) RETURNING seq, created_at`,
    [id, input.topic, input.aggregateType, input.aggregateId, JSON.stringify(input.payload), JSON.stringify(input.headers || {})],
  );
  const createdAt = new Date(inserted.rows[0].created_at).toISOString();
  const event: DomainEvent = {
    seq: Number(inserted.rows[0].seq),
    id,
    topic: input.topic,
    aggregate_type: input.aggregateType,
    aggregate_id: input.aggregateId,
    payload: input.payload,
    headers: input.headers || {},
    created_at: createdAt,
  };
  const buffer = eventContext.getStore();
  if (buffer) buffer.events.push(event);
  else publishEvent(event);
  return event;
}

// -------------------------------------------------------------- exceptions --
export async function exception(
  c: Client,
  input: {
    kind: string;
    severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    entityType: string;
    entityId: string;
    message: string;
    details?: unknown;
    replayable?: boolean;
  },
): Promise<string> {
  const existing = await maybeOne<{ id: string }>(
    c,
    `SELECT id FROM exceptions WHERE kind=$1 AND entity_id=$2 AND status='OPEN'`,
    [input.kind, input.entityId],
  );
  if (existing) {
    await c.query(
      `UPDATE exceptions SET occurrences = occurrences + 1, message=$2, details=$3, updated_at=now() WHERE id=$1`,
      [existing.id, input.message, JSON.stringify(input.details ?? {})],
    );
    return existing.id;
  }
  const id = uid();
  await c.query(
    `INSERT INTO exceptions(id, kind, severity, entity_type, entity_id, message, details, replayable)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      input.kind,
      input.severity ?? 'MEDIUM',
      input.entityType,
      input.entityId,
      input.message,
      JSON.stringify(input.details ?? {}),
      input.replayable ?? false,
    ],
  );
  await emit(c, {
    topic: 'exception.created',
    aggregateType: 'exception',
    aggregateId: id,
    payload: { kind: input.kind, severity: input.severity ?? 'MEDIUM', entity_type: input.entityType, entity_id: input.entityId, message: input.message },
  });
  return id;
}

export async function resolveException(
  c: Client,
  id: string,
  actor: Actor,
  note: string,
): Promise<void> {
  const row = await one(c, 'SELECT * FROM exceptions WHERE id=$1 FOR UPDATE', [id]);
  if (row.status !== 'OPEN') fail(409, 'ALREADY_RESOLVED', 'Exception is already closed');
  await c.query(
    `UPDATE exceptions SET status='RESOLVED', resolved_by=$2, resolved_at=now(), resolution=$3, updated_at=now()
     WHERE id=$1`,
    [id, actor.id, note],
  );
  await audit(c, actor, 'exception.resolved', 'exception', id, row, { resolution: note });
}

// ----------------------------------------------------------- stock movements --
export async function ensureInventory(c: Client, sku: string, location: string): Promise<void> {
  await c.query(
    `INSERT INTO inventory(sku, location) VALUES($1,$2) ON CONFLICT (sku, location) DO NOTHING`,
    [sku, location],
  );
}

/**
 * Apply a ledger-backed stock move. The row lock plus the unique request key
 * make this safe to retry: a replayed key returns the current position without
 * applying the delta twice.
 */
export async function stockMove(
  c: Client,
  actor: Actor,
  move: {
    sku: string;
    location: string;
    onHand?: number;
    reserved?: number;
    damaged?: number;
    reason: string;
    reference: string;
    requestKey: string;
  },
): Promise<any> {
  const deltaOnHand = move.onHand ?? 0;
  const deltaReserved = move.reserved ?? 0;
  const deltaDamaged = move.damaged ?? 0;
  await ensureInventory(c, move.sku, move.location);
  const current = await one<any>(
    c,
    'SELECT * FROM inventory WHERE sku=$1 AND location=$2 FOR UPDATE',
    [move.sku, move.location],
  );
  const replay = await maybeOne(c, 'SELECT id FROM stock_ledger WHERE request_key=$1', [move.requestKey]);
  if (replay) return current;

  const onHand = Number(current.on_hand) + deltaOnHand;
  const reserved = Number(current.reserved) + deltaReserved;
  const damaged = Number(current.damaged) + deltaDamaged;
  if (onHand < 0) fail(409, 'INSUFFICIENT_STOCK', `${move.sku} at ${move.location}: on-hand would become negative`);
  if (reserved < 0) fail(409, 'STOCK_CONSTRAINT', `${move.sku} at ${move.location}: reservation would become negative`);
  if (reserved + damaged > onHand) {
    fail(409, 'STOCK_CONSTRAINT', `${move.sku} at ${move.location}: reserved + damaged exceeds on-hand`);
  }
  const updated = await one<any>(
    c,
    `UPDATE inventory SET on_hand=$3, reserved=$4, damaged=$5, version=version+1
     WHERE sku=$1 AND location=$2 RETURNING *`,
    [move.sku, move.location, onHand, reserved, damaged],
  );
  await c.query(
    `INSERT INTO stock_ledger(sku, location, delta_on_hand, delta_reserved, delta_damaged, reason,
       reference, actor_id, request_key, balance_on_hand, balance_reserved, balance_damaged)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      move.sku,
      move.location,
      deltaOnHand,
      deltaReserved,
      deltaDamaged,
      move.reason,
      move.reference,
      actor.id,
      move.requestKey,
      onHand,
      reserved,
      damaged,
    ],
  );
  return updated;
}

/** Transaction-local identity consumed by the state machine triggers. */
export async function setActorContext(c: Client, actor: Actor, reason?: string): Promise<void> {
  await c.query('SELECT set_config($1,$2,true), set_config($3,$4,true)', [
    'yesi.actor_id',
    actor.id,
    'yesi.reason',
    reason ?? '',
  ]);
}

// ------------------------------------------------------- connector telemetry --
export async function recordProviderOperation(
  c: Client,
  input: {
    connectionId: string;
    provider: string;
    operation: string;
    direction: 'IN' | 'OUT';
    idempotencyKey: string;
    request?: unknown;
    response?: unknown;
    httpStatus?: number;
    status: 'PENDING' | 'OK' | 'FAILED' | 'SKIPPED';
    latencyMs?: number;
    error?: string;
  },
): Promise<string> {
  const id = uid();
  const result = await c.query(
    `INSERT INTO provider_operations(id, connection_id, provider, operation, direction, idempotency_key,
       request, response, http_status, status, attempts, latency_ms, error, finished_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,$13)
     ON CONFLICT (connection_id, operation, idempotency_key) DO UPDATE
       SET attempts = provider_operations.attempts + 1,
           status = EXCLUDED.status,
           response = EXCLUDED.response,
           http_status = EXCLUDED.http_status,
           latency_ms = EXCLUDED.latency_ms,
           error = EXCLUDED.error,
           finished_at = EXCLUDED.finished_at
     RETURNING id`,
    [
      id,
      input.connectionId,
      input.provider,
      input.operation,
      input.direction,
      input.idempotencyKey,
      input.request === undefined ? null : JSON.stringify(input.request),
      input.response === undefined ? null : JSON.stringify(input.response),
      input.httpStatus ?? null,
      input.status,
      input.latencyMs ?? null,
      input.error ?? null,
      input.status === 'PENDING' ? null : new Date().toISOString(),
    ],
  );
  return result.rows[0].id;
}

export async function getFlag<T = unknown>(c: Queryable, key: string, fallback: T): Promise<T> {
  const row = await maybeOne<{ value: T }>(c, 'SELECT value FROM platform_flags WHERE key=$1', [key]);
  return row ? row.value : fallback;
}

export async function setFlag(c: Client, key: string, value: unknown, actor: Actor): Promise<void> {
  await c.query(
    `INSERT INTO platform_flags(key, value, updated_by) VALUES($1,$2,$3)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [key, JSON.stringify(value), actor.id],
  );
  await audit(c, actor, 'platform.flag_set', 'flag', key, null, { value });
}

export async function insertReconciliationRun(run: {
  kind: 'inventory' | 'finance' | 'reservations' | 'connectors';
  status: 'OK' | 'DRIFT';
  findings: number;
  details: unknown;
  durationMs: number;
}): Promise<void> {
  await db.query(
    `INSERT INTO reconciliation_runs(id, kind, status, findings, details, finished_at, duration_ms)
     VALUES($1,$2,$3,$4,$5,now(),$6)`,
    [uid(), run.kind, run.status, run.findings, JSON.stringify(run.details), run.durationMs],
  );
}

/**
 * Idempotent command for work that performs external effects and therefore must
 * not hold a database transaction open. The key is claimed in a short
 * transaction; the response is stored afterwards. A worker crash between the
 * two leaves an in-progress claim that is retryable after two minutes (every
 * connector call itself carries a stable idempotency key).
 */
export async function commandStandalone<T>(
  scope: string,
  key: string,
  input: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const bodyHash = hashJson(input);
  const claim = await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [scope + ':' + key]);
    const inserted = await c.query(
      `INSERT INTO idempotency_keys(scope, key, request_hash) VALUES($1,$2,$3)
       ON CONFLICT DO NOTHING RETURNING created_at`,
      [scope, key, bodyHash],
    );
    if (inserted.rowCount) return { fresh: true as const };
    const previous = await one<any>(c, 'SELECT * FROM idempotency_keys WHERE scope=$1 AND key=$2 FOR UPDATE', [scope, key]);
    if (previous.request_hash !== bodyHash) {
      fail(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with a different request body');
    }
    if (previous.response) return { fresh: false as const, response: previous.response as T };
    const ageMs = Date.now() - new Date(previous.created_at).getTime();
    if (ageMs < 120_000) fail(409, 'COMMAND_IN_PROGRESS', 'This command is still in progress; retry shortly');
    await c.query('DELETE FROM idempotency_keys WHERE scope=$1 AND key=$2', [scope, key]);
    await c.query('INSERT INTO idempotency_keys(scope, key, request_hash) VALUES($1,$2,$3)', [scope, key, bodyHash]);
    return { fresh: true as const };
  });
  if (!claim.fresh) return claim.response;
  const response = await fn();
  await tx((c) =>
    c.query('UPDATE idempotency_keys SET response=$3, status_code=200, completed_at=now() WHERE scope=$1 AND key=$2', [
      scope,
      key,
      JSON.stringify(response),
    ]),
  );
  return response;
}
