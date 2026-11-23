/** Receiving, cycle counts, adjustments and inventory reads. */
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
} from '../db/index.js';
import type { Actor } from '../config.js';

export async function listInventory() {
  return many(
    db,
    `SELECT i.*, p.name, p.category, p.cost_minor,
            i.on_hand - i.reserved - i.damaged AS available
     FROM inventory i JOIN products p ON p.sku=i.sku
     ORDER BY p.category, i.sku, i.location`,
  );
}

export async function listLedger(sku?: string, limit = 200) {
  return many(
    db,
    `SELECT * FROM stock_ledger ${sku ? 'WHERE sku=$1' : ''} ORDER BY id DESC LIMIT ${Number(limit) || 200}`,
    sku ? [sku] : [],
  );
}

export async function createAsn(
  actor: Actor,
  input: { supplier: string; reference?: string; expectedAt?: string; lines: Array<{ sku: string; location: string; expected: number }> },
) {
  return tx(async (c) => {
    const id = uid();
    const skus = [...new Set(input.lines.map((line) => line.sku))];
    const products = await many<any>(c, `SELECT sku FROM products WHERE sku = ANY($1)`, [skus]);
    if (products.length !== skus.length) fail(422, 'UNKNOWN_SKU', 'One or more SKUs are not in the catalog');
    for (const line of input.lines) {
      const location = await maybeOne(c, 'SELECT code FROM locations WHERE code=$1', [line.location]);
      if (!location) fail(422, 'UNKNOWN_LOCATION', `Location ${line.location} does not exist`);
      await c.query(
        'INSERT INTO inventory(sku, location) VALUES($1,$2) ON CONFLICT (sku, location) DO NOTHING',
        [line.sku, line.location],
      );
    }
    await c.query('INSERT INTO asns(id, supplier, reference, expected_at, created_by) VALUES($1,$2,$3,$4,$5)', [
      id,
      input.supplier,
      input.reference ?? null,
      input.expectedAt ?? null,
      actor.id,
    ]);
    for (const line of input.lines) {
      await c.query('INSERT INTO asn_lines(asn_id, sku, location, expected) VALUES($1,$2,$3,$4)', [
        id,
        line.sku,
        line.location,
        line.expected,
      ]);
    }
    await audit(c, actor, 'asn.created', 'asn', id, null, input);
    await emit(c, {
      topic: 'asn.created',
      aggregateType: 'asn',
      aggregateId: id,
      payload: { asn_id: id, supplier: input.supplier, lines: input.lines.length },
    });
    return { id, status: 'EXPECTED' };
  });
}

export async function receiveAsn(
  actor: Actor,
  asnId: string,
  input: { lines: Array<{ sku: string; location: string; quantity: number }> },
) {
  return tx(async (c) => {
    await setActorContext(c, actor, 'asn receiving');
    const asn = await one<any>(c, 'SELECT * FROM asns WHERE id=$1 FOR UPDATE', [asnId]);
    if (asn.status === 'RECEIVED') fail(409, 'ASN_CLOSED', 'This ASN is already fully received');
    if (asn.status === 'CANCELLED') fail(409, 'ASN_CANCELLED', 'This ASN was cancelled');
    const receivedNow: Array<{ sku: string; location: string; quantity: number }> = [];
    for (const line of input.lines) {
      const asnLine = await maybeOne<any>(
        c,
        'SELECT * FROM asn_lines WHERE asn_id=$1 AND sku=$2 AND location=$3 FOR UPDATE',
        [asnId, line.sku, line.location],
      );
      if (!asnLine) fail(422, 'ASN_LINE_UNKNOWN', `${line.sku} at ${line.location} is not on this ASN`);
      const remaining = Number(asnLine.expected) - Number(asnLine.received);
      if (line.quantity > remaining) {
        fail(409, 'OVER_RECEIPT', `${line.sku} at ${line.location}: ${line.quantity} exceeds the ${remaining} remaining`);
      }
      const newReceived = Number(asnLine.received) + line.quantity;
      await stockMove(c, actor, {
        sku: line.sku,
        location: line.location,
        onHand: line.quantity,
        reason: 'ASN_RECEIPT',
        reference: asnId,
        requestKey: `ASN:${asnId}:${line.sku}:${line.location}:${newReceived}`,
      });
      await c.query('UPDATE asn_lines SET received=$4 WHERE asn_id=$1 AND sku=$2 AND location=$3', [
        asnId,
        line.sku,
        line.location,
        newReceived,
      ]);
      receivedNow.push(line);
    }
    const outstanding = await one<{ n: number }>(
      c,
      'SELECT count(*)::int AS n FROM asn_lines WHERE asn_id=$1 AND received < expected',
      [asnId],
    );
    const status = Number(outstanding.n) === 0 ? 'RECEIVED' : 'IN_RECEIVING';
    await c.query('UPDATE asns SET status=$2, received_at=CASE WHEN $2=\'RECEIVED\' THEN now() ELSE received_at END WHERE id=$1', [
      asnId,
      status,
    ]);
    const skus = [...new Set(receivedNow.map((line) => line.sku))];
    await audit(c, actor, 'asn.received', 'asn', asnId, asn, { lines: receivedNow, status });
    await emit(c, {
      topic: 'asn.received',
      aggregateType: 'asn',
      aggregateId: asnId,
      payload: { asn_id: asnId, status, lines: receivedNow.length },
    });
    // New supply can immediately satisfy backorders; availability changes.
    await emit(c, {
      topic: 'inventory.changed',
      aggregateType: 'asn',
      aggregateId: asnId,
      payload: { asn_id: asnId, skus, reason: 'asn_receipt' },
    });
    return { asn_id: asnId, status, received: receivedNow };
  });
}

export async function reconcileStock(
  actor: Actor,
  input: { sku: string; location: string; counted: number; expectedVersion: number },
) {
  return tx(async (c) => {
    const position = await maybeOne<any>(
      c,
      'SELECT * FROM inventory WHERE sku=$1 AND location=$2 FOR UPDATE',
      [input.sku, input.location],
    );
    if (!position) fail(404, 'POSITION_NOT_FOUND', 'No inventory position for this SKU and location');
    if (Number(position.version) !== input.expectedVersion) {
      fail(409, 'VERSION_CONFLICT', `Inventory changed (expected v${input.expectedVersion}, current v${position.version})`);
    }
    const variance = Number(input.counted) - Number(position.on_hand);
    if (variance === 0) {
      await audit(c, actor, 'stock.count_matched', 'inventory', `${input.sku}:${input.location}`, position, {
        counted: input.counted,
      });
      return { variance: 0, count_id: null };
    }
    const id = uid();
    await c.query(
      `INSERT INTO stock_counts(id, sku, location, expected_on_hand, counted, variance, counted_by)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [id, input.sku, input.location, Number(position.on_hand), input.counted, variance, actor.id],
    );
    await exception(c, {
      kind: 'COUNT_VARIANCE',
      severity: Math.abs(variance) > 10 ? 'HIGH' : 'MEDIUM',
      entityType: 'stock_count',
      entityId: id,
      message: `${input.sku} at ${input.location}: counted ${input.counted}, system ${position.on_hand}`,
      details: { variance, sku: input.sku, location: input.location },
    });
    await audit(c, actor, 'stock.counted', 'stock_count', id, position, { counted: input.counted, variance });
    return { variance, count_id: id };
  });
}

export async function approveCount(actor: Actor, countId: string) {
  return tx(async (c) => {
    await setActorContext(c, actor, 'count variance approved');
    const count = await one<any>(c, 'SELECT * FROM stock_counts WHERE id=$1 FOR UPDATE', [countId]);
    if (count.status !== 'OPEN') fail(409, 'COUNT_CLOSED', 'This count has already been decided');
    const delta = Number(count.variance);
    const updated = await stockMove(c, actor, {
      sku: count.sku,
      location: count.location,
      onHand: delta,
      reason: 'COUNT_ADJUST',
      reference: countId,
      requestKey: `COUNT:${countId}`,
    });
    await c.query('UPDATE stock_counts SET status=\'APPROVED\', approved_by=$2, approved_at=now() WHERE id=$1', [
      countId,
      actor.id,
    ]);
    await c.query(
      `UPDATE exceptions SET status='RESOLVED', resolved_by=$2, resolved_at=now(), resolution='count variance approved'
       WHERE status='OPEN' AND kind='COUNT_VARIANCE' AND entity_id=$1`,
      [countId, actor.id],
    );
    await audit(c, actor, 'stock.adjusted', 'stock_count', countId, count, {
      delta,
      balance_on_hand: Number(updated.on_hand),
    });
    await emit(c, {
      topic: 'inventory.changed',
      aggregateType: 'stock_count',
      aggregateId: countId,
      payload: { sku: count.sku, location: count.location, skus: [count.sku], reason: 'cycle_count' },
    });
    return { count_id: countId, delta, on_hand: Number(updated.on_hand) };
  });
}

export async function adjustStock(
  actor: Actor,
  input: { sku: string; location: string; delta: number; reason: string; note?: string },
) {
  return tx(async (c) => {
    const reference = uid();
    const updated = await stockMove(c, actor, {
      sku: input.sku,
      location: input.location,
      onHand: input.delta,
      reason: input.reason,
      reference,
      requestKey: `ADJUST:${reference}`,
    });
    await audit(c, actor, 'stock.adjusted_manual', 'inventory', `${input.sku}:${input.location}`, null, {
      delta: input.delta,
      reason: input.reason,
      note: input.note,
      balance_on_hand: Number(updated.on_hand),
    });
    await emit(c, {
      topic: 'inventory.changed',
      aggregateType: 'inventory',
      aggregateId: `${input.sku}:${input.location}`,
      payload: { sku: input.sku, location: input.location, skus: [input.sku], reason: input.reason },
    });
    return updated;
  });
}

export async function inventoryVelocity() {
  return many(
    db,
    `SELECT l.sku, p.name, sum(l.quantity)::int AS units_24h
     FROM order_lines l
     JOIN orders o ON o.id=l.order_id
     JOIN products p ON p.sku=l.sku
     WHERE o.created_at > now() - interval '24 hours' AND l.sku IS NOT NULL
     GROUP BY l.sku, p.name
     ORDER BY units_24h DESC
     LIMIT 12`,
  );
}
