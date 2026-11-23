/**
 * Financial posting.
 *
 * Dispatch recognises revenue and relieves inventory at cost. Journals are
 * double-entry and balanced in the database (deferred constraint trigger), and
 * the ERP receives one idempotent posting per order. A failed ERP call retries
 * through the outbox; a succeeded one can be replayed safely under the same key.
 */
import { audit, db, emit, exception, many, maybeOne, one, tx, uid, type Client } from '../db/index.js';
import type { Actor } from '../config.js';

export async function recordSaleTx(c: Client, actor: Actor, orderId: string, shipmentId: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['finance:order:' + orderId]);
  const existing = await maybeOne<{ id: string }>(c, 'SELECT id FROM journal_entries WHERE order_id=$1 AND kind=$2', [
    orderId,
    'SALE',
  ]);
  if (existing) return { sale_id: existing.id, duplicate: true };

  const order = await one<any>(c, 'SELECT * FROM orders WHERE id=$1', [orderId]);
  const lines = await many<any>(
    c,
    `SELECT l.quantity, coalesce(p.cost_minor, 0) AS cost_minor
     FROM order_lines l LEFT JOIN products p ON p.sku=l.sku WHERE l.order_id=$1`,
    [orderId],
  );
  const revenue = Number(order.total_minor);
  const cogs = lines.reduce((sum, line) => sum + Number(line.quantity) * Number(line.cost_minor), 0);

  const saleId = uid();
  await c.query(
    `INSERT INTO journal_entries(id, order_id, shipment_id, kind, currency, amount_minor, posting_key)
     VALUES($1,$2,$3,'SALE','RUB',$4,$5)`,
    [saleId, orderId, shipmentId, revenue, `SALE:${orderId}`],
  );
  await c.query(
    `INSERT INTO journal_lines(id, entry_id, account, debit_minor, credit_minor, memo) VALUES
       ($1,$2,'1100',$3,0,'Marketplace receivable'),
       ($4,$2,'4000',0,$3,'Product revenue recognised at dispatch')`,
    [uid(), saleId, revenue, uid()],
  );

  if (cogs > 0) {
    const cogsId = uid();
    await c.query(
      `INSERT INTO journal_entries(id, order_id, shipment_id, kind, currency, amount_minor, posting_key)
       VALUES($1,$2,$3,'COGS','RUB',$4,$5)`,
      [cogsId, orderId, shipmentId, cogs, `COGS:${orderId}`],
    );
    await c.query(
      `INSERT INTO journal_lines(id, entry_id, account, debit_minor, credit_minor, memo) VALUES
         ($1,$2,'5000',$3,0,'Cost of goods sold'),
         ($4,$2,'1200',0,$3,'Inventory relieved')`,
      [uid(), cogsId, cogs, uid()],
    );
  } else {
    await exception(c, {
      kind: 'COST_MISSING',
      severity: 'LOW',
      entityType: 'order',
      entityId: orderId,
      message: 'No product cost available; COGS entry was not created',
      details: { revenue },
    });
  }

  const request = {
    order_id: orderId,
    external_id: order.external_id,
    shipment_id: shipmentId,
    currency: 'RUB',
    revenue_minor: revenue,
    cogs_minor: cogs,
    entries: [
      { kind: 'SALE', debit: '1100', credit: '4000', amount_minor: revenue },
      ...(cogs > 0 ? [{ kind: 'COGS', debit: '5000', credit: '1200', amount_minor: cogs }] : []),
    ],
  };
  const postingId = uid();
  await c.query(
    `INSERT INTO erp_postings(id, order_id, idempotency_key, amount_minor, currency, request)
     VALUES($1,$2,$3,$4,'RUB',$5)`,
    [postingId, orderId, `erp:order:${orderId}`, revenue, JSON.stringify(request)],
  );
  await audit(c, actor, 'finance.journal_created', 'order', orderId, null, {
    sale_id: saleId,
    revenue_minor: revenue,
    cogs_minor: cogs,
    posting_id: postingId,
  });
  await emit(c, {
    topic: 'erp.post',
    aggregateType: 'order',
    aggregateId: orderId,
    payload: { order_id: orderId, posting_id: postingId, revenue_minor: revenue },
  });
  return { sale_id: saleId, posting_id: postingId, revenue_minor: revenue, cogs_minor: cogs, duplicate: false };
}

export async function listJournals(limit = 300) {
  return many(
    db,
    `SELECT j.*, o.external_id, o.status AS order_status,
            (SELECT json_agg(jl ORDER BY jl.debit_minor DESC) FROM journal_lines jl WHERE jl.entry_id=j.id) AS lines,
            (SELECT e.status FROM erp_postings e WHERE e.order_id=j.order_id ORDER BY e.created_at DESC LIMIT 1) AS erp_status,
            (SELECT e.response FROM erp_postings e WHERE e.order_id=j.order_id ORDER BY e.created_at DESC LIMIT 1) AS erp_response
     FROM journal_entries j JOIN orders o ON o.id=j.order_id
     ORDER BY j.created_at DESC LIMIT ${Number(limit) || 300}`,
  );
}

export async function financeSummary() {
  const [totals, postings] = await Promise.all([
    many<{ kind: string; n: number; amount: number }>(
      db,
      `SELECT kind, count(*)::int AS n, coalesce(sum(amount_minor),0)::bigint AS amount
       FROM journal_entries GROUP BY kind ORDER BY kind`,
    ),
    many<{ status: string; n: number }>(db, `SELECT status, count(*)::int AS n FROM erp_postings GROUP BY status`),
  ]);
  return { journals: totals, postings };
}

export async function markErpPostingAck(
  c: Client,
  postingId: string,
  actor: Actor,
  response: unknown,
  reference: string,
): Promise<void> {
  const posting = await one<any>(c, 'SELECT * FROM erp_postings WHERE id=$1 FOR UPDATE', [postingId]);
  if (posting.status === 'ACK') return;
  await c.query(
    `UPDATE erp_postings SET status='ACK', response=$2, acked_at=now(), attempts=attempts+1, last_error=NULL WHERE id=$1`,
    [postingId, JSON.stringify(response)],
  );
  await c.query(
    `UPDATE journal_entries SET status='POSTED', erp_reference=$2, posted_at=now()
     WHERE order_id=$1 AND status='DRAFT'`,
    [posting.order_id, reference],
  );
  await audit(c, actor, 'erp.posted', 'order', posting.order_id, null, { posting_id: postingId, reference });
  await emit(c, {
    topic: 'finance.posted',
    aggregateType: 'order',
    aggregateId: posting.order_id,
    payload: { order_id: posting.order_id, posting_id: postingId, reference },
  });
}

export async function markErpPostingFailed(c: Client, postingId: string, error: string): Promise<void> {
  await c.query(
    `UPDATE erp_postings SET attempts=attempts+1, last_error=$2, status=CASE WHEN attempts+1 >= 6 THEN 'FAILED' ELSE 'PENDING' END
     WHERE id=$1`,
    [postingId, error.slice(0, 500)],
  );
}

export async function reconciliationFinance() {
  const missing = await many<any>(
    db,
    `SELECT o.id, o.external_id FROM orders o
     WHERE o.status IN ('SHIPPED','DELIVERED')
       AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.order_id=o.id)
     LIMIT 100`,
  );
  const unposted = await many<any>(
    db,
    `SELECT e.id, e.order_id, e.last_error, e.attempts FROM erp_postings e
     WHERE e.status <> 'ACK' AND e.created_at < now() - interval '5 minutes' LIMIT 100`,
  );
  for (const order of missing) {
    await tx((c) =>
      exception(c, {
        kind: 'FINANCE_MISSING',
        severity: 'HIGH',
        entityType: 'order',
        entityId: order.id,
        message: `Shipped order ${order.external_id} has no financial journal`,
        details: { external_id: order.external_id },
      }),
    );
  }
  for (const posting of unposted) {
    await tx((c) =>
      exception(c, {
        kind: 'ERP_POSTING_STALE',
        severity: posting.attempts >= 5 ? 'HIGH' : 'MEDIUM',
        entityType: 'erp_posting',
        entityId: posting.id,
        message: `ERP posting has not been acknowledged after ${posting.attempts} attempt(s)`,
        details: { order_id: posting.order_id, last_error: posting.last_error },
        replayable: true,
      }),
    );
  }
  return { missing_journals: missing.length, stale_postings: unposted.length };
}

export async function assertLedgerAndInventoryMatch() {
  const drift = await many<any>(
    db,
    `WITH latest AS (
       SELECT DISTINCT ON (sku, location) sku, location, balance_on_hand, balance_reserved, balance_damaged
       FROM stock_ledger ORDER BY sku, location, id DESC
     )
     SELECT i.sku, i.location, i.on_hand, i.reserved, i.damaged,
            l.balance_on_hand, l.balance_reserved, l.balance_damaged
     FROM inventory i LEFT JOIN latest l ON l.sku=i.sku AND l.location=i.location
     WHERE l.sku IS NULL OR i.on_hand <> l.balance_on_hand OR i.reserved <> l.balance_reserved
        OR i.damaged <> l.balance_damaged
     LIMIT 100`,
  );
  for (const row of drift) {
    await tx((c) =>
      exception(c, {
        kind: 'INVENTORY_LEDGER_DRIFT',
        severity: 'CRITICAL',
        entityType: 'inventory',
        entityId: `${row.sku}:${row.location}`,
        message: `Inventory position disagrees with its ledger (on_hand ${row.on_hand} vs ${row.balance_on_hand})`,
        details: row,
      }),
    );
  }
  return drift.length;
}

export async function assertReservationsMatchStock() {
  const drift = await many<any>(
    db,
    `WITH reserved AS (
       SELECT sku, location, sum(quantity)::bigint AS n FROM reservations WHERE status='ACTIVE' GROUP BY sku, location
     )
     SELECT i.sku, i.location, i.reserved, coalesce(r.n,0) AS reservation_sum
     FROM inventory i LEFT JOIN reserved r ON r.sku=i.sku AND r.location=i.location
     WHERE i.reserved <> coalesce(r.n,0) LIMIT 100`,
  );
  for (const row of drift) {
    await tx((c) =>
      exception(c, {
        kind: 'RESERVATION_DRIFT',
        severity: 'CRITICAL',
        entityType: 'inventory',
        entityId: `${row.sku}:${row.location}`,
        message: `Reserved quantity (${row.reserved}) does not match active reservations (${row.reservation_sum})`,
        details: row,
      }),
    );
  }
  return drift.length;
}
