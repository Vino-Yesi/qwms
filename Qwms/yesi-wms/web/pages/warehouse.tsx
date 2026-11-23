import { useEffect, useMemo, useState } from 'react';
import { api, amount, money, relative, titleCase } from '../api';
import { Badge, Drawer, Empty, Icon, Meta, Metric, Panel, Progress, Status, Table } from '../components';
import type { Ctx, InventoryRow } from '../types';

type Bin = {
  code: string;
  zone: string;
  units: number;
  reserved: number;
  value: number;
  rows: InventoryRow[];
};

const ZONES = ['A', 'B', 'C', 'D'];

export function Warehouse({ ctx }: { ctx: Ctx }) {
  const [selected, setSelected] = useState<Bin | null>(null);
  const [movers, setMovers] = useState<Array<{ sku: string; name: string; units_24h: number }>>([]);

  useEffect(() => {
    api<any>('/inventory/velocity')
      .then((value) => setMovers(value.items || []))
      .catch(() => setMovers([]));
  }, [ctx.data.sequence]);

  const bins = useMemo(() => {
    const map = new Map<string, Bin>();
    for (const row of ctx.data.inventory) {
      const code = row.location;
      const bin = map.get(code) || {
        code,
        zone: code.split('-')[0],
        units: 0,
        reserved: 0,
        value: 0,
        rows: [],
      };
      bin.units += Number(row.on_hand);
      bin.reserved += Number(row.reserved);
      bin.value += Number(row.value_minor);
      bin.rows.push(row);
      map.set(code, bin);
    }
    return Array.from(map.values()).sort((a, b) => a.code.localeCompare(b.code));
  }, [ctx.data.inventory]);

  const zones = useMemo(
    () =>
      ZONES.map((zone) => {
        const zoneBins = bins.filter((bin) => bin.zone === zone);
        return {
          zone,
          bins: zoneBins,
          units: zoneBins.reduce((sum, bin) => sum + bin.units, 0),
          reserved: zoneBins.reduce((sum, bin) => sum + bin.reserved, 0),
          value: zoneBins.reduce((sum, bin) => sum + bin.value, 0),
          max: Math.max(1, ...zoneBins.map((bin) => bin.units)),
        };
      }),
    [bins],
  );

  const carriers = useMemo(() => {
    const orders = new Map(ctx.data.orders.map((order) => [order.id, order]));
    const map = new Map<string, { carrier: string; total: number; delivered: number; moving: number; cycleHours: number[]; onTime: number; measured: number }>();
    for (const shipment of ctx.data.shipments) {
      const entry = map.get(shipment.carrier) || { carrier: shipment.carrier, total: 0, delivered: 0, moving: 0, cycleHours: [], onTime: 0, measured: 0 };
      entry.total += 1;
      if (shipment.status === 'DELIVERED') entry.delivered += 1;
      if (['DISPATCHED', 'IN_TRANSIT', 'BOOKED'].includes(shipment.status)) entry.moving += 1;
      const order = orders.get(shipment.order_id);
      if (shipment.dispatched_at && order) {
        entry.cycleHours.push((new Date(shipment.dispatched_at).getTime() - new Date(order.created_at).getTime()) / 3_600_000);
        if (order.ship_by) {
          entry.measured += 1;
          if (new Date(shipment.dispatched_at) <= new Date(order.ship_by)) entry.onTime += 1;
        }
      }
      map.set(shipment.carrier, entry);
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [ctx.data.shipments, ctx.data.orders]);

  const cycle = useMemo(() => {
    const orders = new Map(ctx.data.orders.map((order) => [order.id, order]));
    const buckets = [
      { label: '< 6h', count: 0 },
      { label: '6–12h', count: 0 },
      { label: '12–24h', count: 0 },
      { label: '24–48h', count: 0 },
      { label: '> 48h', count: 0 },
    ];
    const values: number[] = [];
    for (const shipment of ctx.data.shipments) {
      if (!shipment.dispatched_at) continue;
      const order = orders.get(shipment.order_id);
      if (!order) continue;
      const hours = (new Date(shipment.dispatched_at).getTime() - new Date(order.created_at).getTime()) / 3_600_000;
      values.push(hours);
      if (hours < 6) buckets[0].count += 1;
      else if (hours < 12) buckets[1].count += 1;
      else if (hours < 24) buckets[2].count += 1;
      else if (hours < 48) buckets[3].count += 1;
      else buckets[4].count += 1;
    }
    values.sort((a, b) => a - b);
    const median = values.length ? values[Math.floor(values.length / 2)] : null;
    return { buckets, median, samples: values.length };
  }, [ctx.data.orders, ctx.data.shipments]);

  const totalStatus = ctx.data.kpis.by_status.reduce((sum, row) => sum + row.n, 0);
  const occupied = bins.length;
  const totalUnits = bins.reduce((sum, bin) => sum + bin.units, 0);
  const inbound = [...ctx.data.asns].filter((asn) => asn.status !== 'RECEIVED').sort((a, b) => new Date(a.expected_at).getTime() - new Date(b.expected_at).getTime());

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Warehouse intelligence</div>
          <h1>Slotting & flow</h1>
          <p>Where the stock sits, how fast it moves and which carriers keep their promises — derived from the same ledger the floor uses.</p>
        </div>
        <div className="page-actions">
          <Badge tone="slate">{occupied} active bins</Badge>
          <button className="btn" onClick={() => ctx.navigate('inventory')}>
            <Icon name="box" size={14} /> Open ledger
          </button>
        </div>
      </div>

      <div className="metrics">
        <Metric label="Units stored" value={amount(totalUnits)} icon="layers" sub={`across ${ZONES.length} zones`} />
        <Metric label="Median cycle" value={cycle.median === null ? '—' : `${cycle.median.toFixed(1)}h`} icon="clock" tone="good" sub={`${cycle.samples} dispatched orders`} />
        <Metric label="Carrier on-time" value={`${carrierOnTime(carriers)}%`} icon="truck" tone={carrierOnTime(carriers) >= 90 ? 'good' : 'warn'} sub="ship-by promise" />
        <Metric label="Inbound today" value={amount(inbound.filter((asn) => new Date(asn.expected_at).toDateString() === new Date().toDateString()).length)} icon="receive" sub={`${inbound.length} open ASNs`} />
      </div>

      <Panel title="Slotting map" subtitle="Live occupancy per bin · click a bin to inspect" flush>
        <div className="zone-board">
          {zones.map((zone) => (
            <div className="zone-row" key={zone.zone}>
              <div className="zone-label">
                <div className="zone-letter">{zone.zone}</div>
                <div className="tiny faint">{zone.bins.length} bins</div>
                <div className="tiny mono" style={{ marginTop: 4 }}>{amount(zone.units)}</div>
              </div>
              <div className="bin-grid">
                {zone.bins.length === 0 && <div className="tiny faint">No stock in this zone</div>}
                {zone.bins.map((bin) => {
                  const heat = bin.units === 0 ? 0 : Math.max(1, Math.ceil((bin.units / zone.max) * 4));
                  return (
                    <button key={bin.code} className={`bin-cell heat-${heat}`} onClick={() => setSelected(bin)} title={`${bin.code} · ${bin.units} units`}>
                      <span className="bin-code">{bin.code}</span>
                      <span className="bin-units">{bin.units}</span>
                      <span className="bin-meta">
                        {bin.rows.length} SKU{bin.rows.length === 1 ? '' : 's'}
                        {bin.reserved > 0 ? ` · ${bin.reserved} held` : ''}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="zone-bar">
                <div className="between tiny" style={{ marginBottom: 4 }}>
                  <span className="faint">{money(zone.value)}</span>
                  <span className="mono">{zone.reserved} held</span>
                </div>
                <Progress value={zone.reserved} max={Math.max(1, zone.units)} />
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.35fr) minmax(0, 1fr)' }}>
        <Panel title="Carrier performance" subtitle="Measured against marketplace ship-by promises" flush>
          <Table
            columns={[
              { key: 'carrier', label: 'Carrier' },
              { key: 'total', label: 'Shipments', align: 'right' },
              { key: 'moving', label: 'Moving', align: 'right' },
              { key: 'delivered', label: 'Delivered', align: 'right' },
              { key: 'cycle', label: 'Avg cycle', align: 'right' },
              { key: 'ontime', label: 'On time', align: 'right' },
            ]}
            rows={carriers}
            rowKey={(row: any) => row.carrier}
            height={260}
            dense
            empty={<Empty title="No carrier history yet" hint="Book a shipment to start measuring." />}
            render={(row: any) => {
              const onTime = row.measured ? Math.round((row.onTime / row.measured) * 100) : null;
              const avg = row.cycleHours.length ? row.cycleHours.reduce((a: number, b: number) => a + b, 0) / row.cycleHours.length : null;
              return (
                <>
                  <td className="small">{row.carrier}</td>
                  <td className="right mono">{row.total}</td>
                  <td className="right mono">{row.moving}</td>
                  <td className="right mono">{row.delivered}</td>
                  <td className="right mono tiny">{avg === null ? '—' : `${avg.toFixed(1)}h`}</td>
                  <td className="right">
                    {onTime === null ? <span className="faint tiny">—</span> : <Status value={onTime >= 90 ? 'OK' : 'EXCEPTION'} label={`${onTime}%`} />}
                  </td>
                </>
              );
            }}
          />
          <div className="panel-foot">
            <span>On-time = dispatched before the marketplace ship-by timestamp</span>
            <span className="mono">{ctx.data.shipments.length} shipments</span>
          </div>
        </Panel>

        <Panel title="Cycle time" subtitle="Order received → carrier handover">
          <div className="bar-list">
            {cycle.buckets.map((bucket) => {
              const max = Math.max(1, ...cycle.buckets.map((item) => item.count));
              return (
                <div className="bar-item" key={bucket.label}>
                  <span className="bar-label">{bucket.label}</span>
                  <span className="bar-track"><span className="bar-fill" style={{ width: `${(bucket.count / max) * 100}%` }} /></span>
                  <span className="bar-value mono">{bucket.count}</span>
                </div>
              );
            })}
          </div>
          <div className="divider" />
          <div className="between small">
            <span className="muted">Median</span>
            <span className="mono">{cycle.median === null ? '—' : `${cycle.median.toFixed(1)} hours`}</span>
          </div>
          <div className="between small" style={{ marginTop: 6 }}>
            <span className="muted">Sample</span>
            <span className="mono">{cycle.samples} orders</span>
          </div>
        </Panel>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
        <Panel title="Status mix" subtitle={`${totalStatus} orders in flight`}>
          <div className="mix-list">
            {[...ctx.data.kpis.by_status]
              .sort((a, b) => b.n - a.n)
              .map((row) => (
                <div className="mix-row" key={row.status}>
                  <span className="mix-label">
                    <span className={`mix-dot tone-${row.status}`} />
                    {titleCase(row.status)}
                  </span>
                  <span className="mix-track">
                    <span className={`mix-fill tone-${row.status}`} style={{ width: `${totalStatus ? (row.n / totalStatus) * 100 : 0}%` }} />
                  </span>
                  <span className="mix-value mono">{row.n}</span>
                </div>
              ))}
          </div>
        </Panel>

        <Panel title="Top movers" subtitle="Units ordered in the last 24 hours" flush>
          {movers.length === 0 ? (
            <Empty title="No movement in 24h" />
          ) : (
            <div style={{ padding: '6px 0 10px' }}>
              {movers.slice(0, 7).map((mover, index) => (
                <button
                  key={mover.sku}
                  className="mover-row"
                  onClick={() => ctx.navigate('inventory', { sku: mover.sku })}
                >
                  <span className="mover-rank mono">{String(index + 1).padStart(2, '0')}</span>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="small truncate" style={{ display: 'block' }}>{mover.name}</span>
                    <span className="tiny faint mono">{mover.sku}</span>
                  </span>
                  <span className="mono small">{mover.units_24h}</span>
                </button>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Inbound dock" subtitle="Next arrivals" flush>
          {inbound.length === 0 ? (
            <Empty title="No inbound scheduled" />
          ) : (
            <div style={{ padding: '6px 16px 12px' }}>
              {inbound.slice(0, 5).map((asn) => {
                const remaining = Number(asn.units_expected) - Number(asn.units_received);
                return (
                  <div className="check-row" key={asn.id}>
                    <span className="check-icon ok" style={{ background: 'var(--panel-2)', color: 'var(--accent)' }}>
                      <Icon name="receive" size={12} />
                    </span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="small truncate">{asn.supplier}</div>
                      <div className="tiny faint">
                        {new Date(asn.expected_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} · {remaining} units
                      </div>
                    </div>
                    <span className="tiny faint">{relative(asn.expected_at)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      </div>

      {selected && (
        <Drawer
          title={<span className="mono">{selected.code}</span>}
          subtitle={`Zone ${selected.zone} · ${selected.rows.length} SKU${selected.rows.length === 1 ? '' : 's'} · ${amount(selected.units)} units`}
          onClose={() => setSelected(null)}
          footer={<button className="btn" onClick={() => setSelected(null)}>Close</button>}
        >
          <div className="stack">
            <Meta
              items={[
                { label: 'On hand', value: <span className="mono">{amount(selected.units)}</span> },
                { label: 'Reserved', value: <span className="mono">{amount(selected.reserved)}</span> },
                { label: 'Value', value: money(selected.value) },
              ]}
            />
            <div>
              <div className="section-title">Contents</div>
              {selected.rows.map((row) => (
                <button
                  key={`${row.sku}:${row.location}`}
                  className="channel-row"
                  style={{ width: '100%', background: 'transparent', border: 0, borderBottom: '1px solid rgba(27,42,34,.55)', color: 'inherit', cursor: 'pointer', textAlign: 'left' }}
                  onClick={() => {
                    setSelected(null);
                    ctx.navigate('inventory', { sku: row.sku });
                  }}
                >
                  <div className="channel-meta">
                    <div className="channel-name">{row.name}</div>
                    <div className="channel-sub mono">{row.sku} · {row.category}</div>
                  </div>
                  <div className="right">
                    <div className="mono small">{amount(row.on_hand)}</div>
                    <div className="tiny faint">{row.reserved} held</div>
                  </div>
                  <Icon name="arrow" size={13} className="faint" />
                </button>
              ))}
            </div>
            <div className="hint-box">Movement history for each SKU is available from the inventory ledger, including request keys and balances.</div>
          </div>
        </Drawer>
      )}
    </div>
  );
}

function carrierOnTime(carriers: Array<{ onTime: number; measured: number }>): number {
  const measured = carriers.reduce((sum, carrier) => sum + carrier.measured, 0);
  const onTime = carriers.reduce((sum, carrier) => sum + carrier.onTime, 0);
  return measured ? Math.round((onTime / measured) * 100) : 100;
}
