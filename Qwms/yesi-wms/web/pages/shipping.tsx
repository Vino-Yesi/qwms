import { useEffect, useMemo, useState } from 'react';
import { api, money, relative, titleCase } from '../api';
import { Badge, Drawer, Empty, Field, Icon, Meta, Metric, Modal, Panel, ProviderMark, Status, Table } from '../components';
import type { Ctx, Shipment } from '../types';

export function Shipping({ ctx }: { ctx: Ctx }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [filter, setFilter] = useState('ALL');
  const [trackOpen, setTrackOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const rows = useMemo(
    () =>
      [...ctx.data.shipments]
        .filter((shipment) => filter === 'ALL' || shipment.status === filter)
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()),
    [ctx.data.shipments, filter],
  );

  const stats = useMemo(() => {
    const delivered = ctx.data.shipments.filter((shipment) => shipment.status === 'DELIVERED').length;
    const transit = ctx.data.shipments.filter((shipment) => ['DISPATCHED', 'IN_TRANSIT'].includes(shipment.status)).length;
    const booked = ctx.data.shipments.filter((shipment) => shipment.status === 'BOOKED').length;
    return { delivered, transit, booked, onTime: ctx.data.shipments.length ? Math.round(((delivered + transit) / ctx.data.shipments.length) * 100) : 0 };
  }, [ctx.data.shipments]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    api<any>(`/shipments/${selected}`).then(setDetail).catch((error) => ctx.notify(error.message, 'error'));
  }, [selected, ctx.data.sequence]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Transport management</div>
          <h1>Shipments & tracking</h1>
          <p>Carrier bookings, label references and tracking scans. Delivery closes the order and drives the marketplace status push.</p>
        </div>
        <div className="page-actions">
          <Badge tone="slate">{stats.transit} in transit</Badge>
        </div>
      </div>

      <div className="metrics">
        <Metric label="Awaiting dispatch" value={stats.booked} icon="clock" tone={stats.booked ? 'warn' : 'default'} sub="booked, not handed over" />
        <Metric label="In transit" value={stats.transit} icon="truck" sub="with carrier" />
        <Metric label="Delivered" value={stats.delivered} icon="check" tone="good" sub="confirmed scans" />
        <Metric label="Completion" value={`${stats.onTime}%`} icon="activity" sub="delivered or moving" />
      </div>

      <Panel flush>
        <div className="toolbar" style={{ padding: '12px 16px 0' }}>
          {['ALL', 'BOOKED', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'EXCEPTION'].map((status) => (
            <button key={status} className={'btn sm ' + (filter === status ? 'primary' : 'ghost')} onClick={() => setFilter(status)}>
              {status === 'ALL' ? 'All shipments' : titleCase(status)}
            </button>
          ))}
        </div>
        <Table
          columns={[
            { key: 'tracking', label: 'Shipment' },
            { key: 'order', label: 'Order' },
            { key: 'carrier', label: 'Carrier' },
            { key: 'service', label: 'Service' },
            { key: 'status', label: 'Status' },
            { key: 'events', label: 'Scans', align: 'right' },
            { key: 'updated', label: 'Updated', align: 'right' },
          ]}
          rows={rows}
          rowKey={(row: Shipment) => row.id}
          onRow={(row: Shipment) => setSelected(row.id)}
          height={520}
          empty={<Empty title="No shipments in this state" />}
          render={(row: Shipment) => (
            <>
              <td>
                <div className="cell-primary mono">{row.tracking_number || row.external_id}</div>
                <div className="cell-sub">{row.label_reference || row.id.slice(0, 8)}</div>
              </td>
              <td>
                <div className="row tight">
                  <ProviderMark provider={row.provider} size={18} />
                  <span className="mono small">{row.external_id}</span>
                </div>
                <div className="cell-sub">{titleCase(row.order_status)}</div>
              </td>
              <td className="small">{row.carrier}</td>
              <td className="small faint">{titleCase(row.service)}</td>
              <td><Status value={row.status} /></td>
              <td className="right mono">{row.event_count}</td>
              <td className="right tiny faint">{relative(row.updated_at)}</td>
            </>
          )}
        />
      </Panel>

      {selected && detail && (
        <Drawer
          title={<span className="mono">{detail.tracking_number || detail.external_id}</span>}
          subtitle={<span>{detail.carrier} · {titleCase(detail.service)} · {detail.provider}</span>}
          onClose={() => setSelected(null)}
          footer={
            <>
              {detail.status === 'BOOKED' && ctx.can('fulfill') && (
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await ctx.mutate(`/shipments/${detail.id}/dispatch`, { version: detail.version }, { success: 'Carrier handover confirmed' });
                      await ctx.refresh(true);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Icon name="truck" size={14} /> Confirm handover
                </button>
              )}
              {['DISPATCHED', 'IN_TRANSIT'].includes(detail.status) && ctx.can('integrate') && (
                <button className="btn" onClick={() => setTrackOpen(true)}>
                  <Icon name="activity" size={14} /> Add scan
                </button>
              )}
              <button className="btn ghost" onClick={() => setSelected(null)}>Close</button>
            </>
          }
        >
          <div className="stack">
            <div className="between">
              <Status value={detail.status} />
              {detail.tracking_url && (
                <a className="btn sm" href={detail.tracking_url} target="_blank" rel="noreferrer">
                  Carrier tracking <Icon name="external" size={12} />
                </a>
              )}
            </div>
            <Meta
              items={[
                { label: 'Booked', value: detail.booked_at ? new Date(detail.booked_at).toLocaleString('en-GB') : '—' },
                { label: 'Dispatched', value: detail.dispatched_at ? new Date(detail.dispatched_at).toLocaleString('en-GB') : '—' },
                { label: 'Delivered', value: detail.delivered_at ? new Date(detail.delivered_at).toLocaleString('en-GB') : '—' },
              ]}
            />
            <button className="btn sm ghost" style={{ alignSelf: 'flex-start', paddingLeft: 0 }} onClick={() => ctx.navigate('orders', { id: detail.order_id })}>
              Open order <Icon name="arrow" size={13} />
            </button>
            <div>
              <div className="section-title">Tracking history <span className="faint">{detail.events?.length || 0} scans</span></div>
              <div className="timeline">
                {(detail.events || []).slice().reverse().map((event: any, index: number) => (
                  <div className={'timeline-item' + (index === 0 ? ' latest' : '')} key={event.id}>
                    <div className="timeline-title">{titleCase(event.status)}</div>
                    <div className="timeline-meta">{event.source} · {new Date(event.occurred_at).toLocaleString('en-GB')}</div>
                    {event.message && <div className="timeline-reason">{event.message}</div>}
                    <div className="timeline-meta mono" style={{ opacity: 0.7 }}>{event.dedupe_key}</div>
                  </div>
                ))}
                {!detail.events?.length && <div className="tiny faint">No scans recorded yet.</div>}
              </div>
            </div>
          </div>
        </Drawer>
      )}

      {trackOpen && detail && (
        <ScanModal
          onClose={() => setTrackOpen(false)}
          onSubmit={async (status, message) => {
            await ctx.mutate(`/shipments/${detail.id}/tracking`, { status, message }, { success: 'Scan applied' });
            await ctx.refresh(true);
            setTrackOpen(false);
          }}
        />
      )}
    </div>
  );
}

function ScanModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (status: string, message: string) => Promise<void> }) {
  const [status, setStatus] = useState('IN_TRANSIT');
  const [message, setMessage] = useState('Departed regional hub');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Apply a tracking scan"
      subtitle="Useful when a carrier pushes a webhook out of band. Deduplicated by event key."
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onSubmit(status, message);
              setBusy(false);
            }}
          >
            {busy ? 'Applying…' : 'Apply scan'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Status">
          <select className="select" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="IN_TRANSIT">In transit</option>
            <option value="DELIVERED">Delivered</option>
            <option value="EXCEPTION">Exception</option>
          </select>
        </Field>
        <Field label="Message">
          <input className="input" value={message} onChange={(event) => setMessage(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
