import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  audit,
  db,
  emit,
  fail,
  hash,
  many,
  maybeOne,
  one,
  pool,
  setFlag,
  tx,
} from '../db/index.js';
import { guard, mutation, type RouteDoc } from './shared.js';
import { SESSION, issueWsTicket } from '../auth.js';
import { can, config, permissions, type Permission } from '../config.js';
import {
  auditStatus,
  kpis,
  listAudit,
  listExceptions,
  listOutbox,
  outboxTopics,
  reconciliationReport,
  snapshot,
} from '../read-models.js';
import { latestReconciliation, runReconciliation } from '../reconcile.js';
import { replayDeadEvent, workerHealth } from '../worker.js';
import { eventVisible } from '../realtime.js';
import { listJournals, financeSummary } from '../domain/finance.js';
import { replayRawEvent } from '../integrations/ingestion.js';

const uuid = z.uuid();

export function registerPlatformRoutes(app: FastifyInstance, docs: RouteDoc[]) {
  app.get('/api/v1/auth/me', { preHandler: guard('read') }, async (req) => {
    const plaintext = req.cookies[SESSION];
    const session = await one<any>(
      pool,
      'SELECT csrf, expires_at, created_at FROM sessions WHERE token_hash=$1',
      [hash(plaintext!)],
    );
    return {
      ...req.actor,
      csrf: session.csrf,
      expires_at: session.expires_at,
      session_started_at: session.created_at,
      permissions: (Object.keys(permissions) as Permission[]).filter((permission) => can(req.actor!.role, permission)),
      environment: config.env,
      connector_mode: config.connectorMode,
    };
  });

  mutation(app, docs, {
    path: '/api/v1/reconciliation/run',
    permission: 'finance',
    schema: z.object({}).strict(),
    description: 'Run the integrity sweep now: ledger vs inventory, reservations, finance, connectors',
    transactional: false,
    handler: async ({ actor }) => {
      const result = await runReconciliation();
      await tx((c) =>
        audit(c, actor, 'reconciliation.triggered', 'platform', 'periodic', null, result as Record<string, unknown>),
      );
      return result;
    },
  });

  mutation(app, docs, {
    path: '/api/v1/auth/ticket',
    permission: 'read',
    schema: z.object({}).strict(),
    description: 'Issue a single-use 30 second ticket for the realtime WebSocket',
    handler: ({ actor }) => issueWsTicket(actor.id),
  });

  app.get('/api/v1/control-tower/kpis', { preHandler: guard('read') }, async () => kpis());

  app.get('/api/v1/snapshot', { preHandler: guard('read') }, async () => snapshot());

  app.get('/api/v1/platform/status', { preHandler: guard('read') }, async () => {
    const [worker, audit, topics, connectors, reconciliation, flags] = await Promise.all([
      workerHealth(),
      auditStatus(),
      outboxTopics(),
      many(db, 'SELECT * FROM v_connector_health ORDER BY provider, name'),
      latestReconciliation(),
      many(db, 'SELECT key, value, updated_at FROM platform_flags ORDER BY key'),
    ]);
    return {
      environment: config.env,
      mode: config.connectorMode,
      live_connectors: config.allowLiveConnectors,
      worker,
      audit,
      outbox_topics: topics,
      connectors,
      reconciliation_runs: reconciliation,
      flags,
      uptime_seconds: Math.round(process.uptime()),
      version: '1.0.0',
    };
  });

  app.get('/api/v1/events', { preHandler: guard('read') }, async (req) => {
    const q = z
      .object({
        after: z.coerce.number().int().nonnegative().default(0),
        limit: z.coerce.number().int().min(1).max(500).default(200),
        topic: z.string().max(80).optional(),
      })
      .parse(req.query);
    const rows = await many(
      db,
      `SELECT seq, id, topic, aggregate_type, aggregate_id, payload, created_at
       FROM outbox WHERE seq > $1 ${q.topic ? 'AND topic=$3' : ''}
       ORDER BY seq LIMIT $2`,
      q.topic ? [q.after, q.limit, q.topic] : [q.after, q.limit],
    );
    const items = rows.filter((row) => eventVisible(row.topic, req.actor!.role));
    return { items, sequence: items.length ? Number(items[items.length - 1].seq) : q.after };
  });

  // ------------------------------------------------------------- governance --
  app.get('/api/v1/audit', { preHandler: guard('audit') }, async (req) => {
    const q = z
      .object({
        after: z.coerce.number().int().nonnegative().default(0),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    return { items: await listAudit(q.after, q.limit) };
  });

  app.get('/api/v1/audit/verify', { preHandler: guard('audit') }, async (req) => {
    const q = z.object({ force: z.coerce.boolean().default(false) }).parse(req.query);
    return auditStatus(q.force);
  });

  app.get('/api/v1/outbox', { preHandler: guard('replay') }, async (req) => {
    const q = z
      .object({
        status: z.enum(['PENDING', 'PROCESSING', 'DONE', 'DEAD']).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .parse(req.query);
    return { items: await listOutbox(q.status, q.limit), topics: await outboxTopics(), ...(await workerHealth()) };
  });

  mutation(app, docs, {
    path: '/api/v1/outbox/:id/replay',
    permission: 'replay',
    schema: z.object({ reason: z.string().min(5).max(300) }).strict(),
    description: 'Replay a dead-letter event after the root cause is fixed',
    handler: ({ actor, id, body }) => replayDeadEvent(actor, uuid.parse(id), body.reason),
  });

  // ------------------------------------------------------------- exceptions --
  app.get('/api/v1/exceptions', { preHandler: guard('read') }, async (req) => {
    const q = z.object({ status: z.enum(['OPEN', 'RESOLVED', 'IGNORED', '']).default('OPEN') }).parse(req.query);
    return { items: await listExceptions(q.status) };
  });

  mutation(app, docs, {
    path: '/api/v1/exceptions/:id/resolve',
    permission: 'supervise',
    schema: z.object({ note: z.string().min(3).max(500) }).strict(),
    handler: async ({ client, actor, id, body }) => {
      const row = await one<any>(client, 'SELECT * FROM exceptions WHERE id=$1 FOR UPDATE', [uuid.parse(id)]);
      if (row.status !== 'OPEN') fail(409, 'ALREADY_RESOLVED', 'Exception is already closed');
      if (row.kind === 'OUTBOX_DEAD') {
        fail(409, 'REPLAY_REQUIRED', 'Dead events must be replayed to prove the fix, then the exception closes automatically');
      }
      await client.query(
        `UPDATE exceptions SET status='RESOLVED', resolved_by=$2, resolved_at=now(), resolution=$3, updated_at=now()
         WHERE id=$1`,
        [row.id, actor.id, body.note],
      );
      await audit(client, actor, 'exception.resolved', 'exception', row.id, row, { resolution: body.note });
      return { resolved: true };
    },
  });

  mutation(app, docs, {
    path: '/api/v1/exceptions/:id/retry',
    permission: 'replay',
    schema: z.object({}).strict(),
    description: 'Re-run the underlying operation for a replayable exception',
    handler: async ({ client, actor, id }) => {
      const row = await one<any>(client, 'SELECT * FROM exceptions WHERE id=$1 FOR UPDATE', [uuid.parse(id)]);
      if (row.status !== 'OPEN') fail(409, 'ALREADY_RESOLVED', 'Exception is already closed');
      if (row.entity_type === 'raw_event') {
        return replayRawEvent(actor, row.entity_id);
      }
      if (row.kind === 'OUTBOX_DEAD') {
        return replayDeadEvent(actor, row.entity_id, `retry from exception ${row.id}`);
      }
      if (row.kind === 'ERP_POSTING_STALE') {
        const posting = await one<any>(client, 'SELECT * FROM erp_postings WHERE id=$1 FOR UPDATE', [row.entity_id]);
        await client.query(
          `UPDATE erp_postings SET status='PENDING', attempts=0, last_error=NULL WHERE id=$1`,
          [posting.id],
        );
        await emit(client, {
          topic: 'erp.post',
          aggregateType: 'order',
          aggregateId: posting.order_id,
          payload: { order_id: posting.order_id, posting_id: posting.id, retry: true },
        });
        await client.query(
          `UPDATE exceptions SET status='RESOLVED', resolved_by=$2, resolved_at=now(), resolution='ERP posting requeued'
           WHERE id=$1`,
          [row.id, actor.id],
        );
        return { requeued: true };
      }
      if (row.kind === 'CONNECTOR_SYNC_FAILED' || row.kind === 'CONNECTOR_STALE') {
        const connection = await maybeOne<any>(client, 'SELECT * FROM connections WHERE id=$1', [row.entity_id]);
        if (!connection) fail(409, 'CONNECTION_MISSING', 'The connector no longer exists');
        // External calls are the worker's job: queue a durable pull request.
        await emit(client, {
          topic: 'connector.pull',
          aggregateType: 'connection',
          aggregateId: connection.id,
          payload: { connection_id: connection.id, provider: connection.provider, trigger: 'retry' },
        });
        await client.query(
          `UPDATE exceptions SET status='RESOLVED', resolved_by=$2, resolved_at=now(), resolution='pull requeued'
           WHERE id=$1`,
          [row.id, actor.id],
        );
        return { queued: true };
      }
      if (row.kind === 'COUNT_VARIANCE') {
        fail(409, 'APPROVAL_REQUIRED', `Use POST /api/v1/stock-counts/${row.entity_id}/approve to apply the variance`);
      }
      fail(409, 'RETRY_UNSUPPORTED', 'This exception has no automated retry; resolve it manually after review');
    },
  });

  // ---------------------------------------------------------------- finance --
  app.get('/api/v1/finance/journals', { preHandler: guard('finance') }, async () => ({
    items: await listJournals(),
    summary: await financeSummary(),
  }));

  app.get('/api/v1/reconciliation', { preHandler: guard('finance') }, async () => reconciliationReport());

  // ---------------------------------------------------------------- control --
  mutation(app, docs, {
    path: '/api/v1/platform/autopilot',
    permission: 'admin',
    schema: z.object({ enabled: z.boolean() }).strict(),
    description: 'Pause or resume the sandbox autopilot (development only)',
    handler: async ({ client, actor, body }) => {
      if (!config.development) fail(403, 'PRODUCTION_FORBIDDEN', 'Autopilot is a sandbox-only facility');
      await setFlag(client, 'autopilot', body.enabled, actor);
      return { autopilot: body.enabled };
    },
  });

  mutation(app, docs, {
    path: '/api/v1/platform/connections/:id/resume',
    permission: 'integrate',
    schema: z.object({}).strict(),
    handler: async ({ client, actor, id }) => {
      const connectionId = uuid.parse(id);
      const row = await one<any>(client, 'SELECT * FROM connections WHERE id=$1 FOR UPDATE', [connectionId]);
      await client.query(`UPDATE connections SET status='enabled', last_error=NULL, version=version+1 WHERE id=$1`, [connectionId]);
      await audit(client, actor, 'connector.resumed', 'connection', connectionId, row, { status: 'enabled' });
      return { id: connectionId, status: 'enabled' };
    },
  });
}
