/** Waves, picking tasks, shipments, dispatch and carrier tracking. */
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
  stockMove,
  tx,
  uid,
  type Client,
} from '../db/index.js';
import type { Actor } from '../config.js';
import { SHIPMENT_FLOWS } from './schema.js';
import { transitionOrder } from './orders.js';
import { recordSaleTx } from './finance.js';

export async function createWave(actor: Actor, orderIds: string[], versions: Record<string, number>) {
  return tx(async (c) => {
    await setActorContext(c, actor, 'wave released');
    const waveId = uid();
    const name = `W-${new Date().toISOString().slice(5, 10).replace('-', '')}-${String(
      Math.floor(Math.random() * 9000) + 1000,
    )}`;
    await c.query('INSERT INTO waves(id, name, status, created_by) VALUES($1,$2,\'RELEASED\',$3)', [
      waveId,
      name,
      actor.id,
    ]);
    let tasks = 0;
    for (const orderId of orderIds) {
      const order = await one<any>(c, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
      const version = versions[orderId];
      if (version === undefined) fail(422, 'VERSION_REQUIRED', `Order ${order.external_id} is missing its version`);
      if (order.status !== 'RESERVED') fail(409, 'ILLEGAL_TRANSITION', `Order ${order.external_id} is ${order.status}, not RESERVED`);
      if (Number(order.version) !== Number(version)) {
        fail(409, 'VERSION_CONFLICT', `Order ${order.external_id} changed (expected v${version}, current v${order.version})`);
      }
      await c.query('INSERT INTO wave_orders(wave_id, order_id) VALUES($1,$2)', [waveId, orderId]);
      const reservations = await many<any>(
        c,
        `SELECT r.* FROM reservations r JOIN order_lines l ON l.id=r.order_line_id
         WHERE l.order_id=$1 AND r.status='ACTIVE' ORDER BY r.location`,
        [orderId],
      );
      if (!reservations.length) fail(409, 'NO_RESERVATIONS', `Order ${order.external_id} has no active reservations`);
      for (const reservation of reservations) {
        await c.query(
          `INSERT INTO pick_tasks(id, wave_id, order_id, order_line_id, sku, location, quantity)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [uid(), waveId, orderId, reservation.order_line_id, reservation.sku, reservation.location, reservation.quantity],
        );
        tasks += 1;
      }
      await transitionOrder(c, actor, orderId, 'PICKING', Number(version), { reason: `wave ${name}` });
    }
    await audit(c, actor, 'wave.created', 'wave', waveId, null, { name, orders: orderIds, tasks });
    await emit(c, {
      topic: 'wave.created',
      aggregateType: 'wave',
      aggregateId: waveId,
      payload: { wave_id: waveId, name, orders: orderIds.length, tasks },
    });
    return { id: waveId, name, orders: orderIds.length, tasks };
  });
}

export async function pickTask(actor: Actor, taskId: string, picked: number) {
  return tx(async (c) => {
    const task = await one<any>(c, 'SELECT * FROM pick_tasks WHERE id=$1 FOR UPDATE', [taskId]);
    if (task.status !== 'PENDING') fail(409, 'TASK_CLOSED', 'This pick task is already closed');
    if (picked > Number(task.quantity)) fail(422, 'OVER_PICK', 'Picked quantity exceeds the task');
    const status = picked === Number(task.quantity) ? 'PICKED' : picked === 0 ? 'PENDING' : 'SHORT';
    await c.query('UPDATE pick_tasks SET picked=$2, status=$3, picked_at=now() WHERE id=$1', [taskId, picked, status]);
    await audit(c, actor, 'pick.recorded', 'pick_task', taskId, null, { picked, status });
    return { task_id: taskId, status, picked };
  });
}

export async function completeWave(actor: Actor, waveId: string) {
  return tx(async (c) => {
    await setActorContext(c, actor, 'wave complete');
    const wave = await one<any>(c, 'SELECT * FROM waves WHERE id=$1 FOR UPDATE', [waveId]);
    if (!['RELEASED', 'PICKING'].includes(wave.status)) fail(409, 'WAVE_CLOSED', 'Wave is already closed');
    const pending = await one<{ n: number }>(
      c,
      `SELECT count(*)::int AS n FROM pick_tasks WHERE wave_id=$1 AND status <> 'PICKED'`,
      [waveId],
    );
    if (Number(pending.n) > 0) fail(409, 'PICKS_OUTSTANDING', `${pending.n} pick task(s) are not complete`);
    const orders = await many<any>(
      c,
      'SELECT o.* FROM wave_orders wo JOIN orders o ON o.id=wo.order_id WHERE wo.wave_id=$1 ORDER BY o.id',
      [waveId],
    );
    for (const order of orders) {
      if (order.status !== 'PICKING') fail(409, 'ILLEGAL_TRANSITION', `Order ${order.external_id} is ${order.status}`);
      await transitionOrder(c, actor, order.id, 'PACKED', Number(order.version), { reason: `wave ${wave.name} complete` });
    }
    await c.query(`UPDATE waves SET status='COMPLETE', completed_at=now() WHERE id=$1`, [waveId]);
    await audit(c, actor, 'wave.completed', 'wave', waveId, wave, { orders: orders.length });
    await emit(c, {
      topic: 'wave.completed',
      aggregateType: 'wave',
      aggregateId: waveId,
      payload: { wave_id: waveId, name: wave.name, orders: orders.length },
    });
    return { wave_id: waveId, status: 'COMPLETE', orders: orders.length };
  });
}

export async function bookShipment(
  actor: Actor,
  orderId: string,
  version: number,
  carrier: string,
  service = 'STANDARD',
) {
  return tx(async (c) => {
    await setActorContext(c, actor, 'shipment booked');
    const order = await one<any>(c, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
    if (order.status !== 'READY_TO_SHIP') {
      fail(409, 'ILLEGAL_TRANSITION', `Order is ${order.status}; it must be READY_TO_SHIP before booking a carrier`);
    }
    if (Number(order.version) !== Number(version)) {
      fail(409, 'VERSION_CONFLICT', `Order changed (expected v${version}, current v${order.version})`);
    }
    const existing = await maybeOne<any>(c, 'SELECT * FROM shipments WHERE order_id=$1', [orderId]);
    if (existing) fail(409, 'SHIPMENT_EXISTS', 'A shipment already exists for this order');
    const shipmentId = uid();
    await c.query(
      `INSERT INTO shipments(id, order_id, carrier, service, status) VALUES($1,$2,$3,$4,'CREATED')`,
      [shipmentId, orderId, carrier, service],
    );
    await audit(c, actor, 'shipment.created', 'shipment', shipmentId, null, { order_id: orderId, carrier, service });
    await emit(c, {
      topic: 'tms.book',
      aggregateType: 'shipment',
      aggregateId: shipmentId,
      payload: {
        shipment_id: shipmentId,
        order_id: orderId,
        external_id: order.external_id,
        carrier,
        service,
        provider: null,
      },
    });
    return { shipment_id: shipmentId, order_id: orderId, status: 'CREATED' };
  });
}

export async function dispatchShipment(actor: Actor, shipmentId: string, version: number) {
  return tx(async (c) => {
    await setActorContext(c, actor, 'carrier handover');
    const shipment = await one<any>(c, 'SELECT * FROM shipments WHERE id=$1 FOR UPDATE', [shipmentId]);
    if (Number(shipment.version) !== Number(version)) {
      fail(409, 'VERSION_CONFLICT', `Shipment changed (expected v${version}, current v${shipment.version})`);
    }
    const order = await one<any>(c, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [shipment.order_id]);
    if (order.status !== 'READY_TO_SHIP') fail(409, 'ILLEGAL_TRANSITION', `Order is ${order.status}; cannot dispatch`);
    if (!['BOOKED', 'DISPATCHED'].includes(shipment.status)) {
      fail(409, 'SHIPMENT_NOT_BOOKED', `Shipment is ${shipment.status}; wait for the carrier booking to succeed`);
    }

    const reservations = await many<any>(
      c,
      `SELECT r.* FROM reservations r JOIN order_lines l ON l.id=r.order_line_id
       WHERE l.order_id=$1 AND r.status='ACTIVE' ORDER BY r.sku, r.location`,
      [order.id],
    );
    const skus: string[] = [];
    for (const reservation of reservations) {
      await stockMove(c, actor, {
        sku: reservation.sku,
        location: reservation.location,
        onHand: -Number(reservation.quantity),
        reserved: -Number(reservation.quantity),
        reason: 'SHIP',
        reference: shipmentId,
        requestKey: `SHIP:${shipmentId}:${reservation.id}`,
      });
      await c.query(`UPDATE reservations SET status='CONSUMED', closed_at=now() WHERE id=$1`, [reservation.id]);
      skus.push(reservation.sku);
    }

    await c.query(
      `UPDATE shipments SET status='DISPATCHED', version=version+1, dispatched_at=now() WHERE id=$1`,
      [shipmentId],
    );
    await transitionOrder(c, actor, order.id, 'SHIPPED', Number(order.version), { reason: 'carrier handover' });
    await audit(c, actor, 'shipment.dispatched', 'shipment', shipmentId, shipment, {
      carrier: shipment.carrier,
      tracking_number: shipment.tracking_number,
    });

    const finance = await recordSaleTx(c, actor, order.id, shipmentId);
    await emit(c, {
      topic: 'marketplace.ship',
      aggregateType: 'shipment',
      aggregateId: shipmentId,
      payload: {
        shipment_id: shipmentId,
        order_id: order.id,
        tracking_number: shipment.tracking_number,
        carrier: shipment.carrier,
        mode: 'confirm',
      },
    });
    if (skus.length) {
      await emit(c, {
        topic: 'inventory.changed',
        aggregateType: 'shipment',
        aggregateId: shipmentId,
        payload: { order_id: order.id, shipment_id: shipmentId, skus: [...new Set(skus)], reason: 'dispatch' },
      });
    }
    await emit(c, {
      topic: 'shipment.updated',
      aggregateType: 'shipment',
      aggregateId: shipmentId,
      payload: { shipment_id: shipmentId, order_id: order.id, status: 'DISPATCHED', version: Number(shipment.version) + 1 },
    });
    return {
      shipment_id: shipmentId,
      order_id: order.id,
      status: 'DISPATCHED',
      finance,
      tracking_number: shipment.tracking_number,
    };
  });
}

function shipmentPath(from: string, to: string): string[] | null {
  if (from === to) return [];
  const queue: Array<{ status: string; path: string[] }> = [{ status: from, path: [] }];
  const seen = new Set([from]);
  while (queue.length) {
    const current = queue.shift()!;
    for (const next of SHIPMENT_FLOWS[current.status] || []) {
      if (seen.has(next)) continue;
      const path = [...current.path, next];
      if (next === to) return path;
      seen.add(next);
      queue.push({ status: next, path });
    }
  }
  return null;
}

export async function applyTrackingUpdate(input: {
  shipmentId: string;
  status: string;
  externalEventId: string;
  message?: string;
  payload?: unknown;
  source?: 'TMS' | 'WMS' | 'MANUAL';
}) {
  return tx(async (c) => {
    const systemActor: Actor = {
      id: '00000000-0000-0000-0000-000000000003',
      role: 'integration',
      email: 'tms@system',
      requestId: `tms:${input.externalEventId}`,
      type: 'system',
    };
    const shipment = await one<any>(c, 'SELECT * FROM shipments WHERE id=$1 FOR UPDATE', [input.shipmentId]);
    const dedupe = `tms:${input.externalEventId}`;
    const inserted = await c.query(
      `INSERT INTO shipment_events(id, shipment_id, status, source, message, payload, dedupe_key)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [uid(), input.shipmentId, input.status, input.source || 'TMS', input.message ?? null, JSON.stringify(input.payload ?? {}), dedupe],
    );
    if (!inserted.rowCount) return { shipment_id: input.shipmentId, status: shipment.status, duplicate: true };

    const path = shipmentPath(shipment.status, input.status);
    if (path === null) {
      await exception(c, {
        kind: 'TMS_STATUS_CONFLICT',
        severity: 'HIGH',
        entityType: 'shipment',
        entityId: input.shipmentId,
        message: `Carrier reported ${input.status} for a shipment in ${shipment.status}`,
        details: { external_event_id: input.externalEventId },
        replayable: false,
      });
      return { shipment_id: input.shipmentId, status: shipment.status, conflict: true };
    }
    for (const next of path) {
      await c.query(
        `UPDATE shipments SET status=$2, version=version+1,
           dispatched_at = CASE WHEN $2='DISPATCHED' THEN now() ELSE dispatched_at END,
           delivered_at = CASE WHEN $2='DELIVERED' THEN now() ELSE delivered_at END
         WHERE id=$1`,
        [input.shipmentId, next],
      );
      await audit(c, systemActor, `shipment.${next.toLowerCase()}`, 'shipment', input.shipmentId, { status: shipment.status }, { status: next });
    }
    const current = await one<any>(c, 'SELECT * FROM shipments WHERE id=$1', [input.shipmentId]);

    if (input.status === 'DELIVERED') {
      const order = await one<any>(c, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [shipment.order_id]);
      if (order.status === 'SHIPPED') {
        await transitionOrder(c, systemActor, order.id, 'DELIVERED', Number(order.version), { reason: 'carrier delivery confirmation' });
      } else if (order.status !== 'DELIVERED') {
        await exception(c, {
          kind: 'DELIVERY_BEFORE_DISPATCH',
          severity: 'HIGH',
          entityType: 'order',
          entityId: order.id,
          message: `Carrier confirmed delivery while the order is ${order.status}`,
          details: { shipment_id: input.shipmentId },
        });
      }
    }
    await emit(c, {
      topic: 'shipment.updated',
      aggregateType: 'shipment',
      aggregateId: input.shipmentId,
      payload: {
        shipment_id: input.shipmentId,
        order_id: shipment.order_id,
        status: current.status,
        tracking_number: current.tracking_number,
        external_event_id: input.externalEventId,
      },
    });
    return { shipment_id: input.shipmentId, status: current.status, duplicate: false };
  });
}

export async function applyBookingResult(
  shipmentId: string,
  result: { external_id: string; tracking_number: string; tracking_url?: string; label_reference?: string },
) {
  return tx(async (c) => {
    const shipment = await one<any>(c, 'SELECT * FROM shipments WHERE id=$1 FOR UPDATE', [shipmentId]);
    if (shipment.status !== 'CREATED') return { status: shipment.status, skipped: true };
    await c.query(
      `UPDATE shipments SET status='BOOKED', external_id=$2, tracking_number=$3, tracking_url=$4,
         label_reference=$5, version=version+1, booked_at=now() WHERE id=$1`,
      [shipmentId, result.external_id, result.tracking_number, result.tracking_url ?? null, result.label_reference ?? null],
    );
    const actor: Actor = {
      id: '00000000-0000-0000-0000-000000000003',
      role: 'integration',
      email: 'tms@system',
      requestId: 'tms:book:' + shipmentId,
      type: 'system',
    };
    await audit(c, actor, 'shipment.booked', 'shipment', shipmentId, shipment, result);
    await emit(c, {
      topic: 'shipment.updated',
      aggregateType: 'shipment',
      aggregateId: shipmentId,
      payload: { shipment_id: shipmentId, order_id: shipment.order_id, status: 'BOOKED', tracking_number: result.tracking_number },
    });
    return { shipment_id: shipmentId, status: 'BOOKED', ...result };
  });
}

export async function shipmentDetail(shipmentId: string) {
  const shipment = await one(db, 'SELECT s.*, o.external_id FROM shipments s JOIN orders o ON o.id=s.order_id WHERE s.id=$1', [
    shipmentId,
  ]);
  const events = await many(db, 'SELECT * FROM shipment_events WHERE shipment_id=$1 ORDER BY id', [shipmentId]);
  return { ...shipment, events };
}

export async function tmsPoke(_client?: Client) {
  void _client;
}
