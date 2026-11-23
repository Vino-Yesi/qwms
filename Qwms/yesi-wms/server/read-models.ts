/**
 * Read models for the API and control tower. These queries never mutate and
 * always include the operational context an operator needs to act: connector,
 * units, SLA state, queue depth and diagnostics.
 */
import { db, many, maybeOne, verifyAudit } from './db/index.js';
import { listConnections } from './integrations/hub.js';
import { listPendingMappings, listMappings } from './domain/mapping.js';
import { workerHealth } from './worker.js';
import { latestReconciliation } from './reconcile.js';

const TERMINAL = `('SHIPPED','DELIVERED','CANCELLED','RETURNED')`;

export async function listOrders(filter: {
  status?: string;
  provider?: string;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const limit = Math.min(500, Math.max(1, filter.limit ?? 200));
  const offset = Math.max(0, filter.offset ?? 0);
  const rows = await many(
    db,
    `SELECT o.*, c.provider, c.name AS connection_name, c.mode,
            (SELECT coalesce(sum(quantity),0)::int FROM order_lines l WHERE l.order_id=o.id) AS units,
            (SELECT count(*)::int FROM order_lines l WHERE l.order_id=o.id AND l.sku IS NULL) AS unmapped_lines,
            (o.ship_by < now() AND o.status NOT IN ${TERMINAL}) AS overdue
     FROM orders o JOIN connections c ON c.id=o.connection_id
     WHERE ($1::text IS NULL OR o.status=$1)
       AND ($2::text IS NULL OR c.provider=$2)
       AND ($3::text IS NULL OR o.external_id ILIKE '%'||$3||'%' OR o.customer_ref ILIKE '%'||$3||'%')
     ORDER BY o.created_at DESC
     LIMIT $4 OFFSET $5`,
    [filter.status || null, filter.provider || null, filter.search || null, limit, offset],
  );
  return { items: rows, limit, offset };
}

export async function listInventory() {
  return many(
    db,
    `SELECT i.*, p.name, p.category, p.cost_minor,
            i.on_hand - i.reserved - i.damaged AS available,
            i.on_hand * p.cost_minor AS value_minor
     FROM inventory i JOIN products p ON p.sku=i.sku
     ORDER BY p.category, i.sku, i.location`,
  );
}

export async function listWaves() {
  return many(
    db,
    `SELECT w.*,
            (SELECT count(*)::int FROM wave_orders wo WHERE wo.wave_id=w.id) AS order_count,
            (SELECT count(*)::int FROM pick_tasks t WHERE t.wave_id=w.id) AS tasks_total,
            (SELECT count(*)::int FROM pick_tasks t WHERE t.wave_id=w.id AND t.status='PENDING') AS tasks_pending,
            (SELECT coalesce(json_agg(wo.order_id),'[]'::json) FROM wave_orders wo WHERE wo.wave_id=w.id) AS order_ids
     FROM waves w ORDER BY w.created_at DESC LIMIT 50`,
  );
}

export async function listShipments() {
  return many(
    db,
    `SELECT s.*, o.external_id, o.status AS order_status, o.ship_by, c.provider,
            (SELECT count(*)::int FROM shipment_events e WHERE e.shipment_id=s.id) AS event_count
     FROM shipments s
     JOIN orders o ON o.id=s.order_id
     JOIN connections c ON c.id=o.connection_id
     ORDER BY s.created_at DESC LIMIT 200`,
  );
}

export async function listExceptions(status = 'OPEN') {
  return many(
    db,
    `SELECT e.*, u.email AS resolved_by_email
     FROM exceptions e LEFT JOIN users u ON u.id=e.resolved_by
     WHERE ($1::text IS NULL OR e.status=$1)
     ORDER BY CASE e.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
              e.created_at DESC
     LIMIT 300`,
    [status || null],
  );
}

export async function listAsns() {
  return many(
    db,
    `SELECT a.*,
            (SELECT coalesce(json_agg(l ORDER BY l.sku),'[]'::json) FROM asn_lines l WHERE l.asn_id=a.id) AS lines,
            (SELECT coalesce(sum(expected),0)::int FROM asn_lines l WHERE l.asn_id=a.id) AS units_expected,
            (SELECT coalesce(sum(received),0)::int FROM asn_lines l WHERE l.asn_id=a.id) AS units_received
     FROM asns a ORDER BY a.created_at DESC LIMIT 80`,
  );
}

export async function listStockCounts(status = 'OPEN') {
  return many(
    db,
    `SELECT sc.*, p.name FROM stock_counts sc JOIN products p ON p.sku=sc.sku
     WHERE ($1::text IS NULL OR sc.status=$1) ORDER BY sc.created_at DESC LIMIT 100`,
    [status || null],
  );
}

export async function listOutbox(status?: string, limit = 200) {
  return many(
    db,
    `SELECT seq, id, topic, aggregate_type, aggregate_id, payload, status, attempts, max_attempts,
            next_attempt_at, last_error, created_at, processed_at
     FROM outbox ${status ? 'WHERE status=$1' : ''}
     ORDER BY seq DESC LIMIT ${Math.min(500, Math.max(1, limit))}`,
    status ? [status] : [],
  );
}

export async function outboxTopics() {
  return many(
    db,
    `SELECT topic,
            count(*) FILTER (WHERE status='PENDING')::int AS pending,
            count(*) FILTER (WHERE status='PROCESSING')::int AS processing,
            count(*) FILTER (WHERE status='DEAD')::int AS dead,
            count(*) FILTER (WHERE status='DONE')::int AS done,
            max(seq)::int AS last_seq
     FROM outbox GROUP BY topic ORDER BY topic`,
  );
}

export async function listAudit(after = 0, limit = 100) {
  return many(db, 'SELECT * FROM audit_logs WHERE seq>$1 ORDER BY seq LIMIT $2', [after, Math.min(500, Math.max(1, limit))]);
}

let auditCache: { at: number; value: Awaited<ReturnType<typeof verifyAudit>> } | null = null;
export async function auditStatus(force = false) {
  if (force || !auditCache || Date.now() - auditCache.at > 30_000) {
    auditCache = { at: Date.now(), value: await verifyAudit() };
  }
  return auditCache.value;
}

export async function kpis() {
  const row = await oneKpi();
  const byStatus = await many(
    db,
    `SELECT status, count(*)::int AS n FROM orders GROUP BY status ORDER BY n DESC`,
  );
  const byProvider = await many(
    db,
    `SELECT c.provider, count(*)::int AS orders,
            count(*) FILTER (WHERE o.status='EXCEPTION')::int AS exceptions
     FROM orders o JOIN connections c ON c.id=o.connection_id GROUP BY c.provider`,
  );
  return { ...row, by_status: byStatus, by_provider: byProvider };
}

async function oneKpi() {
  const row = await maybeOne<any>(
    db,
    `SELECT
       (SELECT count(*)::int FROM orders WHERE status NOT IN ${TERMINAL}) AS open_orders,
       (SELECT count(*)::int FROM orders WHERE created_at::date=current_date) AS orders_today,
       (SELECT count(*)::int FROM orders WHERE status IN ('SHIPPED','DELIVERED') AND updated_at::date=current_date) AS shipped_today,
       (SELECT count(*)::int FROM orders WHERE status='EXCEPTION') AS exception_orders,
       (SELECT count(*)::int FROM exceptions WHERE status='OPEN') AS open_exceptions,
       (SELECT count(*)::int FROM outbox WHERE status='DEAD') AS dead_events,
       (SELECT count(*)::int FROM outbox WHERE status='PENDING') AS pending_events,
       (SELECT count(*)::int FROM orders WHERE ship_by < now() AND status NOT IN ${TERMINAL}) AS overdue_orders,
       (SELECT coalesce(sum(on_hand-reserved-damaged),0)::int FROM inventory) AS available_units,
       (SELECT coalesce(sum(reserved),0)::int FROM inventory) AS reserved_units,
       (SELECT coalesce(sum(i.on_hand * p.cost_minor),0)::bigint FROM inventory i JOIN products p ON p.sku=i.sku) AS inventory_value_minor,
       (SELECT count(*)::int FROM pick_tasks WHERE status='PENDING') AS pending_picks,
       (SELECT count(*)::int FROM waves WHERE status<>'COMPLETE') AS open_waves,
       (SELECT coalesce(max(seq),0)::int FROM outbox) AS sequence,
       (SELECT count(*)::int FROM connections WHERE status='enabled') AS active_connections,
       (SELECT count(*)::int FROM connections) AS total_connections,
       (SELECT count(*)::int FROM orders WHERE status IN ('SHIPPED','DELIVERED') AND updated_at > now() - interval '24 hours') AS shipped_24h`,
  );
  return row ?? {};
}

export async function snapshot() {
  const [orderPage, inventory, connections, waves, shipments, exceptions, mappings, pendingMappings, asns, counts, kpi, worker, connectorHealth, audit, reconciliation] =
    await Promise.all([
      listOrders({ limit: 400 }),
      listInventory(),
      listConnections(),
      listWaves(),
      listShipments(),
      listExceptions('OPEN'),
      listMappings(),
      listPendingMappings(),
      listAsns(),
      listStockCounts('OPEN'),
      kpis(),
      workerHealth(),
      many(db, 'SELECT * FROM v_connector_health ORDER BY provider'),
      auditStatus(),
      latestReconciliation(),
    ]);
  return {
    sequence: Number(kpi.sequence || 0),
    server_time: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    kpis: kpi,
    orders: orderPage.items,
    inventory,
    connections,
    waves,
    shipments,
    exceptions,
    mappings,
    pending_mappings: pendingMappings,
    asns,
    stock_counts: counts,
    worker,
    connector_health: connectorHealth,
    audit,
    reconciliation: reconciliation[0] ?? null,
  };
}

/** Live integrity report: proofs, not dashboards. */
export async function reconciliationReport() {
  const [ledgerDrift, reservationDrift, missingJournals, stalePostings, runs, deadEvents] = await Promise.all([
    many(
      db,
      `WITH latest AS (
         SELECT DISTINCT ON (sku, location) sku, location, balance_on_hand, balance_reserved, balance_damaged
         FROM stock_ledger ORDER BY sku, location, id DESC
       )
       SELECT i.sku, i.location, i.on_hand, i.reserved, i.damaged,
              l.balance_on_hand, l.balance_reserved, l.balance_damaged
       FROM inventory i LEFT JOIN latest l ON l.sku=i.sku AND l.location=i.location
       WHERE l.sku IS NULL OR i.on_hand <> l.balance_on_hand OR i.reserved <> l.balance_reserved
       LIMIT 200`,
    ),
    many(
      db,
      `WITH reserved AS (SELECT sku, location, sum(quantity)::bigint AS n FROM reservations WHERE status='ACTIVE' GROUP BY sku, location)
       SELECT i.sku, i.location, i.reserved, coalesce(r.n,0) AS reservation_sum
       FROM inventory i LEFT JOIN reserved r ON r.sku=i.sku AND r.location=i.location
       WHERE i.reserved <> coalesce(r.n,0) LIMIT 200`,
    ),
    many(
      db,
      `SELECT o.id, o.external_id FROM orders o
       WHERE o.status IN ('SHIPPED','DELIVERED')
         AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.order_id=o.id) LIMIT 200`,
    ),
    many(
      db,
      `SELECT id, order_id, status, attempts, last_error FROM erp_postings WHERE status <> 'ACK' LIMIT 200`,
    ),
    latestReconciliation(),
    many(db, `SELECT seq, id, topic, attempts, last_error FROM outbox WHERE status='DEAD' ORDER BY seq DESC LIMIT 100`),
  ]);
  return {
    checked_at: new Date().toISOString(),
    ledger_drift: ledgerDrift,
    reservation_drift: reservationDrift,
    missing_journals: missingJournals,
    stale_postings: stalePostings,
    dead_events: deadEvents,
    runs: runs,
    balanced:
      ledgerDrift.length + reservationDrift.length + missingJournals.length + stalePostings.length + deadEvents.length === 0,
  };
}
