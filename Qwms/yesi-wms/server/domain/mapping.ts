/**
 * SKU mapping workflow.
 *
 * Marketplace identifiers are never trusted to match internal SKUs. New
 * identifiers arrive as exceptions, a human approves the mapping, and every
 * affected order is repaired in one transaction. The repair uses the same state
 * machine as ingestion, so an exception can only close once the order is
 * genuinely mapped.
 */
import {
  audit,
  db,
  emit,
  fail,
  many,
  maybeOne,
  one,
  setActorContext,
  tx,
  uid,
  type Client,
} from '../db/index.js';
import type { Actor } from '../config.js';
import { transitionOrder } from './orders.js';

export async function listPendingMappings() {
  return many(
    db,
    `SELECT c.id AS connection_id, c.provider, c.name AS connection_name,
            l.external_sku, max(l.external_name) AS external_name,
            count(*)::int AS occurrences,
            min(o.created_at) AS first_seen,
            count(DISTINCT o.id)::int AS orders_waiting,
            (SELECT p.sku FROM products p
              WHERE p.sku = regexp_replace(l.external_sku, '^(OZ|YM|WB)-', '') LIMIT 1) AS suggestion
     FROM order_lines l
     JOIN orders o ON o.id = l.order_id
     JOIN connections c ON c.id = o.connection_id
     WHERE l.sku IS NULL
     GROUP BY c.id, c.provider, c.name, l.external_sku
     ORDER BY orders_waiting DESC, l.external_sku`,
  );
}

export async function approveMappingTx(
  c: Client,
  actor: Actor,
  input: { connectionId: string; externalSku: string; sku: string; externalName?: string },
) {
  await setActorContext(c, actor, 'sku mapping approved');
  const connection = await one<any>(c, 'SELECT * FROM connections WHERE id=$1 FOR UPDATE', [input.connectionId]);
  const product = await maybeOne<any>(c, 'SELECT * FROM products WHERE sku=$1 AND active', [input.sku]);
  if (!product) fail(422, 'PRODUCT_NOT_FOUND', `Internal SKU ${input.sku} does not exist or is inactive`);
  const before = await maybeOne<any>(
    c,
    'SELECT * FROM sku_mappings WHERE connection_id=$1 AND external_sku=$2',
    [input.connectionId, input.externalSku],
  );
  await c.query(
    `INSERT INTO sku_mappings(id, connection_id, external_sku, external_name, sku, status, approved_by)
     VALUES($1,$2,$3,$4,$5,'APPROVED',$6)
     ON CONFLICT (connection_id, external_sku) DO UPDATE
       SET sku=EXCLUDED.sku, status='APPROVED', approved_by=EXCLUDED.approved_by,
           external_name=coalesce(EXCLUDED.external_name, sku_mappings.external_name), updated_at=now()`,
    [uid(), input.connectionId, input.externalSku, input.externalName ?? null, input.sku, actor.id],
  );

  // Repair every waiting line for this identifier in one statement.
  const repaired = await many<any>(
    c,
    `UPDATE order_lines l SET sku=$3
     FROM orders o
     WHERE o.id=l.order_id AND o.connection_id=$1 AND l.external_sku=$2 AND l.sku IS NULL
     RETURNING l.id, l.order_id`,
    [input.connectionId, input.externalSku, input.sku],
  );

  const repairedOrders: string[] = [];
  for (const orderId of [...new Set(repaired.map((row) => row.order_id))]) {
    const waiting = await maybeOne<{ n: number }>(
      c,
      'SELECT count(*)::int AS n FROM order_lines WHERE order_id=$1 AND sku IS NULL',
      [orderId],
    );
    if (Number(waiting?.n || 0) > 0) continue;
    const order = await one<any>(c, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
    if (order.status !== 'EXCEPTION') continue;
    await c.query(
      `UPDATE exceptions SET status='RESOLVED', resolved_by=$2, resolved_at=now(), resolution='SKU mapped and order repaired'
       WHERE status='OPEN' AND kind='SKU_UNMAPPED' AND entity_id=$1`,
      [orderId, actor.id],
    );
    await transitionOrder(c, actor, orderId, 'MAPPED', Number(order.version), { reason: 'sku mapping approved' });
    repairedOrders.push(orderId);
  }

  await audit(c, actor, 'sku.mapping_approved', 'sku_mapping', `${input.connectionId}:${input.externalSku}`, before, {
    external_sku: input.externalSku,
    sku: input.sku,
    repaired_orders: repairedOrders,
  });
  await emit(c, {
    topic: 'mapping.approved',
    aggregateType: 'sku_mapping',
    aggregateId: `${input.connectionId}:${input.externalSku}`,
    payload: {
      connection_id: input.connectionId,
      provider: connection.provider,
      external_sku: input.externalSku,
      sku: input.sku,
      repaired_orders: repairedOrders.length,
    },
  });
  return { external_sku: input.externalSku, sku: input.sku, repaired_orders: repairedOrders, repaired_lines: repaired.length };
}

export async function approveMapping(
  actor: Actor,
  input: { connectionId: string; externalSku: string; sku: string; externalName?: string },
) {
  return tx((c) => approveMappingTx(c, actor, input));
}

export async function listMappings(connectionId?: string) {
  return many(
    db,
    `SELECT m.*, c.provider, c.name AS connection_name, p.name AS product_name
     FROM sku_mappings m
     JOIN connections c ON c.id=m.connection_id
     JOIN products p ON p.sku=m.sku
     ${connectionId ? 'WHERE m.connection_id=$1' : ''}
     ORDER BY c.provider, m.external_sku`,
    connectionId ? [connectionId] : [],
  );
}

/** Map a missing identifier to a brand-new product in one audited step. */
export async function createProductAndMap(
  actor: Actor,
  input: {
    connectionId: string;
    externalSku: string;
    sku: string;
    name: string;
    category: string;
    costMinor: number;
    externalName?: string;
  },
) {
  return tx(async (c) => {
    const existing = await maybeOne(c, 'SELECT sku FROM products WHERE sku=$1', [input.sku]);
    if (existing) fail(409, 'SKU_EXISTS', `Product ${input.sku} already exists`);
    await c.query('INSERT INTO products(sku, name, category, cost_minor) VALUES($1,$2,$3,$4)', [
      input.sku,
      input.name,
      input.category,
      input.costMinor,
    ]);
    await audit(c, actor, 'product.created', 'product', input.sku, null, {
      name: input.name,
      category: input.category,
      cost_minor: input.costMinor,
    });
    return approveMappingTx(c, actor, input);
  });
}
