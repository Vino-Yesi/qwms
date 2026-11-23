import { useEffect, useMemo, useState } from 'react';
import { api, amount, relative, titleCase } from '../api';
import { Badge, Drawer, Empty, Icon, Metric, Modal, Panel, Progress, Status } from '../components';
import type { Ctx, Wave } from '../types';

export function Waves({ ctx }: { ctx: Ctx }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const reserved = useMemo(() => ctx.data.orders.filter((order) => order.status === 'RESERVED'), [ctx.data.orders]);
  const pendingTasks = ctx.data.waves.reduce((sum, wave) => sum + Number(wave.tasks_pending), 0);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    api<any>(`/waves/${selected}`).then(setDetail).catch((error) => ctx.notify(error.message, 'error'));
  }, [selected, ctx.data.sequence]);

  async function pick(taskId: string, quantity: number) {
    if (!selected) return;
    setBusy(taskId);
    try {
      await ctx.mutate(`/waves/${selected}/pick`, { task_id: taskId, picked: quantity }, { success: 'Pick confirmed' });
      await ctx.refresh(true);
    } finally {
      setBusy(null);
    }
  }

  async function complete() {
    if (!selected) return;
    setBusy('complete');
    try {
      await ctx.mutate(`/waves/${selected}/complete`, {}, { success: 'Wave completed and orders packed' });
      await ctx.refresh(true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Warehouse execution</div>
          <h1>Wave & pick board</h1>
          <p>Waves group reserved orders into zone-ordered pick tasks. Completion moves each order to packed inside one transaction per wave.</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" onClick={() => setCreateOpen(true)} disabled={!ctx.can('fulfill') || reserved.length < 1}>
            <Icon name="wave" size={14} /> Release wave · {reserved.length}
          </button>
        </div>
      </div>

      <div className="metrics">
        <Metric label="Open waves" value={amount(ctx.data.kpis.open_waves)} icon="wave" sub={`${ctx.data.waves.length} total`} />
        <Metric label="Reserved orders" value={amount(reserved.length)} icon="orders" tone={reserved.length ? 'accent' : 'default'} sub="ready to wave" />
        <Metric label="Pending picks" value={amount(pendingTasks)} icon="box" tone={pendingTasks ? 'warn' : 'good'} sub="lines across open waves" />
        <Metric label="Waves completed" value={amount(ctx.data.waves.filter((wave) => wave.status === 'COMPLETE').length)} icon="check" tone="good" sub="all time" />
      </div>

      <Panel title="Waves" subtitle="Newest first" flush>
        {ctx.data.waves.length === 0 ? (
          <Empty title="No waves released" hint="Group reserved orders to start picking." />
        ) : (
          <div style={{ padding: '4px 0' }}>
            {[...ctx.data.waves].reverse().map((wave: Wave) => {
              const done = Number(wave.tasks_total) - Number(wave.tasks_pending);
              return (
                <button
                  key={wave.id}
                  className="channel-row"
                  style={{ width: '100%', padding: '12px 18px', background: 'transparent', border: 'none', borderBottom: '1px solid rgba(27,42,34,.55)', color: 'inherit', cursor: 'pointer', textAlign: 'left' }}
                  onClick={() => setSelected(wave.id)}
                >
                  <span className="check-icon ok" style={{ background: 'var(--panel-2)', color: 'var(--accent)' }}>
                    <Icon name="wave" size={13} />
                  </span>
                  <div className="channel-meta">
                    <div className="row tight">
                      <span className="cell-primary mono">{wave.name}</span>
                      <Status value={wave.status} />
                    </div>
                    <div className="tiny faint" style={{ marginTop: 3 }}>
                      {wave.order_count} orders · {wave.tasks_total} tasks · created {relative(wave.created_at)}
                    </div>
                  </div>
                  <div style={{ width: 180 }}>
                    <div className="between tiny" style={{ marginBottom: 5 }}>
                      <span className="muted">{done}/{wave.tasks_total} picked</span>
                      <span className="mono">{wave.tasks_total ? Math.round((done / wave.tasks_total) * 100) : 0}%</span>
                    </div>
                    <Progress value={done} max={Math.max(1, Number(wave.tasks_total))} tone={wave.status === 'COMPLETE' ? 'accent' : 'amber'} />
                  </div>
                  <Icon name="chevron" size={14} className="faint" />
                </button>
              );
            })}
          </div>
        )}
      </Panel>

      {selected && detail && (
        <Drawer
          wide
          title={<span className="mono">{detail.name}</span>}
          subtitle={<span>{detail.order_count ?? detail.orders?.length ?? 0} orders · {titleCase(detail.status)}</span>}
          onClose={() => setSelected(null)}
          footer={
            <>
              {detail.status !== 'COMPLETE' && (
                <button
                  className="btn primary"
                  disabled={busy !== null || detail.tasks.some((task: any) => Number(task.picked || 0) < Number(task.quantity))}
                  onClick={complete}
                >
                  {busy === 'complete' ? 'Completing…' : 'Complete wave & pack'}
                </button>
              )}
              <button className="btn ghost" onClick={() => setSelected(null)}>Close</button>
            </>
          }
        >
          <div className="stack">
            <div className="between">
              <Badge tone={detail.status === 'COMPLETE' ? 'green' : 'amber'} dot>{titleCase(detail.status)}</Badge>
              <span className="tiny faint">released {detail.released_at ? relative(detail.released_at) : '—'}</span>
            </div>

            <div>
              <div className="section-title">Pick tasks <span className="faint">zone ordered</span></div>
              {detail.tasks.length === 0 && <div className="tiny faint">No tasks generated.</div>}
              {detail.tasks.map((task: any) => {
                const picked = Number(task.picked || 0);
                const quantity = Number(task.quantity);
                return (
                  <div className="check-row" key={task.id}>
                    <span className={`check-icon ${picked >= quantity ? 'ok' : 'bad'}`}>
                      <Icon name={picked >= quantity ? 'check' : 'box'} size={12} />
                    </span>
                    <div className="grow">
                      <div className="small mono">{task.location} · {task.sku}</div>
                      <div className="tiny faint">{picked} / {quantity} picked · {task.status || 'PENDING'}</div>
                    </div>
                    {picked < quantity ? (
                      <button className="btn sm" disabled={busy !== null} onClick={() => pick(task.id, quantity - picked)}>
                        {busy === task.id ? 'Confirming…' : `Pick ${quantity - picked}`}
                      </button>
                    ) : (
                      <Status value="DONE" />
                    )}
                  </div>
                );
              })}
            </div>

            <div>
              <div className="section-title">Orders</div>
              {detail.orders.map((order: any) => (
                <div className="kv" key={order.id}>
                  <span className="mono small">{order.external_id}</span>
                  <span className="row tight">
                    <Status value={order.status} />
                    <button className="icon-btn sm" aria-label="Open order" onClick={() => { setSelected(null); ctx.navigate('orders', { id: order.id }); }}>
                      <Icon name="external" size={12} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </Drawer>
      )}

      {createOpen && (
        <CreateWaveModal
          orders={reserved}
          onClose={() => setCreateOpen(false)}
          onSubmit={async (ids) => {
            const versions = Object.fromEntries(reserved.filter((order) => ids.includes(order.id)).map((order) => [order.id, order.version]));
            await ctx.mutate('/waves', { order_ids: ids, versions }, { success: 'Wave released' });
            await ctx.refresh(true);
            setCreateOpen(false);
          }}
        />
      )}
    </div>
  );
}

function CreateWaveModal({ orders, onClose, onSubmit }: { orders: any[]; onClose: () => void; onSubmit: (ids: string[]) => Promise<void> }) {
  const [selected, setSelected] = useState<string[]>(orders.slice(0, Math.min(6, orders.length)).map((order) => order.id));
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Release a pick wave"
      subtitle="Orders must be reserved. Pick tasks are generated in location order."
      width={660}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!selected.length || busy}
            onClick={async () => {
              setBusy(true);
              await onSubmit(selected);
              setBusy(false);
            }}
          >
            {busy ? 'Releasing…' : `Release ${selected.length} order(s)`}
          </button>
        </>
      }
    >
      <div className="stack tight">
        {orders.length === 0 && <div className="hint-box">No reserved orders. Reserve stock from the order drawer first.</div>}
        {orders.map((order) => (
          <label key={order.id} className="check-row" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={selected.includes(order.id)}
              onChange={(event) =>
                setSelected(event.target.checked ? [...selected, order.id] : selected.filter((id) => id !== order.id))
              }
              aria-label={`Include ${order.external_id}`}
            />
            <span className="grow">
              <span className="small mono">{order.external_id}</span>
              <span className="tiny faint"> · {order.provider} · {order.units} units</span>
            </span>
            <span className="tiny faint">ship by {relative(order.ship_by)}</span>
          </label>
        ))}
      </div>
    </Modal>
  );
}
