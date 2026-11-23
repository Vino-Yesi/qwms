/**
 * Scheduled integrity reconciliation.
 *
 * These are not dashboards: each check either proves a ledger-level invariant or
 * files an exception with the exact entity an operator needs to fix. Drift is
 * never auto-corrected.
 */
import { db, exception, insertReconciliationRun, many, maybeOne, tx } from './db/index.js';
import { config } from './config.js';
import {
  assertLedgerAndInventoryMatch,
  assertReservationsMatchStock,
  reconciliationFinance,
} from './domain/finance.js';
import { flagAtRiskOrders } from './domain/orders.js';

export async function runReconciliation(): Promise<{
  inventory_drift: number;
  reservation_drift: number;
  finance: { missing_journals: number; stale_postings: number };
  stale_connectors: number;
}> {
  const started = Date.now();
  const [inventoryDrift, reservationDrift, finance] = await Promise.all([
    assertLedgerAndInventoryMatch(),
    assertReservationsMatchStock(),
    reconciliationFinance(),
  ]);
  await flagAtRiskOrders();

  const stale = await many<any>(
    db,
    `SELECT id, provider, name FROM connections
     WHERE status='enabled' AND (last_sync_at IS NULL OR last_sync_at < now() - interval '15 minutes')`,
  );
  for (const connection of stale) {
    await tx((c) =>
      exception(c, {
        kind: 'CONNECTOR_STALE',
        severity: 'MEDIUM',
        entityType: 'connection',
        entityId: connection.id,
        message: `${connection.provider} (${connection.name}) has not synchronised in over 15 minutes`,
        details: { provider: connection.provider },
        replayable: true,
      }),
    );
  }

  const findings = inventoryDrift + reservationDrift + finance.missing_journals + finance.stale_postings + stale.length;
  await insertReconciliationRun({
    kind: 'inventory',
    status: inventoryDrift + reservationDrift === 0 ? 'OK' : 'DRIFT',
    findings: inventoryDrift + reservationDrift,
    details: { inventory_drift: inventoryDrift, reservation_drift: reservationDrift },
    durationMs: Date.now() - started,
  });
  await insertReconciliationRun({
    kind: 'finance',
    status: findings === 0 ? 'OK' : 'DRIFT',
    findings: findings,
    details: { finance, stale_connectors: stale.length },
    durationMs: Date.now() - started,
  });

  if (config.development) {
    console.log(
      JSON.stringify({
        level: 'info',
        component: 'reconciliation',
        inventory_drift: inventoryDrift,
        reservation_drift: reservationDrift,
        finance,
        stale_connectors: stale.length,
      }),
    );
  }
  return {
    inventory_drift: inventoryDrift,
    reservation_drift: reservationDrift,
    finance,
    stale_connectors: stale.length,
  };
}

export async function latestReconciliation() {
  return many(db, 'SELECT * FROM reconciliation_runs ORDER BY started_at DESC LIMIT 20');
}

export async function outboxAge() {
  return maybeOne<{ oldest: number | null; dead: number }>(
    db,
    `SELECT extract(epoch FROM now() - min(created_at) FILTER (WHERE status='PENDING'))::int AS oldest,
            count(*) FILTER (WHERE status='DEAD')::int AS dead FROM outbox`,
  );
}
