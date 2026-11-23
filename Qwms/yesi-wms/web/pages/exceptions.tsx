import { useMemo, useState } from 'react';
import { relative, titleCase } from '../api';
import { Badge, Drawer, Empty, Field, Icon, Metric, Modal, Panel, Status, Table } from '../components';
import type { Ctx, ExceptionRow } from '../types';

export function Exceptions({ ctx }: { ctx: Ctx }) {
  const [filter, setFilter] = useState('OPEN');
  const [severity, setSeverity] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      ctx.data.exceptions
        .filter((row) => filter === 'ALL' || row.status === filter)
        .filter((row) => severity === 'all' || row.severity === severity)
        .sort((a, b) => {
          const weight: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
          return (weight[a.severity] ?? 9) - (weight[b.severity] ?? 9) || new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
        }),
    [ctx.data.exceptions, filter, severity],
  );

  const open = ctx.data.exceptions.filter((row) => row.status === 'OPEN');
  const high = open.filter((row) => ['HIGH', 'CRITICAL'].includes(row.severity)).length;
  const replayable = open.filter((row) => row.replayable).length;
  const exception = ctx.data.exceptions.find((row) => row.id === selected) || null;

  async function retry(row: ExceptionRow) {
    setBusy(row.id);
    try {
      await ctx.mutate(`/exceptions/${row.id}/retry`, {}, { success: 'Retry accepted' });
      await ctx.refresh(true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Reliability</div>
          <h1>Exception queue</h1>
          <p>Failures are first-class records with kind, entity, occurrence count and replayability — never silent retries. Dead events must be replayed to prove the fix.</p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => ctx.refresh()}>
            <Icon name="refresh" size={14} /> Refresh
          </button>
        </div>
      </div>

      <div className="metrics">
        <Metric label="Open exceptions" value={open.length} icon="alert" tone={open.length ? 'bad' : 'good'} sub={`${high} high or critical`} />
        <Metric label="Replayable" value={replayable} icon="refresh" tone={replayable ? 'warn' : 'default'} sub="safe to re-run" />
        <Metric label="Dead events" value={ctx.data.kpis.dead_events} icon="bolt" tone={ctx.data.kpis.dead_events ? 'bad' : 'good'} sub="outbox terminal" />
        <Metric label="Backlog" value={ctx.data.worker.pending} icon="activity" sub={`${ctx.data.worker.processing} processing`} />
      </div>

      <Panel title="Queue" subtitle="Highest severity first" flush>
        <div className="toolbar" style={{ padding: '12px 16px 0' }}>
          {['OPEN', 'RESOLVED', 'ALL'].map((status) => (
            <button key={status} className={'btn sm ' + (filter === status ? 'primary' : 'ghost')} onClick={() => setFilter(status)}>
              {titleCase(status)}
            </button>
          ))}
          <span style={{ width: 12 }} />
          {['all', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((level) => (
            <button key={level} className={'btn sm ' + (severity === level ? 'primary' : 'ghost')} onClick={() => setSeverity(level)}>
              {level === 'all' ? 'Any severity' : titleCase(level)}
            </button>
          ))}
        </div>

        <Table
          columns={[
            { key: 'kind', label: 'Kind' },
            { key: 'message', label: 'Detail' },
            { key: 'severity', label: 'Severity' },
            { key: 'state', label: 'State' },
            { key: 'occ', label: 'Occ.', align: 'right' },
            { key: 'age', label: 'Age', align: 'right' },
            { key: 'actions', label: '', align: 'right' },
          ]}
          rows={rows}
          rowKey={(row: ExceptionRow) => row.id}
          onRow={(row: ExceptionRow) => setSelected(row.id)}
          height={500}
          empty={<Empty title="Queue is clear" hint="Every exception has been resolved or ignored." />}
          render={(row: ExceptionRow) => (
            <>
              <td>
                <div className="cell-primary small">{titleCase(row.kind)}</div>
                <div className="cell-sub mono">{row.entity_type} · {row.entity_id.slice(0, 8)}</div>
              </td>
              <td style={{ maxWidth: 340 }}>
                <div className="small truncate" title={row.message}>{row.message}</div>
                <div className="cell-sub">{row.replayable ? 'replayable' : 'manual resolution'}</div>
              </td>
              <td><Status value={row.severity} /></td>
              <td><Status value={row.status} /></td>
              <td className="right mono">{row.occurrences}</td>
              <td className="right tiny faint">{relative(row.created_at)}</td>
              <td className="right">
                {row.status === 'OPEN' && row.replayable && ctx.can('replay') ? (
                  <button
                    className="btn xs"
                    disabled={busy !== null}
                    onClick={(event) => {
                      event.stopPropagation();
                      retry(row);
                    }}
                  >
                    {busy === row.id ? 'Retrying…' : 'Retry'}
                  </button>
                ) : (
                  <Icon name="chevron" size={13} className="faint" />
                )}
              </td>
            </>
          )}
        />
      </Panel>

      {exception && (
        <Drawer
          title={titleCase(exception.kind)}
          subtitle={<span className="mono">{exception.entity_type} · {exception.entity_id}</span>}
          onClose={() => setSelected(null)}
          footer={
            exception.status === 'OPEN' ? (
              <>
                {exception.replayable && ctx.can('replay') && (
                  <button className="btn" disabled={busy !== null} onClick={() => retry(exception)}>
                    <Icon name="refresh" size={14} /> Retry operation
                  </button>
                )}
                {ctx.can('supervise') && (
                  <button
                    className="btn primary"
                    onClick={() => {
                      if (exception.kind === 'OUTBOX_DEAD') {
                        ctx.notify('Replay the dead event from Audit & events first; the exception closes automatically.', 'error');
                        return;
                      }
                      setResolveOpen(true);
                    }}
                  >
                    Resolve
                  </button>
                )}
              </>
            ) : (
              <span className="tiny faint">Resolved {relative(exception.resolved_at)} by {exception.resolved_by_email || 'system'}</span>
            )
          }
        >
          <div className="stack">
            <div className="between">
              <Status value={exception.severity} />
              <Status value={exception.status} />
            </div>
            <div className="danger-box">{exception.message}</div>
            <div className="stack tight">
              <div className="kv"><span>Occurrences</span><span className="mono">{exception.occurrences}</span></div>
              <div className="kv"><span>Attempts</span><span className="mono">{exception.attempts}</span></div>
              <div className="kv"><span>Replayable</span><span>{exception.replayable ? 'yes' : 'no'}</span></div>
              <div className="kv"><span>First seen</span><span>{new Date(exception.created_at).toLocaleString('en-GB')}</span></div>
              <div className="kv"><span>Entity</span><span className="mono tiny">{exception.entity_type}/{exception.entity_id.slice(0, 12)}</span></div>
            </div>
            {exception.resolution && (
              <div className="hint-box">
                <strong>Resolution:</strong> {exception.resolution}
              </div>
            )}
            <div>
              <div className="section-title">Payload</div>
              <pre className="json">{JSON.stringify(exception.details, null, 2)}</pre>
            </div>
          </div>
        </Drawer>
      )}

      {resolveOpen && exception && (
        <ResolveModal
          onClose={() => setResolveOpen(false)}
          onSubmit={async (note) => {
            await ctx.mutate(`/exceptions/${exception.id}/resolve`, { note }, { success: 'Exception resolved' });
            await ctx.refresh(true);
            setResolveOpen(false);
          }}
        />
      )}
    </div>
  );
}

function ResolveModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (note: string) => Promise<void> }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Resolve exception"
      subtitle="The note is stored in the audit chain. Resolving does not retry the operation."
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={note.trim().length < 3 || busy}
            onClick={async () => {
              setBusy(true);
              await onSubmit(note.trim());
              setBusy(false);
            }}
          >
            {busy ? 'Resolving…' : 'Resolve'}
          </button>
        </>
      }
    >
      <Field label="Resolution note" hint="What did you do, and why is this safe to close?">
        <textarea className="textarea" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Repaired mapping and confirmed stock is correct." />
      </Field>
    </Modal>
  );
}
