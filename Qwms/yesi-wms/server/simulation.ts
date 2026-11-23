/**
 * Sandbox autopilot.
 *
 * Only active in development. It drives the *real* domain services (reserve,
 * wave, pick, pack, book, dispatch, track) so the demo exercises the same state
 * machines, ledger and audit chain as an operator would. It is clearly labelled
 * as a simulator in the UI and refuses to run in production.
 */
import { db, exception, many, maybeOne, tx } from './db/index.js';
import { config, type Actor } from './config.js';
import { markReadyToShip, reserveOrder } from './domain/orders.js';
import { applyTrackingUpdate, bookShipment, completeWave, createWave, dispatchShipment, pickTask } from './domain/fulfillment.js';

const AUTOPILOT: Actor = {
  id: '00000000-0000-0000-0000-000000000004',
  role: 'supervisor',
  email: 'autopilot@system',
  requestId: 'autopilot',
  type: 'system',
};

async function safe(step: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (error) {
    console.error(JSON.stringify({ level: 'debug', component: 'autopilot', step, message: (error as Error).message }));
    return false;
  }
}

async function waveReadyOrders(): Promise<boolean> {
  const ready = await many<any>(
    db,
    `SELECT id, version FROM orders WHERE status='RESERVED' ORDER BY ship_by ASC LIMIT 4`,
  );
  if (ready.length < 4) return false;
  const versions = Object.fromEntries(ready.map((order) => [order.id, Number(order.version)]));
  const wave = await createWave(AUTOPILOT, ready.map((order) => order.id), versions);
  const tasks = await many<any>(db, 'SELECT * FROM pick_tasks WHERE wave_id=$1', [wave.id]);
  for (const task of tasks) {
    await pickTask(AUTOPILOT, task.id, Number(task.quantity));
  }
  await completeWave(AUTOPILOT, wave.id);
  return true;
}

async function dispatchBooked(): Promise<boolean> {
  const shipment = await maybeOne<any>(
    db,
    `SELECT * FROM shipments WHERE status='BOOKED' ORDER BY created_at ASC LIMIT 1`,
  );
  if (!shipment) return false;
  await dispatchShipment(AUTOPILOT, shipment.id, Number(shipment.version));
  return true;
}

async function advanceTracking(): Promise<boolean> {
  const shipment = await maybeOne<any>(
    db,
    `SELECT * FROM shipments WHERE status IN ('DISPATCHED','IN_TRANSIT') AND updated_at < now() - interval '4 seconds'
     ORDER BY updated_at ASC LIMIT 1`,
  );
  if (!shipment) return false;
  const next = shipment.status === 'DISPATCHED' ? 'IN_TRANSIT' : 'DELIVERED';
  await applyTrackingUpdate({
    shipmentId: shipment.id,
    status: next,
    externalEventId: `autopilot:${shipment.id}:${next}`,
    message: `Simulated carrier scan: ${next.toLowerCase().replace('_', ' ')}`,
    payload: { carrier: shipment.carrier, simulated: true },
  });
  return true;
}

export async function autopilotTick(): Promise<void> {
  if (!config.development) return;
  const flag = await maybeOne<{ value: boolean }>(db, `SELECT value FROM platform_flags WHERE key='autopilot'`);
  if (flag && flag.value === false) return;

  // 1. carrier scans for shipments already on the road
  for (let i = 0; i < 4; i += 1) {
    if (!(await safe('tracking', advanceTracking))) break;
  }

  // 2. hand over every booked shipment
  for (let i = 0; i < 3; i += 1) {
    if (!(await safe('dispatch_booked', dispatchBooked))) break;
  }

  // 3. packed -> ready, bounded so a packing backlog cannot build
  for (let i = 0; i < 3; i += 1) {
    const packed = await maybeOne<any>(db, `SELECT * FROM orders WHERE status='PACKED' ORDER BY ship_by ASC LIMIT 1`);
    if (!packed) break;
    if (!(await safe('ready', () => markReadyToShip(AUTOPILOT, packed.id, Number(packed.version))))) break;
  }

  // 4. book every ready order that has no carrier booking yet; the next tick
  //    dispatches the booked ones, so booking and handover stay in lockstep
  for (let i = 0; i < 3; i += 1) {
    const ready = await maybeOne<any>(
      db,
      `SELECT o.* FROM orders o
        WHERE o.status='READY_TO_SHIP'
          AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.order_id=o.id)
        ORDER BY o.ship_by ASC LIMIT 1`,
    );
    if (!ready) break;
    if (!(await safe('book', () => bookShipment(AUTOPILOT, ready.id, Number(ready.version), 'YESI Ground', 'STANDARD')))) break;
  }

  // 5. Keep the pick face fed, but never faster than packing can drain it.
  const backlog = await maybeOne<{ n: number }>(db, `SELECT count(*)::int AS n FROM orders WHERE status='PACKED'`);
  if (Number(backlog?.n || 0) >= 4) return;
  for (let i = 0; i < 1; i += 1) {
    const mapped = await maybeOne<any>(db, `SELECT * FROM orders WHERE status='MAPPED' ORDER BY ship_by ASC LIMIT 1`);
    if (!mapped) break;
    const ok = await safe('reserve', () => reserveOrder(AUTOPILOT, mapped.id, Number(mapped.version)));
    if (!ok) {
      const existing = await maybeOne(
        db,
        `SELECT id FROM exceptions WHERE entity_id=$1 AND kind='STOCKOUT' AND status='OPEN'`,
        [mapped.id],
      );
      if (!existing) {
        await tx((c) =>
          exception(c, {
            kind: 'STOCKOUT',
            severity: 'HIGH',
            entityType: 'order',
            entityId: mapped.id,
            message: `Order ${mapped.external_id} cannot be reserved: not enough sellable stock`,
            details: { order: mapped.external_id },
          }),
        );
      }
      break;
    }
  }

  // 6. build a wave when there is fresh reserved work
  await safe('wave', waveReadyOrders);
}
