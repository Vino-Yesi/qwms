/**
 * Durable worker.
 *
 * The outbox is the queue: at-least-once delivery, exponential retry, dead
 * letter after max attempts, and an inbox table that makes effects exactly-once.
 * Every outbound call carries a stable idempotency key, so even the unavoidable
 * crash-after-call window is safe to retry.
 */
import { audit, db, exception, fail, maybeOne, one, query, tx } from './db/index.js';
import { config, SYSTEM_ACTOR, type Actor } from './config.js';
import type { DomainEvent } from './bus.js';
import { processRawEvent } from './integrations/ingestion.js';
import { confirmShipmentWithMarketplace, pushOrderStatus, pushStockForSkus, runPull } from './integrations/hub.js';
import type { ConnectionRow } from './integrations/ingestion.js';
import { bookTransport } from './integrations/outbound.js';
import { applyBookingResult } from './domain/fulfillment.js';
import { markErpPostingAck, markErpPostingFailed } from './domain/finance.js';
import { postToErp } from './integrations/outbound.js';
import { metrics } from './metrics.js';
import { runReconciliation } from './reconcile.js';
import { autopilotTick } from './simulation.js';

const WORKER_ID = `${process.env.HOSTNAME || 'node'}:${process.pid}:${Math.random().toString(36).slice(2, 7)}`;
const CONSUMER = (topic: string) => `worker:${topic}`;

const SYNC_STATUSES = new Set(['PACKED', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'CANCELLED']);

async function connectionsFor(provider?: string): Promise<ConnectionRow[]> {
  const rows = await query<any>(
    `SELECT * FROM connections WHERE status='enabled' ${provider ? 'AND provider=$1' : ''} ORDER BY provider`,
    provider ? [provider] : [],
  );
  return rows.map((row) => row as ConnectionRow);
}

async function connectionById(id: string): Promise<ConnectionRow | null> {
  return maybeOne<ConnectionRow>(db, 'SELECT * FROM connections WHERE id=$1', [id]);
}

/** Push a status change to the marketplace that owns the order. */
async function pushStatusForOrder(orderId: string, actor: Actor): Promise<void> {
  const order = await maybeOne<any>(
    db,
    `SELECT o.*, c.status AS connection_status FROM orders o JOIN connections c ON c.id=o.connection_id WHERE o.id=$1`,
    [orderId],
  );
  if (!order || order.connection_status !== 'enabled') return;
  const connection = await connectionById(order.connection_id);
  if (!connection) return;
  await pushOrderStatus(order, connection, actor);
}

async function handle(event: DomainEvent): Promise<void> {
  const actor: Actor = { ...SYSTEM_ACTOR, requestId: event.id };
  const payload = event.payload as any;

  switch (event.topic) {
    case 'connector.ingest': {
      await processRawEvent(String(payload.raw_event_id));
      return;
    }
    case 'connector.pull': {
      const connection = await connectionById(String(payload.connection_id));
      if (!connection || connection.status === 'paused') return;
      await import('./integrations/hub.js').then((hub) => hub.runPull(connection.id, actor, 'manual'));
      return;
    }
    case 'order.created': {
      await pushStatusForOrder(String(payload.order_id), actor);
      return;
    }
    case 'order.updated': {
      if (!SYNC_STATUSES.has(String(payload.status))) return;
      await pushStatusForOrder(String(payload.order_id), actor);
      return;
    }
    case 'inventory.changed': {
      const skus: string[] = payload.skus || [];
      if (!skus.length) return;
      const connections = await connectionsFor();
      const active = [];
      for (const connection of connections) {
        const mapped = await maybeOne(
          db,
          `SELECT 1 FROM sku_mappings WHERE connection_id=$1 AND sku = ANY($2) AND status='APPROVED' LIMIT 1`,
          [connection.id, skus],
        );
        if (mapped) active.push(connection);
      }
      if (active.length) await pushStockForSkus(skus, active, actor);
      return;
    }
    case 'tms.book': {
      const shipment = await one<any>(
        db,
        `SELECT s.*, o.external_id AS order_external_id FROM shipments s JOIN orders o ON o.id=s.order_id WHERE s.id=$1`,
        [payload.shipment_id],
      );
      if (shipment.status !== 'CREATED') return;
      const result = await bookTransport({
        shipmentId: shipment.id,
        orderExternalId: shipment.order_external_id,
        carrier: shipment.carrier,
        service: shipment.service,
        trackingKey: `book:${shipment.id}`,
      });
      await applyBookingResult(shipment.id, result);
      return;
    }
    case 'marketplace.ship': {
      const shipment = await maybeOne<any>(
        db,
        `SELECT s.*, o.external_id, o.connection_id AS order_connection_id, o.status AS order_status
         FROM shipments s JOIN orders o ON o.id=s.order_id WHERE s.id=$1`,
        [payload.shipment_id],
      );
      if (!shipment) return;
      const connection = await connectionById(shipment.order_connection_id);
      if (!connection || connection.status !== 'enabled') return;
      await confirmShipmentWithMarketplace(
        { id: shipment.order_id, external_id: shipment.external_id, status: shipment.order_status },
        shipment,
        connection,
        actor,
      );
      return;
    }
    case 'erp.post': {
      const posting = await maybeOne<any>(db, 'SELECT * FROM erp_postings WHERE id=$1', [payload.posting_id]);
      if (!posting || posting.status === 'ACK') return;
      try {
        const result = await postToErp({ idempotencyKey: posting.idempotency_key, payload: posting.request });
        await tx((c) => markErpPostingAck(c, posting.id, actor, result.response, result.reference));
      } catch (error) {
        await tx((c) => markErpPostingFailed(c, posting.id, (error as Error).message));
        throw error;
      }
      return;
    }
    default:
      return;
  }
}

async function alreadyProcessed(consumer: string, eventId: string): Promise<boolean> {
  const row = await maybeOne(db, 'SELECT 1 FROM inbox WHERE consumer=$1 AND event_id=$2', [consumer, eventId]);
  return Boolean(row);
}

async function complete(event: DomainEvent): Promise<void> {
  await tx(async (c) => {
    await c.query('INSERT INTO inbox(consumer, event_id, topic) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [
      CONSUMER(event.topic),
      event.id,
      event.topic,
    ]);
    await c.query(`UPDATE outbox SET status='DONE', processed_at=now(), last_error=NULL, locked_at=NULL WHERE seq=$1`, [event.seq]);
  });
}

export async function processOnce(): Promise<boolean> {
  const claimed = await tx(async (c) => {
    const result = await c.query(
      `UPDATE outbox SET status='PROCESSING', locked_at=now(), locked_by=$1, attempts=attempts+1
       WHERE seq = (
         SELECT seq FROM outbox
         WHERE (status='PENDING' AND next_attempt_at <= now())
            OR (status='PROCESSING' AND locked_at < now() - interval '2 minutes')
         ORDER BY seq
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [WORKER_ID],
    );
    return result.rows[0] as any;
  });
  if (!claimed) return false;

  const event: DomainEvent = {
    seq: Number(claimed.seq),
    id: claimed.id,
    topic: claimed.topic,
    aggregate_type: claimed.aggregate_type,
    aggregate_id: claimed.aggregate_id,
    payload: claimed.payload,
    headers: claimed.headers,
    created_at: new Date(claimed.created_at).toISOString(),
  };
  try {
    if (await alreadyProcessed(CONSUMER(event.topic), event.id)) {
      await complete(event);
      metrics.processed.inc({ topic: event.topic, outcome: 'deduplicated' });
      return true;
    }
    await handle(event);
    await complete(event);
    metrics.processed.inc({ topic: event.topic, outcome: 'ok' });
  } catch (error) {
    const message = (error as Error).message.slice(0, 800);
    metrics.processed.inc({ topic: event.topic, outcome: 'error' });
    await tx(async (c) => {
      const dead = Number(claimed.attempts) >= Number(claimed.max_attempts);
      const backoffSeconds = Math.min(3600, Math.round(2 ** Math.min(claimed.attempts, 10) * (0.8 + Math.random() * 0.4)));
      await c.query(
        `UPDATE outbox SET status=$2, locked_at=NULL, next_attempt_at=now()+($3 || ' seconds')::interval, last_error=$4
         WHERE seq=$1`,
        [event.seq, dead ? 'DEAD' : 'PENDING', backoffSeconds, message],
      );
      if (dead) {
        await exception(c, {
          kind: 'OUTBOX_DEAD',
          severity: 'CRITICAL',
          entityType: 'event',
          entityId: event.id,
          message: `Event ${event.topic} exhausted ${claimed.attempts} attempts: ${message}`,
          details: { topic: event.topic, seq: event.seq, aggregate_id: event.aggregate_id },
          replayable: true,
        });
        await audit(c, { ...SYSTEM_ACTOR, requestId: event.id }, 'outbox.dead_lettered', 'event', event.id, null, {
          topic: event.topic,
          attempts: claimed.attempts,
          error: message,
        });
      } else {
        await audit(c, { ...SYSTEM_ACTOR, requestId: event.id }, 'outbox.retry_scheduled', 'event', event.id, null, {
          topic: event.topic,
          attempt: claimed.attempts,
          backoff_seconds: backoffSeconds,
          error: message,
        });
      }
    });
    console.error(JSON.stringify({ level: 'error', component: 'worker', topic: event.topic, seq: event.seq, attempt: claimed.attempts, message }));
  }
  return true;
}

export async function replayDeadEvent(actor: Actor, eventId: string, reason: string): Promise<{ ok: true }> {
  return tx(async (c) => {
    const event = await one<any>(c, 'SELECT * FROM outbox WHERE id=$1 FOR UPDATE', [eventId]);
    if (event.status !== 'DEAD') {
      fail(409, 'NOT_DEAD', 'Only dead-letter events can be replayed');
    }
    await c.query(
      `UPDATE outbox SET status='PENDING', attempts=0, next_attempt_at=now(), last_error=NULL, locked_at=NULL WHERE id=$1`,
      [eventId],
    );
    await c.query(
      `UPDATE exceptions SET status='RESOLVED', resolved_by=$2, resolved_at=now(), resolution=$3
       WHERE status='OPEN' AND entity_type='event' AND entity_id=$1`,
      [eventId, actor.id, reason],
    );
    await audit(c, actor, 'outbox.replayed', 'event', eventId, event, { reason });
    return { ok: true } as const;
  });
}

export async function workerHealth(): Promise<{
  pending: number;
  processing: number;
  dead: number;
  oldest_pending_seconds: number | null;
}> {
  const row = await one<{ pending: number; processing: number; dead: number; oldest: number | null }>(
    db,
    `SELECT
       count(*) FILTER (WHERE status='PENDING')::int AS pending,
       count(*) FILTER (WHERE status='PROCESSING')::int AS processing,
       count(*) FILTER (WHERE status='DEAD')::int AS dead,
       extract(epoch FROM now() - min(created_at) FILTER (WHERE status='PENDING'))::int AS oldest
     FROM outbox`,
  );
  return { pending: row.pending, processing: row.processing, dead: row.dead, oldest_pending_seconds: row.oldest };
}

const timers: NodeJS.Timeout[] = [];
let running = false;
let lastReconcile = 0;
let lastPull = 0;
let lastAutopilot = 0;

async function scheduled(): Promise<void> {
  const now = Date.now();
  if (now - lastReconcile > 60_000) {
    lastReconcile = now;
    try {
      await runReconciliation();
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', component: 'reconciliation', message: (error as Error).message }));
    }
  }
  if (now - lastPull > config.pollIntervalMs) {
    lastPull = now;
    const connections = await connectionsFor();
    for (const connection of connections) {
      try {
        await runPull(connection.id, SYSTEM_ACTOR, 'schedule');
      } catch (error) {
        // The failure is already recorded as a connector run and an exception.
        console.error(JSON.stringify({ level: 'warn', component: 'pull', connection: connection.id, message: (error as Error).message }));
      }
    }
  }
  if (config.development && now - lastAutopilot > config.autopilotIntervalMs) {
    lastAutopilot = now;
    try {
      await autopilotTick();
    } catch (error) {
      console.error(JSON.stringify({ level: 'warn', component: 'autopilot', message: (error as Error).message }));
    }
  }
}

export async function startWorker(options: { embedded?: boolean } = {}): Promise<{ stop: () => Promise<void> }> {
  if (running) throw new Error('Worker already running in this process');
  running = true;
  const abort = new AbortController();
  if (options.embedded) {
    // In-process worker for the sandbox preview: survives no external services.
    timers.push(
      setInterval(() => {
        void pump();
      }, 350),
    );
    timers.push(
      setInterval(() => {
        void scheduled();
      }, 5_000),
    );
  }
  async function pump(): Promise<void> {
    if (abort.signal.aborted) return;
    try {
      for (let i = 0; i < 20; i++) {
        if (!(await processOnce())) break;
      }
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', component: 'worker-loop', message: (error as Error).message }));
    }
  }
  // Run one reconciliation shortly after boot (not during tests).
  setTimeout(() => {
    void scheduled().catch(() => {});
  }, 3_000).unref?.();
  return {
    stop: async () => {
      abort.abort();
      for (const timer of timers) clearInterval(timer);
      timers.length = 0;
      running = false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
  };
}

/** Standalone worker entrypoint: `npm run worker`. */
if (process.argv[1]?.endsWith('worker.ts') || process.argv[1]?.endsWith('worker.js')) {
  const worker = await startWorker({ embedded: true });
  console.log(JSON.stringify({ level: 'info', message: 'YESI worker started', worker: WORKER_ID }));
  const shutdown = async () => {
    await worker.stop();
    await db.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
