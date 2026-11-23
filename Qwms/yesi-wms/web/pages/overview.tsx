import { useMemo } from 'react';
import { Badge, Empty, Icon, Metric, Panel, Progress, ProviderMark, Sparkline, Status } from '../components';
import { amount, clock, money, providerLabel, relative, titleCase } from '../api';
import type { Ctx } from '../types';

const STAGES = ['RECEIVED', 'MAPPED', 'RESERVED', 'PICKING', 'PACKED', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'];

export function Overview({ ctx }: { ctx: Ctx }) {
  const { data, events } = ctx;
  const k = data.kpis;
  const counts = useMemo(() => Object.fromEntries(k.by_status.map((row) => [row.status, row.n])), [k.by_status]);

  const throughput = useMemo(() => {
    const buckets = new Array(24).fill(0) as number[];
    const now = Date.now();
    for (const order of data.orders) {
      const age = (now - new Date(order.created_at).getTime()) / 3_600_000;
      if (age >= 0 && age < 24) buckets[23 - Math.floor(age)] += 1;
    }
    return buckets;
  }, [data.orders]);

  const shippedTrend = useMemo(() => {
    const buckets = new Array(12).fill(0) as number[];
    const now = Date.now();
    for (const shipment of data.shipments) {
      if (!shipment.dispatched_at) continue;
      const age = (now - new Date(shipment.dispatched_at).getTime()) / 3_600_000;
      if (age >= 0 && age < 24) buckets[11 - Math.floor(age / 2)] += 1;
    }
    return buckets;
  }, [data.shipments]);

  const maxStage = Math.max(1, ...STAGES.map((stage) => counts[stage] || 0));
  const priority = useMemo(
    () =>
      [...data.orders]
        .filter((order) => order.status === 'EXCEPTION' || order.overdue || ['MAPPED', 'RESERVED'].includes(order.status))
        .sort((a, b) => Number(b.overdue) - Number(a.overdue) || new Date(a.ship_by || 0).getTime() - new Date(b.ship_by || 0).getTime())
        .slice(0, 5),
    [data.orders],
  );

  const integrity = [
    { label: 'Audit hash chain', ok: data.audit.valid, value: `${data.audit.entries} entries` },
    { label: 'Ledger ↔ inventory', ok: data.reconciliation ? data.reconciliation.findings === 0 : false, value: data.reconciliation ? (data.reconciliation.findings === 0 ? 'balanced' : `${data.reconciliation.findings} findings`) : 'not yet run' },
    { label: 'Event backlog', ok: data.worker.pending === 0 && data.worker.dead === 0, value: `${data.worker.pending} pending · ${data.worker.dead} dead` },
    { label: 'Open exceptions', ok: k.open_exceptions === 0, value: `${k.open_exceptions} open` },
  ];

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Operations · live</div>
          <h1>Control tower</h1>
          <p>
            Every order, unit and ruble across Ozon, Yandex Market and Wildberries — flowing through one
            auditable state machine. {data.environment === 'production' ? 'Production' : 'Sandbox'} environment,
            sequence #{k.sequence}.
          </p>
        </div>
        <div className="page-actions">
          <Badge tone={ctx.connected ? 'green' : 'amber'} dot>
            {ctx.connected ? 'Realtime link' : 'Polling'}
          </Badge>
          <button className="btn" onClick={() => ctx.refresh()}>
            <Icon name="refresh" size={14} /> Refresh
          </button>
          <button className="btn primary" onClick={() => ctx.navigate('exceptions')}>
            <Icon name="alert" size={14} /> Triage {k.open_exceptions}
          </button>
        </div>
      </div>

      <div className="metrics six">
        <Metric label="Open orders" value={amount(k.open_orders)} icon="orders" sub={`${k.orders_today} received today`} onClick={() => ctx.navigate('orders')} />
        <Metric label="Shipped · 24h" value={amount(k.shipped_24h)} icon="truck" tone="good" sub={`${k.shipped_today} today · on time ${k.overdue_orders ? 'at risk' : '100%'}`} onClick={() => ctx.navigate('shipping')} />
        <Metric label="Reserved units" value={amount(k.reserved_units)} icon="lock" sub={`${amount(k.available_units)} sellable now`} onClick={() => ctx.navigate('inventory')} />
        <Metric label="Pending picks" value={amount(k.pending_picks)} icon="wave" tone={k.pending_picks > 0 ? 'warn' : 'default'} sub={`${k.open_waves} open waves`} onClick={() => ctx.navigate('waves')} />
        <Metric label="Open exceptions" value={amount(k.open_exceptions)} icon="alert" tone={k.open_exceptions > 0 ? 'bad' : 'good'} sub={`${k.exception_orders} orders blocked`} onClick={() => ctx.navigate('exceptions')} />
        <Metric label="Inventory value" value={money(k.inventory_value_minor)} icon="finance" sub="at weighted cost" onClick={() => ctx.navigate('inventory')} />
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
        <Panel
          title="Fulfillment pipeline"
          subtitle="Orders by state · the graph is enforced in the database, not the UI"
          action={<span className="tiny faint mono">24h volume</span>}
        >
          <div className="pipeline">
            {STAGES.map((stage) => {
              const value = counts[stage] || 0;
              return (
                <div key={stage} className={'stage ' + (stage === 'READY_TO_SHIP' && value ? 'warn' : '')}>
                  <div className="stage-label">{titleCase(stage)}</div>
                  <div className="stage-value">{value}</div>
                  <div className="stage-bar">
                    <span style={{ width: `${(value / maxStage) * 100}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 18, marginLeft: -4, marginRight: -4 }}>
            <Sparkline values={throughput} height={70} label="Order intake, last 24 hours" />
            <div className="between tiny faint" style={{ marginTop: 6 }}>
              <span>24h ago</span>
              <span>{amount(throughput.reduce((a, b) => a + b, 0))} orders received</span>
              <span>now</span>
            </div>
          </div>
        </Panel>

        <Panel title="Integrity & proof" subtitle="Continuous checks, not promises">
          <div>
            {integrity.map((check) => (
              <div className="check-row" key={check.label}>
                <span className={'check-icon ' + (check.ok ? 'ok' : 'bad')}>
                  <Icon name={check.ok ? 'check' : 'alert'} size={12} />
                </span>
                <span className="check-label">{check.label}</span>
                <span className="check-value">{check.value}</span>
              </div>
            ))}
          </div>
          <div className="divider" />
          <div className="between small">
            <span className="muted">Worker</span>
            <span className="mono tiny">
              {data.worker.pending} queued · {data.worker.processing} active · {data.worker.dead} dead
            </span>
          </div>
          <div className="between small" style={{ marginTop: 6 }}>
            <span className="muted">Audit head</span>
            <span className="mono tiny truncate" style={{ maxWidth: 150 }} title={data.audit.head}>
              {data.audit.head.slice(0, 16)}…
            </span>
          </div>
          <button className="btn sm ghost" style={{ marginTop: 12, paddingLeft: 0 }} onClick={() => ctx.navigate('reconciliation')}>
            Open reconciliation <Icon name="arrow" size={13} />
          </button>
        </Panel>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 1fr)' }}>
        <Panel
          title="Live event stream"
          subtitle="Committed domain events, fanned out over WebSocket"
          action={<span className="tiny faint mono">{events.length ? `seq ${events[0].seq}` : 'waiting'}</span>}
          flush
        >
          <div className="event-feed">
            {events.length === 0 && <Empty title="Listening for domain events…" hint="The outbox publishes after each transaction commits." />}
            {events.slice(0, 26).map((event) => (
              <div className="event" key={event.seq}>
                <span className="event-time">{clock(event.created_at)}</span>
                <div style={{ minWidth: 0 }}>
                  <div className="event-topic">{event.topic}</div>
                  <div className="event-detail truncate">
                    {event.aggregate_type} · {String(event.aggregate_id).slice(0, 8)}
                    {event.payload?.provider ? ` · ${event.payload.provider}` : ''}
                    {event.payload?.status ? ` · ${event.payload.status}` : ''}
                  </div>
                </div>
                <span className="event-seq">#{event.seq}</span>
              </div>
            ))}
          </div>
        </Panel>

        <div className="stack">
          <Panel title="Channel health" subtitle="Signature-verified ingestion per marketplace" flush>
            <div style={{ padding: '4px 18px 10px' }}>
              {data.connector_health.map((connection) => {
                const provider = k.by_provider.find((row) => row.provider === connection.provider);
                return (
                  <button
                    key={connection.id}
                    className="channel-row"
                    style={{ width: '100%', background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', textAlign: 'left' }}
                    onClick={() => ctx.navigate('connectors', { id: connection.id })}
                  >
                    <ProviderMark provider={connection.provider} />
                    <div className="channel-meta">
                      <div className="channel-name">{providerLabel(connection.provider)}</div>
                      <div className="channel-sub">
                        {connection.last_error ? (
                          <span className="red">sync error</span>
                        ) : connection.last_sync_at ? (
                          `synced ${relative(connection.last_sync_at)}`
                        ) : (
                          'no sync yet'
                        )}
                        {connection.failed_events ? ` · ${connection.failed_events} rejected` : ''}
                      </div>
                    </div>
                    <div className="channel-numbers">
                      <div className="channel-number">
                        <b>{provider?.orders ?? 0}</b>
                        <span>orders</span>
                      </div>
                      <div className="channel-number">
                        <b className={(provider?.exceptions ?? 0) > 0 ? 'red' : ''}>{provider?.exceptions ?? 0}</b>
                        <span>except</span>
                      </div>
                      <Status value={connection.status === 'enabled' ? 'OK' : 'PAUSED'} label={connection.status} />
                    </div>
                  </button>
                );
              })}
            </div>
          </Panel>

          <Panel title="Needs attention" subtitle="SLA risk and blocked orders" flush>
            {priority.length === 0 ? (
              <Empty title="Nothing waiting" hint="Every order is inside its promise window." />
            ) : (
              <div style={{ padding: '4px 0' }}>
                {priority.map((order) => (
                  <button
                    key={order.id}
                    className="channel-row"
                    style={{ width: '100%', padding: '9px 18px', background: 'transparent', border: 'none', borderBottom: '1px solid rgba(27,42,34,.55)', color: 'inherit', cursor: 'pointer', textAlign: 'left' }}
                    onClick={() => ctx.navigate('orders', { id: order.id })}
                  >
                    <ProviderMark provider={order.provider} size={22} />
                    <div className="channel-meta">
                      <div className="channel-name mono">{order.external_id}</div>
                      <div className="channel-sub">
                        {order.status === 'EXCEPTION' ? <span className="red">blocked · {order.exception_code}</span> : order.overdue ? <span className="red">past ship-by</span> : `ship by ${relative(order.ship_by)}`}
                      </div>
                    </div>
                    <Status value={order.status} />
                  </button>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr)' }}>
        <Panel title="Dispatch rhythm" subtitle="Shipments handed to carriers, 2h buckets">
          <Sparkline values={shippedTrend} height={54} tone="var(--blue)" />
          <div className="between" style={{ marginTop: 12 }}>
            <div>
              <div className="mono" style={{ fontSize: 22 }}>{amount(shippedTrend.reduce((a, b) => a + b, 0))}</div>
              <div className="tiny faint">dispatched in 24h</div>
            </div>
            <div className="right">
              <div className="mono" style={{ fontSize: 22 }}>{money(k.inventory_value_minor / Math.max(1, k.available_units))}</div>
              <div className="tiny faint">avg unit cost</div>
            </div>
          </div>
        </Panel>
        <Panel title="Reservation pressure" subtitle="Locked stock versus sellable stock" >
          <div className="between small" style={{ marginBottom: 8 }}>
            <span className="muted">{amount(k.reserved_units)} units reserved</span>
            <span className="mono tiny">{amount(k.available_units + k.reserved_units)} total</span>
          </div>
          <Progress value={k.reserved_units} max={Math.max(1, k.reserved_units + k.available_units)} />
          <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 16, gap: 10 }}>
            {(['ozon', 'yandex', 'wildberries'] as const).map((provider) => {
              const row = k.by_provider.find((item) => item.provider === provider);
              return (
                <div key={provider} className="check-row" style={{ borderBottom: 0, padding: 0 }}>
                  <ProviderMark provider={provider} size={20} />
                  <div>
                    <div className="mono" style={{ fontSize: 13 }}>{row?.orders ?? 0}</div>
                    <div className="tiny faint">{providerLabel(provider)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      </div>
    </div>
  );
}
