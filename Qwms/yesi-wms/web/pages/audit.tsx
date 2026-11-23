import { useEffect, useState } from 'react';
import { api, clock, relative, titleCase } from '../api';
import { Badge, Copy, Drawer, Empty, Icon, Metric, Panel, Status, Table, Tabs } from '../components';
import type { Ctx, StreamEvent } from '../types';

export function Audit({ ctx }: { ctx: Ctx }) {
  const [tab, setTab] = useState('ledger');
  const [entries, setEntries] = useState<any[] | null>(null);
  const [verify, setVerify] = useState<any>(null);
  const [outbox, setOutbox] = useState<any>(null);
  const [status, setStatus] = useState('ALL');
  const [selected, setSelected] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api<any>('/audit/verify?force=true').then((value) => active && setVerify(value)).catch(() => {});
    const after = Math.max(0, ctx.data.audit.entries - 200);
    api<any>(`/audit?after=${after}&limit=200`)
      .then((value) => active && setEntries(value.items || []))
      .catch((error) => ctx.notify(error.message, 'error'));
    return () => {
      active = false;
    };
  }, [ctx.data.sequence]);

  useEffect(() => {
    let active = true;
    api<any>(`/outbox?limit=300${status === 'ALL' ? '' : `&status=${status}`}`)
      .then((value) => active && setOutbox(value))
      .catch((error) => ctx.notify(error.message, 'error'));
    return () => {
      active = false;
    };
  }, [ctx.data.sequence, status]);

  const chain = verify || ctx.data.audit;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Governance</div>
          <h1>Audit & events</h1>
          <p>A hash-chained audit log answers who changed what, when and from where. The transactional outbox is the only path to side effects.</p>
        </div>
        <div className="page-actions">
          <Badge tone={chain.valid ? 'green' : 'red'} dot>{chain.valid ? 'Chain verified' : 'Chain broken'}</Badge>
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setVerify(await api<any>('/audit/verify?force=true'));
                ctx.notify('Audit chain re-verified', 'success');
              } catch (error: any) {
                ctx.notify(error.message, 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            <Icon name="shield" size={14} /> Verify chain
          </button>
        </div>
      </div>

      <div className="metrics">
        <Metric label="Audit entries" value={chain.entries?.toLocaleString?.('en-US') ?? chain.entries} icon="file" tone="good" sub={chain.valid ? 'hash chain intact' : 'verification failed'} />
        <Metric label="Outbox pending" value={outbox?.pending ?? ctx.data.worker.pending} icon="activity" tone={(outbox?.pending ?? 0) > 0 ? 'warn' : 'good'} sub={`${outbox?.processing ?? 0} processing`} />
        <Metric label="Dead letters" value={outbox?.dead ?? ctx.data.worker.dead} icon="bolt" tone={(outbox?.dead ?? 0) ? 'bad' : 'good'} sub="require replay" />
        <Metric label="Topics" value={outbox?.topics?.length ?? '—'} icon="layers" sub="ordered per aggregate" />
      </div>

      <Panel flush>
        <div style={{ padding: '8px 16px 0' }}>
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'ledger', label: 'Audit trail', count: entries?.length },
              { id: 'outbox', label: 'Event bus', count: outbox?.items?.length },
              { id: 'stream', label: 'Live tail', count: ctx.events.length },
            ]}
          />
        </div>

        {tab === 'ledger' && (
          <>
            <div className="hint-box" style={{ margin: '0 16px 14px' }}>
              <div className="between">
                <span><strong>Head</strong> <span className="mono tiny">{chain.head}</span></span>
                <Copy value={chain.head} label="Copy audit head" />
              </div>
            </div>
            {!entries ? (
              <div style={{ padding: 18 }}><div className="skeleton" style={{ height: 260 }} /></div>
            ) : (
              <Table
                columns={[
                  { key: 'seq', label: '#', align: 'right' },
                  { key: 'action', label: 'Action' },
                  { key: 'entity', label: 'Entity' },
                  { key: 'actor', label: 'Actor' },
                  { key: 'when', label: 'When' },
                  { key: 'hash', label: 'Hash' },
                ]}
                rows={[...entries].reverse()}
                rowKey={(row: any) => String(row.seq)}
                onRow={(row: any) => setSelected(row)}
                height={460}
                dense
                empty={<Empty title="No audit entries" />}
                render={(row: any) => (
                  <>
                    <td className="right mono tiny">{row.seq}</td>
                    <td className="small mono">{row.action}</td>
                    <td className="tiny faint">{row.entity_type} · {String(row.entity_id).slice(0, 8)}</td>
                    <td className="tiny">{row.actor_type}{row.actor_ip ? ` · ${row.actor_ip}` : ''}</td>
                    <td className="tiny faint nowrap">{new Date(row.created_at).toLocaleString('en-GB')}</td>
                    <td className="mono tiny faint">{String(row.entry_hash).slice(0, 12)}…</td>
                  </>
                )}
              />
            )}
          </>
        )}

        {tab === 'outbox' && (
          <>
            <div className="toolbar" style={{ padding: '0 16px' }}>
              {['ALL', 'PENDING', 'DEAD', 'DONE'].map((value) => (
                <button key={value} className={'btn sm ' + (status === value ? 'primary' : 'ghost')} onClick={() => setStatus(value)}>
                  {titleCase(value)}
                </button>
              ))}
              <span className="tiny faint">Replay is safe: handlers are idempotent by inbox key.</span>
            </div>
            {!outbox ? (
              <div style={{ padding: 18 }}><div className="skeleton" style={{ height: 240 }} /></div>
            ) : (
              <Table
                columns={[
                  { key: 'seq', label: 'Seq', align: 'right' },
                  { key: 'topic', label: 'Topic' },
                  { key: 'aggregate', label: 'Aggregate' },
                  { key: 'status', label: 'Status' },
                  { key: 'attempts', label: 'Attempts', align: 'right' },
                  { key: 'error', label: 'Last error' },
                  { key: 'created', label: 'Created' },
                  { key: 'action', label: '', align: 'right' },
                ]}
                rows={outbox.items || []}
                rowKey={(row: any) => String(row.seq)}
                onRow={(row: any) => setSelected({ outbox: row })}
                height={460}
                dense
                empty={<Empty title="No events in this state" />}
                render={(row: any) => (
                  <>
                    <td className="right mono tiny">{row.seq}</td>
                    <td className="mono small">{row.topic}</td>
                    <td className="tiny faint">{row.aggregate_type} · {String(row.aggregate_id).slice(0, 8)}</td>
                    <td><Status value={row.status} /></td>
                    <td className="right mono tiny">{row.attempts}</td>
                    <td className="tiny red truncate" style={{ maxWidth: 220 }}>{row.last_error || ''}</td>
                    <td className="tiny faint nowrap">{relative(row.created_at)}</td>
                    <td className="right">
                      {row.status === 'DEAD' && ctx.can('replay') && (
                        <button
                          className="btn xs"
                          onClick={async (event) => {
                            event.stopPropagation();
                            await ctx.mutate(`/outbox/${row.id}/replay`, {}, { success: 'Dead event replayed' });
                            await ctx.refresh(true);
                          }}
                        >
                          Replay
                        </button>
                      )}
                    </td>
                  </>
                )}
              />
            )}
            {outbox?.topics && (
              <div style={{ padding: '4px 16px 16px' }}>
                <div className="section-title">Topics</div>
                <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 8 }}>
                  {outbox.topics.map((topic: any) => (
                    <div key={topic.topic} className="hint-box" style={{ padding: '8px 10px' }}>
                      <div className="mono tiny truncate">{topic.topic}</div>
                      <div className="row tight tiny faint" style={{ marginTop: 3 }}>
                        <span>{topic.done} done</span>
                        {topic.pending ? <span className="amber">{topic.pending} queued</span> : null}
                        {topic.dead ? <span className="red">{topic.dead} dead</span> : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'stream' && (
          <Table
            columns={[
              { key: 'seq', label: 'Seq', align: 'right' },
              { key: 'topic', label: 'Topic' },
              { key: 'aggregate', label: 'Aggregate' },
              { key: 'when', label: 'Received' },
              { key: 'payload', label: 'Payload' },
            ]}
            rows={ctx.events}
            rowKey={(row: StreamEvent) => String(row.seq)}
            height={480}
            dense
            empty={<Empty title="Waiting for events" hint="Committed outbox records appear here in order." />}
            render={(row: StreamEvent) => (
              <>
                <td className="right mono tiny">{row.seq}</td>
                <td className="mono small accent">{row.topic}</td>
                <td className="tiny faint">{row.aggregate_type} · {String(row.aggregate_id).slice(0, 8)}</td>
                <td className="tiny faint">{clock(row.created_at)}</td>
                <td className="tiny faint mono truncate" style={{ maxWidth: 340 }}>{JSON.stringify(row.payload)}</td>
              </>
            )}
          />
        )}
      </Panel>

      {selected?.outbox && (
        <Drawer
          title={<span className="mono">{selected.outbox.topic}</span>}
          subtitle={`seq ${selected.outbox.seq} · ${selected.outbox.status}`}
          onClose={() => setSelected(null)}
        >
          <div className="stack">
            <div className="stack tight">
              <div className="kv"><span>Aggregate</span><span className="mono">{selected.outbox.aggregate_type}/{selected.outbox.aggregate_id.slice(0, 12)}</span></div>
              <div className="kv"><span>Attempts</span><span className="mono">{selected.outbox.attempts} / {selected.outbox.max_attempts}</span></div>
              <div className="kv"><span>Created</span><span>{new Date(selected.outbox.created_at).toLocaleString('en-GB')}</span></div>
              <div className="kv"><span>Processed</span><span>{selected.outbox.processed_at ? new Date(selected.outbox.processed_at).toLocaleString('en-GB') : '—'}</span></div>
            </div>
            {selected.outbox.last_error && <div className="danger-box">{selected.outbox.last_error}</div>}
            {selected.outbox.status === 'DEAD' && ctx.can('replay') && (
              <button
                className="btn primary"
                onClick={async () => {
                  await ctx.mutate(`/outbox/${selected.outbox.id}/replay`, {}, { success: 'Dead event replayed' });
                  await ctx.refresh(true);
                  setSelected(null);
                }}
              >
                <Icon name="refresh" size={14} /> Replay this event
              </button>
            )}
            <div>
              <div className="section-title">Payload</div>
              <pre className="json">{JSON.stringify(selected.outbox.payload, null, 2)}</pre>
            </div>
          </div>
        </Drawer>
      )}

      {selected?.seq && (
        <Drawer
          title={selected.action}
          subtitle={`Audit entry #${selected.seq} · ${selected.entity_type}`}
          onClose={() => setSelected(null)}
        >
          <div className="stack">
            <div className="stack tight">
              <div className="kv"><span>Hash</span><span className="mono tiny">{selected.entry_hash}</span></div>
              <div className="kv"><span>Previous</span><span className="mono tiny">{selected.previous_hash}</span></div>
              <div className="kv"><span>Request</span><span className="mono tiny">{selected.request_id}</span></div>
              <div className="kv"><span>Actor</span><span className="mono tiny">{selected.actor_id || 'system'}</span></div>
              <div className="kv"><span>When</span><span>{new Date(selected.created_at).toLocaleString('en-GB')}</span></div>
            </div>
            <div className="diff">
              <div>
                <div className="section-title">Before</div>
                <pre className="before">{JSON.stringify(selected.before_data, null, 2) || 'null'}</pre>
              </div>
              <div>
                <div className="section-title">After</div>
                <pre className="after">{JSON.stringify(selected.after_data, null, 2) || 'null'}</pre>
              </div>
            </div>
            <div className="hint-box">
              Each entry hashes its own contents plus the previous hash. Altering history breaks verification from that point forward.
            </div>
          </div>
        </Drawer>
      )}
    </div>
  );
}
