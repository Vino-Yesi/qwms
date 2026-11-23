import { useEffect, useMemo, useState } from 'react';
import { api, amount, clock, money, providerLabel, relative, titleCase } from '../api';
import { Badge, Copy, Drawer, Empty, Field, Icon, Meta, Modal, Panel, ProviderMark, Status, Table, Tabs } from '../components';
import type { Ctx, Order } from '../types';

type Detail = any;

const FILTERS = ['ALL', 'RECEIVED', 'MAPPED', 'RESERVED', 'PICKING', 'PACKED', 'READY_TO_SHIP', 'SHIPPED', 'EXCEPTION', 'CANCELLED'];

export function Orders({ ctx }: { ctx: Ctx }) {
  const [filter, setFilter] = useState<string>(ctx.params.status || 'ALL');
  const [provider, setProvider] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(ctx.params.id || null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [shipOpen, setShipOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return ctx.data.orders
      .filter((order) => filter === 'ALL' || order.status === filter)
      .filter((order) => provider === 'all' || order.provider === provider)
      .filter(
        (order) =>
          !needle ||
          order.external_id.toLowerCase().includes(needle) ||
          (order.customer_ref || '').toLowerCase().includes(needle) ||
          order.connection_name.toLowerCase().includes(needle),
      )
      .sort((a, b) => new Date(a.ship_by || a.created_at).getTime() - new Date(b.ship_by || b.created_at).getTime());
  }, [ctx.data.orders, filter, provider, query]);

  useEffect(() => {
    if (ctx.params.id && ctx.params.id !== selected) setSelected(ctx.params.id);
  }, [ctx.params.id]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let active = true;
    setLoading(true);
    api<Detail>(`/orders/${selected}`)
      .then((value) => active && setDetail(value))
      .catch((error) => ctx.notify(error.message, 'error'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [selected, ctx.data.sequence]);

  const counts = useMemo(() => {
    const map: Record<string, number> = { ALL: ctx.data.orders.length };
    for (const order of ctx.data.orders) map[order.status] = (map[order.status] || 0) + 1;
    return map;
  }, [ctx.data.orders]);

  async function act(path: string, body: unknown, label: string) {
    setBusy(label);
    try {
      await ctx.mutate(path, body, { success: label });
      await ctx.refresh(true);
    } catch {
      /* surfaced by mutate */
    } finally {
      setBusy(null);
    }
  }

  const canFulfil = ctx.can('fulfill');

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Order management</div>
          <h1>Orders</h1>
          <p>Marketplace orders normalised into one auditable state machine. Version checks make concurrent operator and automation changes safe.</p>
        </div>
        <div className="page-actions">
          <Badge tone="slate">{rows.length} shown</Badge>
        </div>
      </div>

      <Panel flush>
        <div style={{ padding: '10px 16px 0' }}>
          <Tabs
            value={filter}
            onChange={setFilter}
            tabs={FILTERS.filter((status) => status !== 'RECEIVED' || counts.RECEIVED).map((status) => ({
              id: status,
              label: status === 'ALL' ? 'All' : titleCase(status),
              count: counts[status] || 0,
            }))}
          />
          <div className="toolbar">
            <div className="search">
              <Icon name="search" size={14} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Order, customer ref…" aria-label="Search orders" />
            </div>
            <select className="select" style={{ width: 180 }} value={provider} onChange={(event) => setProvider(event.target.value)} aria-label="Filter by channel">
              <option value="all">All channels</option>
              <option value="ozon">Ozon</option>
              <option value="yandex">Yandex Market</option>
              <option value="wildberries">Wildberries</option>
            </select>
            <span className="tiny faint">{ctx.data.kpis.overdue_orders} past ship-by · updates live</span>
          </div>
        </div>

        <Table
          columns={[
            { key: 'order', label: 'Order' },
            { key: 'channel', label: 'Channel' },
            { key: 'units', label: 'Units', align: 'right' },
            { key: 'value', label: 'Value', align: 'right' },
            { key: 'sla', label: 'Ship by' },
            { key: 'status', label: 'Status' },
            { key: 'updated', label: 'Updated', align: 'right' },
          ]}
          rows={rows}
          rowKey={(row: Order) => row.id}
          onRow={(row: Order) => setSelected(row.id)}
          height={560}
          empty={<Empty title="No orders in this view" hint="Try another state or clear the search." />}
          render={(row: Order) => (
            <>
              <td>
                <div className="cell-primary mono">{row.external_id}</div>
                <div className="cell-sub">{row.connection_name}</div>
              </td>
              <td>
                <div className="row tight">
                  <ProviderMark provider={row.provider} size={20} />
                  <span className="small">{providerLabel(row.provider)}</span>
                </div>
              </td>
              <td className="right mono">{row.units}</td>
              <td className="right mono">{money(row.total_minor)}</td>
              <td>
                <div className={row.overdue ? 'red small' : 'small'}>{row.ship_by ? relative(row.ship_by) : '—'}</div>
                <div className="cell-sub">{row.ship_by ? new Date(row.ship_by).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</div>
              </td>
              <td>
                <Status value={row.status} />
                {row.unmapped_lines > 0 && <div className="cell-sub red">{row.unmapped_lines} unmapped line(s)</div>}
              </td>
              <td className="right tiny faint">{relative(row.updated_at)}</td>
            </>
          )}
        />
      </Panel>

      {selected && (
        <Drawer
          wide
          title={
            <div className="row">
              <ProviderMark provider={detail?.provider || 'ozon'} />
              <span className="mono">{detail?.external_id || 'Loading…'}</span>
              {detail && <Status value={detail.status} />}
            </div>
          }
          subtitle={detail ? `${detail.connection_name} · ${detail.account_ref} · ${detail.mode}` : undefined}
          onClose={() => setSelected(null)}
          footer={
            detail && canFulfil ? (
              <>
                {detail.status === 'MAPPED' && (
                  <button className="btn primary" disabled={busy !== null} onClick={() => act(`/orders/${detail.id}/reserve`, { version: detail.version }, 'Stock reserved')}>
                    <Icon name="lock" size={14} /> Reserve stock
                  </button>
                )}
                {detail.status === 'PACKED' && (
                  <button className="btn primary" disabled={busy !== null} onClick={() => act(`/orders/${detail.id}/ready`, { version: detail.version }, 'Order ready to ship')}>
                    <Icon name="check" size={14} /> Mark ready
                  </button>
                )}
                {detail.status === 'READY_TO_SHIP' && (
                  <button className="btn primary" onClick={() => setShipOpen(true)}>
                    <Icon name="truck" size={14} /> Book carrier
                  </button>
                )}
                {['RECEIVED', 'MAPPED', 'RESERVED', 'PICKING', 'PACKED', 'READY_TO_SHIP', 'EXCEPTION'].includes(detail.status) && (
                  <button className="btn danger" onClick={() => setCancelOpen(true)}>
                    Cancel order
                  </button>
                )}
                <button className="btn ghost" onClick={() => setSelected(null)}>Close</button>
              </>
            ) : (
              <button className="btn" onClick={() => setSelected(null)}>Close</button>
            )
          }
        >
          {loading && !detail ? (
            <div className="stack">
              <div className="skeleton" style={{ height: 90 }} />
              <div className="skeleton" style={{ height: 220 }} />
            </div>
          ) : detail ? (
            <div className="stack">
              {detail.sla && detail.sla !== 'closed' && detail.sla !== 'on_time' && (
                <div className="warn-box">
                  <strong>{titleCase(detail.sla)}</strong> — the marketplace promise window needs attention.
                </div>
              )}
              <Meta
                items={[
                  { label: 'Order value', value: <span className="mono">{money(detail.total_minor)}</span> },
                  { label: 'Units', value: <span className="mono">{detail.lines.reduce((sum: number, line: any) => sum + line.quantity, 0)}</span> },
                  { label: 'Priority', value: detail.priority },
                  { label: 'Placed', value: new Date(detail.placed_at).toLocaleString('en-GB') },
                  { label: 'Ship by', value: detail.ship_by ? new Date(detail.ship_by).toLocaleString('en-GB') : '—' },
                  { label: 'Version', value: <span className="mono">v{detail.version}</span> },
                ]}
              />

              <div>
                <div className="section-title">Line items</div>
                <div className="stack tight">
                  {detail.lines.map((line: any) => (
                    <div className="check-row" key={line.id}>
                      <div className="grow">
                        <div className="small">{line.product_name || line.external_name}</div>
                        <div className="tiny faint mono">{line.sku || 'unmapped'} · {line.external_sku}</div>
                      </div>
                      <div className="right">
                        <div className="mono small">×{line.quantity}</div>
                        <div className="tiny faint">{money(line.unit_price_minor)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {detail.reservations.length > 0 && (
                <div>
                  <div className="section-title">Reservations <span className="faint">{detail.reservations.length}</span></div>
                  {detail.reservations.map((reservation: any) => (
                    <div className="kv" key={reservation.id}>
                      <span className="mono">{reservation.sku} @ {reservation.location}</span>
                      <span>
                        ×{reservation.quantity} · <Status value={reservation.status === 'ACTIVE' ? 'RESERVED' : 'DELIVERED'} label={reservation.status} />
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {detail.shipment && (
                <div>
                  <div className="section-title">Shipment</div>
                  <div className="hint-box" style={{ marginBottom: 8 }}>
                    <div className="between">
                      <span className="row tight">
                        <Icon name="truck" size={14} /> {detail.shipment.carrier}
                      </span>
                      <Status value={detail.shipment.status} />
                    </div>
                    <div className="between tiny faint" style={{ marginTop: 6 }}>
                      <span className="mono">{detail.shipment.tracking_number || 'no tracking'}</span>
                      <span>{detail.shipment.service}</span>
                    </div>
                  </div>
                  <div className="timeline">
                    {detail.shipment.events.map((event: any, index: number) => (
                      <div className={'timeline-item' + (index === detail.shipment.events.length - 1 ? ' latest' : '')} key={event.id}>
                        <div className="timeline-title">{titleCase(event.status)}</div>
                        <div className="timeline-meta">{event.source} · {new Date(event.occurred_at).toLocaleString('en-GB')}</div>
                        {event.message && <div className="timeline-reason">{event.message}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <div className="section-title">State history <span className="faint">append-only</span></div>
                <div className="timeline">
                  {detail.transitions.map((transition: any, index: number) => (
                    <div className={'timeline-item' + (index === detail.transitions.length - 1 ? ' latest' : '')} key={transition.id}>
                      <div className="timeline-title">
                        {transition.from_status ? `${titleCase(transition.from_status)} → ` : ''}{titleCase(transition.to_status)}
                      </div>
                      <div className="timeline-meta">
                        v{transition.version} · {new Date(transition.created_at).toLocaleString('en-GB')}
                      </div>
                      {transition.reason && <div className="timeline-reason">{transition.reason}</div>}
                    </div>
                  ))}
                </div>
              </div>

              {detail.exceptions.length > 0 && (
                <div>
                  <div className="section-title">Exceptions</div>
                  {detail.exceptions.map((exception: any) => (
                    <div className="danger-box" key={exception.id} style={{ marginBottom: 6 }}>
                      <div className="between">
                        <strong>{titleCase(exception.kind)}</strong>
                        <Status value={exception.status} />
                      </div>
                      <div style={{ marginTop: 4 }}>{exception.message}</div>
                      <div className="tiny" style={{ opacity: 0.75, marginTop: 4 }}>
                        {exception.occurrences} occurrence(s) · opened {relative(exception.created_at)}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {detail.journals.length > 0 && (
                <div>
                  <div className="section-title">Financial postings</div>
                  {detail.journals.map((journal: any) => (
                    <div className="kv" key={journal.id}>
                      <span>{titleCase(journal.kind)} · {journal.posting_key}</span>
                      <span className="mono">{money(journal.amount_minor)} · {journal.status}</span>
                    </div>
                  ))}
                </div>
              )}

              <div>
                <div className="section-title">Ingestion provenance</div>
                {detail.raw_events.map((raw: any) => (
                  <div className="check-row" key={raw.id}>
                    <span className={`check-icon ${raw.status === 'PROCESSED' ? 'ok' : 'bad'}`}>
                      <Icon name={raw.status === 'PROCESSED' ? 'check' : 'alert'} size={12} />
                    </span>
                    <div className="grow">
                      <div className="small mono truncate" style={{ maxWidth: 380 }}>{raw.external_event_id}</div>
                      <div className="tiny faint">{raw.event_type} · {new Date(raw.received_at).toLocaleString('en-GB')}</div>
                    </div>
                    <div className="row tight">
                      <Status value={raw.status} />
                      <Copy value={raw.payload_hash} label="Copy payload hash" />
                    </div>
                  </div>
                ))}
                {detail.raw_events.length === 0 && <div className="tiny faint">No raw events linked.</div>}
              </div>

              <div className="footer-note">
                <span>Order {detail.id}</span>
                <span>Idempotency is enforced by the ingestion hash and the outbox.</span>
              </div>
            </div>
          ) : null}
        </Drawer>
      )}

      {cancelOpen && detail && (
        <CancelModal
          order={detail}
          onClose={() => setCancelOpen(false)}
          onConfirm={async (reason) => {
            await act(`/orders/${detail.id}/cancel`, { version: detail.version, reason }, 'Order cancelled');
            setCancelOpen(false);
          }}
        />
      )}
      {shipOpen && detail && (
        <ShipModal
          onClose={() => setShipOpen(false)}
          onConfirm={async (carrier, service) => {
            await act(`/orders/${detail.id}/ship`, { version: detail.version, carrier, service }, 'Carrier booking requested');
            setShipOpen(false);
          }}
        />
      )}
    </div>
  );
}

function CancelModal({ order, onClose, onConfirm }: { order: any; onClose: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('Customer cancelled via marketplace');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={`Cancel ${order.external_id}?`}
      subtitle="The transition is recorded in the immutable audit chain. Reserved stock is released atomically."
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Keep order</button>
          <button
            className="btn danger"
            disabled={busy || reason.trim().length < 3}
            onClick={async () => {
              setBusy(true);
              await onConfirm(reason.trim());
              setBusy(false);
            }}
          >
            {busy ? 'Cancelling…' : 'Cancel order'}
          </button>
        </>
      }
    >
      <Field label="Reason" hint="Visible to supervisors in the audit trail.">
        <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
    </Modal>
  );
}

function ShipModal({ onClose, onConfirm }: { onClose: () => void; onConfirm: (carrier: string, service: string) => Promise<void> }) {
  const [carrier, setCarrier] = useState('YESI Ground');
  const [service, setService] = useState('STANDARD');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Book a carrier"
      subtitle="Creates a shipment and emits a durable tms.book job. The booking id is stable across retries."
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onConfirm(carrier, service);
              setBusy(false);
            }}
          >
            {busy ? 'Booking…' : 'Request booking'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Carrier">
          <select className="select" value={carrier} onChange={(event) => setCarrier(event.target.value)}>
            <option>YESI Ground</option>
            <option>YESI Express</option>
            <option>Partner carrier</option>
          </select>
        </Field>
        <Field label="Service level">
          <select className="select" value={service} onChange={(event) => setService(event.target.value)}>
            <option value="STANDARD">Standard</option>
            <option value="EXPRESS">Express</option>
            <option value="SAME_DAY">Same day</option>
          </select>
        </Field>
        <div className="hint-box">Tracking numbers are issued by the TMS webhook and deduplicated by event key.</div>
      </div>
    </Modal>
  );
}
