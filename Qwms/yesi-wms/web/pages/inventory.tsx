import { useEffect, useMemo, useState } from 'react';
import { api, amount, money, relative, titleCase } from '../api';
import { Badge, Drawer, Empty, Field, Icon, Meta, Metric, Modal, Panel, Progress, Status, Table } from '../components';
import type { Ctx, InventoryRow, StockCount } from '../types';

export function Inventory({ ctx }: { ctx: Ctx }) {
  const [query, setQuery] = useState('');
  const [zone, setZone] = useState('all');
  const [sku, setSku] = useState<string | null>(ctx.params.sku || null);
  const [ledger, setLedger] = useState<any[] | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [countOpen, setCountOpen] = useState(false);
  const [preset, setPreset] = useState<InventoryRow | null>(null);

  const zones = useMemo(() => Array.from(new Set(ctx.data.inventory.map((row) => row.location.split('-')[0]))).sort(), [ctx.data.inventory]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...ctx.data.inventory]
      .filter((row) => zone === 'all' || row.location.startsWith(zone + '-'))
      .filter((row) => !needle || row.sku.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle) || row.location.toLowerCase().includes(needle))
      .sort((a, b) => a.sku.localeCompare(b.sku) || a.location.localeCompare(b.location));
  }, [ctx.data.inventory, query, zone]);

  const totals = useMemo(() => {
    const sellable = ctx.data.inventory.reduce((sum, row) => sum + Number(row.available), 0);
    const onHand = ctx.data.inventory.reduce((sum, row) => sum + Number(row.on_hand), 0);
    const reserved = ctx.data.inventory.reduce((sum, row) => sum + Number(row.reserved), 0);
    const damaged = ctx.data.inventory.reduce((sum, row) => sum + Number(row.damaged), 0);
    const value = ctx.data.inventory.reduce((sum, row) => sum + Number(row.value_minor), 0);
    const stockoutRisk = ctx.data.inventory.filter((row) => row.available <= row.safety_stock).length;
    return { sellable, onHand, reserved, damaged, value, stockoutRisk };
  }, [ctx.data.inventory]);

  useEffect(() => {
    if (!sku) {
      setLedger(null);
      return;
    }
    let active = true;
    api<any>(`/inventory/ledger?sku=${encodeURIComponent(sku)}&limit=60`)
      .then((value) => active && setLedger(Array.isArray(value) ? value : value.items || []))
      .catch((error) => ctx.notify(error.message, 'error'));
    return () => {
      active = false;
    };
  }, [sku, ctx.data.sequence]);

  const openCounts = ctx.data.stock_counts.filter((count) => count.status === 'OPEN');

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Inventory ledger</div>
          <h1>Stock & locations</h1>
          <p>On-hand quantities are projections of an append-only ledger. Reservations are never deleted, only consumed or released.</p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => { setPreset(rows[0] || null); setCountOpen(true); }} disabled={!ctx.can('stock')}>
            <Icon name="check" size={14} /> Cycle count
          </button>
          <button className="btn primary" onClick={() => { setPreset(rows[0] || null); setAdjustOpen(true); }} disabled={!ctx.can('supervise')}>
            <Icon name="plus" size={14} /> Adjust stock
          </button>
        </div>
      </div>

      <div className="metrics">
        <Metric label="Units on hand" value={amount(totals.onHand)} icon="box" sub={`${ctx.data.inventory.length} positions`} />
        <Metric label="Sellable now" value={amount(totals.sellable)} icon="layers" tone="good" sub={`${amount(totals.reserved)} reserved`} />
        <Metric label="Damaged / hold" value={amount(totals.damaged)} icon="alert" tone={totals.damaged ? 'warn' : 'default'} sub={`${totals.stockoutRisk} at safety stock`} />
        <Metric label="Inventory value" value={money(totals.value)} icon="finance" sub="weighted cost basis" />
      </div>

      <Panel
        title="Positions"
        subtitle="Click a row to inspect its movement history"
        flush
        action={<Badge tone="slate">{rows.length} rows</Badge>}
      >
        <div className="toolbar" style={{ padding: '10px 16px 0' }}>
          <div className="search">
            <Icon name="search" size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="SKU, product, location…" aria-label="Search inventory" />
          </div>
          <div className="row tight">
            <button className={'btn sm ' + (zone === 'all' ? 'primary' : 'ghost')} onClick={() => setZone('all')}>All zones</button>
            {zones.map((id) => (
              <button key={id} className={'btn sm ' + (zone === id ? 'primary' : 'ghost')} onClick={() => setZone(id)}>
                Zone {id}
              </button>
            ))}
          </div>
        </div>

        <Table
          columns={[
            { key: 'sku', label: 'Product' },
            { key: 'location', label: 'Location' },
            { key: 'onhand', label: 'On hand', align: 'right' },
            { key: 'reserved', label: 'Reserved', align: 'right' },
            { key: 'available', label: 'Available', align: 'right' },
            { key: 'coverage', label: 'Position' },
            { key: 'value', label: 'Value', align: 'right' },
          ]}
          rows={rows}
          rowKey={(row: InventoryRow) => `${row.sku}:${row.location}`}
          onRow={(row: InventoryRow) => setSku(row.sku)}
          height={520}
          dense
          empty={<Empty title="No stock in this zone" />}
          render={(row: InventoryRow) => (
            <>
              <td>
                <div className="cell-primary">{row.name}</div>
                <div className="cell-sub mono">{row.sku} · {row.category}</div>
              </td>
              <td className="mono small">{row.location}</td>
              <td className="right mono">{amount(row.on_hand)}</td>
              <td className="right mono muted">{amount(row.reserved)}</td>
              <td className="right mono">{amount(row.available)}</td>
              <td style={{ minWidth: 110 }}>
                <Progress value={Number(row.available)} max={Math.max(1, Number(row.on_hand))} tone={Number(row.available) === 0 ? 'red' : 'accent'} />
                <div className="tiny faint" style={{ marginTop: 4 }}>{row.safety_stock > 0 ? `safety ${row.safety_stock}` : 'no safety stock'}</div>
              </td>
              <td className="right mono tiny">{money(row.value_minor)}</td>
            </>
          )}
        />
      </Panel>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)' }}>
        <Panel title="Cycle counts" subtitle="Variances stay open until a supervisor approves the adjustment" flush>
          {ctx.data.stock_counts.length === 0 ? (
            <Empty title="No counts yet" hint="Record a count from the toolbar to create an independent check." />
          ) : (
            <Table
              columns={[
                { key: 'sku', label: 'SKU' },
                { key: 'location', label: 'Location' },
                { key: 'expected', label: 'Expected', align: 'right' },
                { key: 'counted', label: 'Counted', align: 'right' },
                { key: 'variance', label: 'Variance', align: 'right' },
                { key: 'status', label: 'Status' },
                { key: 'when', label: 'When', align: 'right' },
              ]}
              rows={ctx.data.stock_counts}
              rowKey={(row: StockCount) => row.id}
              height={300}
              dense
              render={(row: StockCount) => (
                <>
                  <td>
                    <div className="small">{row.name}</div>
                    <div className="tiny faint mono">{row.sku}</div>
                  </td>
                  <td className="mono small">{row.location}</td>
                  <td className="right mono">{row.expected_on_hand}</td>
                  <td className="right mono">{row.counted}</td>
                  <td className={'right mono ' + (row.variance === 0 ? '' : row.variance < 0 ? 'red' : 'green')}>
                    {row.variance > 0 ? '+' : ''}{row.variance}
                  </td>
                  <td>
                    <Status value={row.status} />
                  </td>
                  <td className="right">
                    {row.status === 'OPEN' && ctx.can('supervise') ? (
                      <button
                        className="btn xs"
                        onClick={async (event) => {
                          event.stopPropagation();
                          await ctx.mutate(`/stock-counts/${row.id}/approve`, {}, { success: 'Count variance approved' });
                          await ctx.refresh(true);
                        }}
                      >
                        Approve
                      </button>
                    ) : (
                      <span className="tiny faint">{relative(row.approved_at || row.created_at)}</span>
                    )}
                  </td>
                </>
              )}
            />
          )}
        </Panel>

        <Panel title="Position health" subtitle="Where the risk sits">
          <div className="stack tight">
            <div className="between small">
              <span className="muted">Reserved share</span>
              <span className="mono">{totals.onHand ? Math.round((totals.reserved / totals.onHand) * 100) : 0}%</span>
            </div>
            <Progress value={totals.reserved} max={Math.max(1, totals.onHand)} />
            <div className="between small" style={{ marginTop: 8 }}>
              <span className="muted">Damaged share</span>
              <span className="mono">{totals.onHand ? ((totals.damaged / totals.onHand) * 100).toFixed(1) : '0.0'}%</span>
            </div>
            <Progress value={totals.damaged} max={Math.max(1, totals.onHand)} tone="amber" />
            <div className="divider" />
            <div className="between small">
              <span className="muted">Open counts</span>
              <span className="mono">{openCounts.length}</span>
            </div>
            <div className="between small">
              <span className="muted">Below safety stock</span>
              <span className={'mono ' + (totals.stockoutRisk ? 'red' : '')}>{totals.stockoutRisk}</span>
            </div>
          </div>
          <div className="hint-box" style={{ marginTop: 14 }}>
            Every movement carries a unique request key. Replaying a receipt or adjustment cannot double-count stock.
          </div>
        </Panel>
      </div>

      {sku && (
        <Drawer
          title={<span className="mono">{sku}</span>}
          subtitle={rows.find((row) => row.sku === sku)?.name || 'Stock ledger'}
          onClose={() => setSku(null)}
          footer={
            <>
              <button className="btn" onClick={() => { setPreset(rows.find((row) => row.sku === sku) || null); setCountOpen(true); }}>Count</button>
              <button className="btn primary" onClick={() => { setPreset(rows.find((row) => row.sku === sku) || null); setAdjustOpen(true); }}>Adjust</button>
            </>
          }
        >
          {!ledger ? (
            <div className="skeleton" style={{ height: 200 }} />
          ) : (
            <div className="stack">
              <Meta
                items={(() => {
                  const first = rows.find((row) => row.sku === sku);
                  return first
                    ? [
                        { label: 'On hand', value: <span className="mono">{amount(first.on_hand)}</span> },
                        { label: 'Reserved', value: <span className="mono">{amount(first.reserved)}</span> },
                        { label: 'Available', value: <span className="mono">{amount(first.available)}</span> },
                      ]
                    : [];
                })()}
              />
              <div>
                <div className="section-title">Ledger entries</div>
                <Table
                  columns={[
                    { key: 'when', label: 'When' },
                    { key: 'kind', label: 'Movement' },
                    { key: 'qty', label: 'Δ', align: 'right' },
                    { key: 'balance', label: 'Balance', align: 'right' },
                    { key: 'ref', label: 'Reference' },
                  ]}
                  rows={ledger}
                  rowKey={(row: any) => String(row.id)}
                  height={420}
                  dense
                  empty={<Empty title="No movements recorded" />}
                  render={(row: any) => (
                    <>
                      <td className="tiny faint nowrap">{new Date(row.created_at).toLocaleString('en-GB')}</td>
                      <td>
                        <div className="small">{titleCase(row.reason || 'movement')}</div>
                        <div className="tiny faint mono">{row.location}</div>
                      </td>
                      <td className={'right mono ' + (Number(row.delta_on_hand) < 0 ? 'red' : 'green')}>
                        {Number(row.delta_on_hand) > 0 ? '+' : ''}{row.delta_on_hand}
                        {Number(row.delta_reserved) ? <div className="tiny faint">res {Number(row.delta_reserved) > 0 ? '+' : ''}{row.delta_reserved}</div> : null}
                      </td>
                      <td className="right mono small">{amount(row.balance_on_hand)}</td>
                      <td className="tiny faint mono truncate" style={{ maxWidth: 150 }} title={row.request_key}>{row.reference || '—'}</td>
                    </>
                  )}
                />
              </div>
            </div>
          )}
        </Drawer>
      )}

      {adjustOpen && (
        <AdjustModal
          rows={rows}
          preset={preset}
          onClose={() => setAdjustOpen(false)}
          onSubmit={async (body) => {
            await ctx.mutate('/inventory/adjust', body, { success: 'Stock adjusted and ledgered' });
            await ctx.refresh(true);
            setAdjustOpen(false);
          }}
        />
      )}
      {countOpen && (
        <CountModal
          rows={rows}
          preset={preset}
          onClose={() => setCountOpen(false)}
          onSubmit={async (body) => {
            await ctx.mutate('/inventory/counts', body, { success: 'Count recorded' });
            await ctx.refresh(true);
            setCountOpen(false);
          }}
        />
      )}
    </div>
  );
}

function AdjustModal({ rows, preset, onClose, onSubmit }: { rows: InventoryRow[]; preset: InventoryRow | null; onClose: () => void; onSubmit: (body: any) => Promise<void> }) {
  const [key, setKey] = useState(preset ? `${preset.sku}:${preset.location}` : '');
  const row = rows.find((item) => `${item.sku}:${item.location}` === key) || null;
  const [delta, setDelta] = useState('-1');
  const [reason, setReason] = useState('DAMAGE');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Adjust stock"
      subtitle="Supervisor-only correction. Creates a ledger entry with an explicit reason."
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!row || !Number(delta) || busy}
            onClick={async () => {
              if (!row) return;
              setBusy(true);
              await onSubmit({ sku: row.sku, location: row.location, delta: Number(delta), reason, note: note || undefined });
              setBusy(false);
            }}
          >
            {busy ? 'Posting…' : 'Post adjustment'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Position">
          <select className="select" value={key} onChange={(event) => setKey(event.target.value)}>
            <option value="">Select a position…</option>
            {rows.map((item) => (
              <option key={`${item.sku}:${item.location}`} value={`${item.sku}:${item.location}`}>
                {item.sku} @ {item.location} — {item.on_hand} on hand
              </option>
            ))}
          </select>
        </Field>
        <div className="row">
          <Field label="Delta" hint="Negative removes stock.">
            <input className="input" type="number" value={delta} onChange={(event) => setDelta(event.target.value)} />
          </Field>
          <Field label="Reason">
            <select className="select" value={reason} onChange={(event) => setReason(event.target.value)}>
              <option value="DAMAGE">Damage</option>
              <option value="FOUND">Found</option>
              <option value="LOST">Lost</option>
              <option value="SUPPLIER_SHORTAGE">Supplier shortage</option>
              <option value="MANUAL_CORRECTION">Manual correction</option>
            </select>
          </Field>
        </div>
        <Field label="Note" hint="Optional but recommended for the audit trail.">
          <input className="input" value={note} onChange={(event) => setNote(event.target.value)} placeholder="e.g. crushed carton, bay 3" />
        </Field>
      </div>
    </Modal>
  );
}

function CountModal({ rows, preset, onClose, onSubmit }: { rows: InventoryRow[]; preset: InventoryRow | null; onClose: () => void; onSubmit: (body: any) => Promise<void> }) {
  const [key, setKey] = useState(preset ? `${preset.sku}:${preset.location}` : '');
  const row = rows.find((item) => `${item.sku}:${item.location}` === key) || null;
  const [counted, setCounted] = useState(preset ? String(preset.on_hand) : '');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Record cycle count"
      subtitle="The count is independent from the system quantity; a variance needs supervisor approval."
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!row || counted === '' || busy}
            onClick={async () => {
              if (!row) return;
              setBusy(true);
              await onSubmit({ sku: row.sku, location: row.location, counted: Number(counted), expected_version: row.version });
              setBusy(false);
            }}
          >
            {busy ? 'Recording…' : 'Record count'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Position">
          <select className="select" value={key} onChange={(event) => setKey(event.target.value)}>
            <option value="">Select a position…</option>
            {rows.map((item) => (
              <option key={`${item.sku}:${item.location}`} value={`${item.sku}:${item.location}`}>
                {item.sku} @ {item.location} — system {item.on_hand}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Counted quantity" hint={row ? `System of record: ${row.on_hand} · version ${row.version}` : 'Choose a position first'}>
          <input className="input" type="number" min={0} value={counted} onChange={(event) => setCounted(event.target.value)} />
        </Field>
        {row && counted !== '' && Number(counted) !== row.on_hand && (
          <div className="warn-box">Variance of {Number(counted) - row.on_hand} will be held for approval.</div>
        )}
      </div>
    </Modal>
  );
}
