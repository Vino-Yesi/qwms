/**
 * Order lifecycle. Status changes are optimistic (version checked) and
 * validated by the database state machine trigger; every change is audited and
 * produces a durable event.
 */
import { z } from 'zod';
import {
  audit,
  db,
  emit,
  exception,
  fail,
  many,
  maybeOne,
  one,
  setActorContext,
  uid,
  stockMove,
  tx,
  type Client,
} from '../db/index.js';
import type { Actor } from '../config.js';
import { ORDER_FLOWS, type OrderStatus } from './schema.js';

export const versionSchema = z.object({ version: z.number().int().positive() }).strict();

export async function transitionOrder(
  c: Client,
  actor: Actor,
  id: string,
  to: OrderStatus,
  expectedVersion: number,
  options: { reason?: string; exceptionCode?: string | null } = {},
): Promise<any> {
  await setActorContext(c, actor, options.reason);
  const before = await one<any>(c, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
  if (Number(before.version) !== Number(expectedVersion)) {
    fail(409, 'VERSION_CONFLICT', `Order changed since you loaded it (expected v${expectedVersion}, current v${before.version})`);
  }
  if (!ORDER_FLOWS[before.status as OrderStatus]?.includes(to)) {
    fail(409, 'ILLEGAL_TRANSITION', `Order cannot move from ${before.status} to ${to}`);
  }
  const exceptionCode = to === 'EXCEPTION' ? (options.exceptionCode ?? before.exception_code ?? 'MANUAL_REVIEW') : null;
  const after = await one<any>(
    c,
    `UPDATE orders SET status=$2, version=version+1, exception_code=$3 WHERE id=$1 RETURNING *`,
    [id, to, exceptionCode],
  );
  await audit(c, actor, `order.${to.toLowerCase()}`, 'order', id, before, after);
  await emit(c, {
    topic: 'order.updated',
    aggregateType: 'order',
    aggregateId: id,
    payload: {
      order_id: id,
      external_id: after.external_id,
      status: to,
      previous_status: before.status,
      version: Number(after.version),
      exception_code: exceptionCode,
    },
  });
  return after;
}

/** Split a requested quantity across physical positions, locking each row. */
async function allocate(
  c: Client,
  actor: Actor,
  orderId: string,
  line: any,
  quantity: number,
): Promise<Array<{ location: string; quantity: number }>> {
  const positions = await many<any>(
    c,
    `SELECT * FROM inventory
     WHERE sku=$1 AND on_hand - reserved - damaged > 0
     ORDER BY location FOR UPDATE`,
    [line.sku],
  );
  let remaining = quantity;
  const allocations: Array<{ location: string; quantity: number }> = [];
  for (const position of positions) {
    if (remaining <= 0) break;
    const available = Number(position.on_hand - position.reserved - position.damaged);
    const take = Math.min(remaining, available);
    if (take <= 0) continue;
    await stockMove(c, actor, {
      sku: line.sku,
      location: position.location,
      reserved: take,
      reason: 'RESERVE',
      reference: orderId,
      requestKey: `RESERVE:${orderId}:${line.id}:${position.location}`,
    });
    allocations.push({ location: position.location, quantity: take });
    remaining -= take;
  }
  if (remaining > 0) {
    fail(409, 'INSUFFICIENT_STOCK', `${line.sku}: ${remaining} unit(s) unavailable — the whole reservation was rolled back`);
  }
  return allocations;
}

export async function reserveOrder(actor: Actor, orderId: string, version: number) {
  return tx(async (c) => {
    await setActorContext(c, actor, 'reservation');
    const order = await one<any>(c, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
    const lines = await many<any>(c, 'SELECT * FROM order_lines WHERE order_id=$1 ORDER BY sku', [orderId]);
    if (lines.some((line) => !line.sku)) fail(409, 'SKU_UNMAPPED', 'Every line must be mapped before reservation');
    const after = await transitionOrder(c, actor, orderId, 'RESERVED', version, { reason: 'reservation' });
    for (const line of lines) {
      const allocations = await allocate(c, actor, orderId, line, Number(line.quantity));
      for (const allocation of allocations) {
        await c.query(
          `INSERT INTO reservations(id, order_line_id, sku, location, quantity) VALUES($1,$2,$3,$4,$5)`,
          [
            uid(),
            line.id,
            line.sku,
            allocation.location,
            allocation.quantity,
          ],
        );
      }
    }
    await audit(c, actor, 'inventory.reserved', 'order', orderId, null, {
      lines: lines.map((line) => ({ sku: line.sku, quantity: Number(line.quantity) })),
    });
    await emit(c, {
      topic: 'inventory.changed',
      aggregateType: 'order',
      aggregateId: orderId,
      payload: { order_id: orderId, skus: [...new Set(lines.map((line) => line.sku))], reason: 'reservation' },
    });
    return { order_id: orderId, status: after.status, version: Number(after.version), lines: lines.map((l) => l.sku) };
  });
}

export async function releaseReservations(c: Client, actor: Actor, orderId: string): Promise<string[]> {
  const reservations = await many<any>(
    c,
    `SELECT r.* FROM reservations r JOIN order_lines l ON l.id=r.order_line_id
     WHERE l.order_id=$1 AND r.status='ACTIVE' FOR UPDATE`,
    [orderId],
  );
  for (const reservation of reservations) {
    await stockMove(c, actor, {
      sku: reservation.sku,
      location: reservation.location,
      reserved: -Number(reservation.quantity),
      reason: 'RELEASE',
      reference: orderId,
      requestKey: `RELEASE:${orderId}:${reservation.id}`,
    });
    await c.query(`UPDATE reservations SET status='RELEASED', closed_at=now() WHERE id=$1`, [reservation.id]);
  }
  return [...new Set(reservations.map((r) => r.sku))];
}

/** Cancellation inside an existing transaction (used by ingestion and API). */
export async function cancelOrderTx(
  c: Client,
  actor: Actor,
  orderId: string,
  version: number,
  reason: string,
): Promise<{ order_id: string; status: string; version: number }> {
  await setActorContext(c, actor, reason);
  const order = await one<any>(c, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
  if (Number(order.version) !== Number(version)) {
    fail(409, 'VERSION_CONFLICT', `Order changed since you loaded it (expected v${version}, current v${order.version})`);
  }
  if (['PICKING', 'PACKED', 'READY_TO_SHIP'].includes(order.status)) {
    fail(409, 'PHYSICAL_HOLD', 'Floor work is in progress. Complete or short-pick the wave before cancelling.');
  }
  if (['SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED'].includes(order.status)) {
    fail(409, 'ILLEGAL_TRANSITION', 'Shipped orders follow the returns workflow, not cancellation');
  }
  const skus = await releaseReservations(c, actor, orderId);
  const after = await transitionOrder(c, actor, orderId, 'CANCELLED', version, { reason });
  await c.query('UPDATE orders SET cancelled_reason=$2 WHERE id=$1', [orderId, reason]);
  await audit(c, actor, 'order.cancelled', 'order', orderId, order, { reason });
  if (skus.length) {
    await emit(c, {
      topic: 'inventory.changed',
      aggregateType: 'order',
      aggregateId: orderId,
      payload: { order_id: orderId, skus, reason: 'cancellation' },
    });
  }
  return { order_id: orderId, status: after.status, version: Number(after.version) };
}

export async function cancelOrder(actor: Actor, orderId: string, version: number, reason: string) {
  return tx((c) => cancelOrderTx(c, actor, orderId, version, reason));
}

export async function markReadyToShip(actor: Actor, orderId: string, version: number) {
  return tx(async (c) => {
    const after = await transitionOrder(c, actor, orderId, 'READY_TO_SHIP', version, { reason: 'packed and labelled' });
    return { order_id: orderId, status: after.status, version: Number(after.version) };
  });
}

export async function getOrderDetail(orderId: string) {
  const order = await one(
    db,
    `SELECT o.*, c.provider, c.name AS connection_name, c.account_ref, c.mode
     FROM orders o JOIN connections c ON c.id=o.connection_id WHERE o.id=$1`,
    [orderId],
  );
  const [lines, reservations, transitions, shipment, journals, rawEvents, openExceptions] = await Promise.all([
    many(db, `SELECT l.*, p.name AS product_name, p.cost_minor FROM order_lines l LEFT JOIN products p ON p.sku=l.sku WHERE l.order_id=$1 ORDER BY l.external_sku`, [orderId]),
    many(db, `SELECT r.*, l.external_sku FROM reservations r JOIN order_lines l ON l.id=r.order_line_id WHERE l.order_id=$1 ORDER BY r.created_at`, [orderId]),
    many(db, `SELECT * FROM order_transitions WHERE order_id=$1 ORDER BY id`, [orderId]),
    maybeOne(db, `SELECT * FROM shipments WHERE order_id=$1`, [orderId]),
    many(db, `SELECT j.*, (SELECT json_agg(jl) FROM journal_lines jl WHERE jl.entry_id=j.id) AS lines FROM journal_entries j WHERE j.order_id=$1 ORDER BY j.created_at`, [orderId]),
    many(db, `SELECT id, external_event_id, event_type, status, received_at, payload_hash, last_error FROM raw_events WHERE order_id=$1 ORDER BY received_at DESC`, [orderId]),
    many(db, `SELECT * FROM exceptions WHERE entity_type='order' AND entity_id=$1 ORDER BY created_at DESC`, [orderId]),
  ]);
  const shipmentEvents = shipment
    ? await many(db, `SELECT * FROM shipment_events WHERE shipment_id=$1 ORDER BY id`, [shipment.id])
    : [];
  return { ...order, lines, reservations, transitions, shipment: shipment ? { ...shipment, events: shipmentEvents } : null, journals, raw_events: rawEvents, exceptions: openExceptions };
}

/** SLA + queue helper used by the control tower and priority pick sorting. */
export function slaState(order: any): 'overdue' | 'at_risk' | 'on_time' | 'closed' {
  if (['SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED'].includes(order.status)) return 'closed';
  const remaining = new Date(order.ship_by).getTime() - Date.now();
  if (remaining < 0) return 'overdue';
  if (remaining < 4 * 3600_000) return 'at_risk';
  return 'on_time';
}

export async function flagAtRiskOrders(): Promise<void> {
  const risky = await many<any>(
    db,
    `SELECT o.*, c.provider FROM orders o JOIN connections c ON c.id=o.connection_id
     WHERE o.status NOT IN ('SHIPPED','DELIVERED','CANCELLED','RETURNED')
       AND o.ship_by < now() + interval '2 hours'`,
  );
  for (const order of risky) {
    await tx(async (c) => {
      await exception(c, {
        kind: 'SLA_AT_RISK',
        severity: order.ship_by < new Date() ? 'HIGH' : 'MEDIUM',
        entityType: 'order',
        entityId: order.id,
        message: `Order ${order.external_id} is ${new Date(order.ship_by) < new Date() ? 'past' : 'close to'} its ship-by deadline`,
        details: { provider: order.provider, status: order.status, ship_by: order.ship_by },
      });
    });
  }
}
