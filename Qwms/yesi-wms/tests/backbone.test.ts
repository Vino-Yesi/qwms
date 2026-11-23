/**
 * Integration proof for the backbone: the guarantees the platform is sold on.
 *
 * Runs the real Fastify app against a throwaway PGlite database, with real
 * migrations, the real seed, real HMAC webhooks and the SQL state machine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/api/index.js';
import { migrate } from '../server/migrate.js';
import { seedDatabase } from '../server/seed.js';
import { db, query, tx } from '../server/db/index.js';

let app: FastifyInstance;
let closeApp: () => Promise<void>;
let cookie = '';
let csrf = '';
const SECRET = 'vitest-webhook-secret-0123456789abcdef';

type Inject = { statusCode: number; body: any; headers: Record<string, any> };

async function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
  options: { auth?: boolean; csrf?: boolean; key?: string; headers?: Record<string, string> } = {},
): Promise<Inject> {
  const headers: Record<string, string> = { ...(options.headers || {}) };
  if (options.auth !== false && cookie) headers.cookie = cookie;
  if (method !== 'GET' && options.csrf !== false) {
    headers['x-csrf-token'] = csrf;
  }
  if (method !== 'GET') headers['idempotency-key'] = options.key || crypto.randomUUID();
  const response = await app.inject({ method, url, headers, payload: payload as any });
  let body: any;
  try {
    body = response.body ? JSON.parse(response.body) : null;
  } catch {
    body = response.body;
  }
  return { statusCode: response.statusCode, body, headers: response.headers as any };
}

async function authenticate() {
  const login = await call('POST', '/api/v1/auth/login', { email: 'admin@yesi.local', password: 'Yesi!Demo2026' }, { auth: false });
  expect(login.statusCode).toBe(200);
  cookie = String(login.headers['set-cookie']).split(';')[0];
  csrf = login.body.csrf;
  const demo = await call('GET', '/api/v1/auth/demo-code');
  expect(demo.statusCode).toBe(200);
  const verify = await call('POST', '/api/v1/auth/verify', { code: demo.body.code });
  expect(verify.statusCode).toBe(200);
  csrf = verify.body.csrf;
}

beforeAll(async () => {
  await migrate(false);
  const seeded = await seedDatabase();
  expect(seeded.seeded).toBe(true);
  const built = await buildApp();
  app = built.app;
  closeApp = built.close;
  await app.ready();
  await authenticate();
});

afterAll(async () => {
  await closeApp?.();
  await db.end();
});

describe('platform', () => {
  it('reports health from both the edge and the versioned API', async () => {
    const edge = await call('GET', '/health', undefined, { auth: false });
    expect(edge.statusCode).toBe(200);
    expect(edge.body.status).toBe('ok');
    const versioned = await call('GET', '/api/v1/health', undefined, { auth: false });
    expect(versioned.statusCode).toBe(200);
  });

  it('rejects unauthenticated reads and CSRF-less mutations', async () => {
    expect((await call('GET', '/api/v1/snapshot', undefined, { auth: false })).statusCode).toBe(401);
    const noCsrf = await call('POST', '/api/v1/orders/00000000-0000-0000-0000-000000000000/reserve', { version: 1 }, { csrf: false });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.body.error.code).toBe('CSRF_REJECTED');
  });

  it('verifies the audit hash chain', async () => {
    const response = await call('GET', '/api/v1/audit/verify?force=true');
    expect(response.statusCode).toBe(200);
    expect(response.body.valid).toBe(true);
    expect(response.body.entries).toBeGreaterThan(50);
  });
});

describe('sql state machine', () => {
  it('refuses an illegal order transition at the database level', async () => {
    const order = await query<{ id: string }>(`SELECT id FROM orders WHERE status='MAPPED' LIMIT 1`);
    expect(order.length).toBe(1);
    await expect(
      db.query(`UPDATE orders SET status='DELIVERED' WHERE id=$1`, [order[0].id]),
    ).rejects.toThrow(/illegal|check_violation/i);
    const unchanged = await query<{ status: string }>('SELECT status FROM orders WHERE id=$1', [order[0].id]);
    expect(unchanged[0].status).toBe('MAPPED');
  });

  it('rolls back a nested transaction as a unit', async () => {
    await expect(
      tx(async (client) => {
        await client.query(`INSERT INTO platform_flags(key, value) VALUES('nested_test', 'true'::jsonb)`);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const rows = await query(`SELECT 1 FROM platform_flags WHERE key='nested_test'`);
    expect(rows.length).toBe(0);
  });

  it('keeps reservations immutable and never deletes them', async () => {
    await expect(db.query('DELETE FROM reservations WHERE true')).rejects.toThrow(/append-only|restrict/i);
  });
});

describe('idempotent order commands', () => {
  it('reserves once and replays the stored response for the same key', async () => {
    const candidates = await query<any>(
      `SELECT o.id, o.version FROM orders o
       WHERE o.status='MAPPED'
         AND NOT EXISTS (
           SELECT 1 FROM order_lines l
           WHERE l.order_id=o.id
             AND (l.sku IS NULL OR coalesce((SELECT sum(i.on_hand - i.reserved - i.damaged) FROM inventory i WHERE i.sku=l.sku),0) < l.quantity)
         )
       ORDER BY o.created_at LIMIT 1`,
    );
    expect(candidates.length).toBe(1);
    const { id, version } = candidates[0];
    const key = crypto.randomUUID();

    const first = await call('POST', `/api/v1/orders/${id}/reserve`, { version: Number(version) }, { key });
    expect(first.statusCode).toBe(200);
    expect(first.body.status).toBe('RESERVED');

    const replay = await call('POST', `/api/v1/orders/${id}/reserve`, { version: Number(version) }, { key });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toEqual(first.body);

    const conflicting = await call('POST', `/api/v1/orders/${id}/reserve`, { version: Number(version) + 1 }, { key });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.body.error.code).toBe('IDEMPOTENCY_CONFLICT');

    const active = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM reservations r
       JOIN order_lines l ON l.id=r.order_line_id
       WHERE l.order_id=$1 AND r.status='ACTIVE'`,
      [id],
    );
    const expected = await query<{ n: number }>(`SELECT count(*)::int AS n FROM order_lines WHERE order_id=$1`, [id]);
    expect(active[0].n).toBe(expected[0].n);
  });

  it('rejects a stale version with a conflict, not a silent overwrite', async () => {
    const order = await query<any>(`SELECT id, version FROM orders WHERE status='RESERVED' LIMIT 1`);
    const response = await call('POST', `/api/v1/orders/${order[0].id}/ready`, { version: 999 });
    expect([409, 422]).toContain(response.statusCode);
  });
});

describe('signed marketplace ingress', () => {
  it('accepts a signed webhook once, dedupes the replay and rejects bad signatures', async () => {
    const connections = await call('GET', '/api/v1/integrations');
    const connection = connections.body.items.find((row: any) => row.provider === 'ozon');
    const rotate = await call('POST', `/api/v1/integrations/${connection.id}/rotate-secret`, { webhook_secret: SECRET });
    expect(rotate.statusCode).toBe(200);

    const samples = await call('GET', `/api/v1/integrations/${connection.id}/samples`);
    const payload = JSON.stringify(samples.body.samples.normal);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = 'sha256=' + createHmac('sha256', SECRET).update(`${timestamp}.${payload}`).digest('hex');
    const eventId = `vitest-${Date.now()}`;
    const send = (signatureValue: string, timestampValue: string, id: string) =>
      app
        .inject({
          method: 'POST',
          url: `/api/v1/integrations/${connection.id}/webhooks`,
          headers: {
            'content-type': 'application/json',
            'x-yesi-timestamp': timestampValue,
            'x-yesi-signature': signatureValue,
            'x-yesi-event-id': id,
          },
          payload,
        })
        .then(async (response) => ({ statusCode: response.statusCode, body: JSON.parse(response.body) }));

    const accepted = await send(signature, timestamp, eventId);
    expect(accepted.statusCode).toBe(202);
    expect(accepted.body.accepted).toBe(true);
    expect(accepted.body.duplicate).toBe(false);

    const duplicate = await send(signature, timestamp, eventId);
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.body.duplicate).toBe(true);

    const tampered = await send('sha256=' + '0'.repeat(64), timestamp, `${eventId}-bad`);
    expect(tampered.statusCode).toBe(401);
    expect(tampered.body.error.code).toBe('INVALID_SIGNATURE');

    const stale = String(Math.floor(Date.now() / 1000) - 7200);
    const staleSignature = 'sha256=' + createHmac('sha256', SECRET).update(`${stale}.${payload}`).digest('hex');
    const expired = await send(staleSignature, stale, `${eventId}-stale`);
    expect(expired.statusCode).toBe(401);
  });

  it('processed the webhook through to a normalised order', async () => {
    const rows = await query<{ n: number }>(`SELECT count(*)::int AS n FROM raw_events WHERE status='PROCESSED'`);
    expect(rows[0].n).toBeGreaterThan(0);
  });
});

describe('reconciliation', () => {
  it('proves the ledger, reservations and journals are balanced', async () => {
    const response = await call('GET', '/api/v1/reconciliation');
    expect(response.statusCode).toBe(200);
    expect(response.body.ledger_drift).toEqual([]);
    expect(response.body.reservation_drift).toEqual([]);
    expect(response.body.missing_journals).toEqual([]);
    expect(response.body.balanced).toBe(true);
  });

  it('runs a sweep through the API and records the result', async () => {
    const response = await call('POST', '/api/v1/reconciliation/run', {});
    expect(response.statusCode).toBe(200);
    const runs = await query<{ n: number }>(`SELECT count(*)::int AS n FROM reconciliation_runs`);
    expect(runs[0].n).toBeGreaterThan(0);
  });
});
