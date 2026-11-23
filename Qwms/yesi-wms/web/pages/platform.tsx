import { useEffect, useState } from 'react';
import { api, relative, titleCase } from '../api';
import { Badge, Empty, Icon, KeyValue, Metric, Panel, Status, Table } from '../components';
import type { Ctx } from '../types';

export function Platform({ ctx }: { ctx: Ctx }) {
  const [status, setStatus] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setStatus(await api<any>('/platform/status'));
    } catch (error: any) {
      ctx.notify(error.message, 'error');
    }
  }

  useEffect(() => {
    load();
  }, [ctx.data.sequence]);

  const autopilot = status?.flags?.find((flag: any) => flag.key === 'autopilot');

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Runtime</div>
          <h1>Platform</h1>
          <p>Environment, worker health, feature flags and the API contract. Production mode refuses demo seeds and live connectors without certification.</p>
        </div>
        <div className="page-actions">
          <a className="btn" href="/openapi.json" target="_blank" rel="noreferrer">
            <Icon name="file" size={14} /> OpenAPI
          </a>
          <a className="btn" href="/health" target="_blank" rel="noreferrer">
            <Icon name="activity" size={14} /> Health
          </a>
        </div>
      </div>

      <div className="metrics">
        <Metric label="Environment" value={titleCase(status?.environment || ctx.data.environment)} icon="layers" sub={`v${status?.version || '1.0.0'}`} />
        <Metric label="Uptime" value={status ? formatUptime(status.uptime_seconds) : '—'} icon="clock" sub="since last deploy" />
        <Metric label="Worker" value={status?.worker?.pending ?? ctx.data.worker.pending} icon="activity" tone={status?.worker?.dead ? 'bad' : 'good'} sub={`${status?.worker?.dead ?? 0} dead · ${status?.worker?.processing ?? 0} active`} />
        <Metric label="Connectors" value={`${ctx.data.connector_health.filter((row) => row.status === 'enabled').length}/${ctx.data.connector_health.length}`} icon="link" sub={status?.mode || 'sandbox'} />
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr)' }}>
        <Panel title="Runtime contract" subtitle="What this deployment enforces">
          <div className="stack tight">
            <KeyValue k="Database" v={<span className="mono">PostgreSQL · append-only ledger</span>} />
            <KeyValue k="Event transport" v={<span className="mono">outbox + LISTEN <span className="faint">yesi_events</span></span>} />
            <KeyValue k="Realtime" v={<span className="mono">WebSocket · 30s single-use tickets</span>} />
            <KeyValue k="Auth" v={<span className="mono">scrypt · TOTP · HttpOnly session + CSRF</span>} />
            <KeyValue k="Audit" v={<span className="mono">SHA-256 chain under advisory lock</span>} />
            <KeyValue k="Idempotency" v={<span className="mono">required on every mutation</span>} />
            <KeyValue k="Connector secrets" v={<span className="mono">AES-256-GCM at rest · 24h rotation grace</span>} />
            <KeyValue k="Live connectors" v={status?.live_connectors ? <Badge tone="green">enabled</Badge> : <Badge tone="slate">locked</Badge>} />
          </div>
          <div className="footer-note">
            <span>{status?.outbox_topics?.length || 0} event topics</span>
            <span>Retries: exponential backoff → DEAD → replay</span>
          </div>
        </Panel>

        <div className="stack">
          <Panel title="Sandbox autopilot" subtitle="Development only; drives the real domain services">
            <div className="between">
              <div>
                <div className="small">{autopilot?.value === false ? 'Paused' : 'Running'}</div>
                <div className="tiny faint" style={{ marginTop: 3 }}>
                  Reserves, waves, packs, books and tracks orders so the console stays alive.
                </div>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={autopilot ? autopilot.value !== false : true}
                  disabled={busy || !status || !ctx.can('admin') || status?.environment === 'production'}
                  onChange={async (event) => {
                    setBusy(true);
                    try {
                      await ctx.mutate('/platform/autopilot', { enabled: event.target.checked }, { success: event.target.checked ? 'Autopilot resumed' : 'Autopilot paused' });
                      await load();
                    } finally {
                      setBusy(false);
                    }
                  }}
                  aria-label="Toggle autopilot"
                />
                <span className="switch-track" />
              </label>
            </div>
            <div className="hint-box" style={{ marginTop: 12 }}>
              Autopilot refuses to run outside development. Every action it takes is attributed to a system actor in the audit chain.
            </div>
          </Panel>

          <Panel title="Recent integrity runs" flush>
            {status?.reconciliation_runs?.length ? (
              <div style={{ padding: '4px 18px 12px' }}>
                {status.reconciliation_runs.slice(0, 4).map((run: any) => (
                  <div className="check-row" key={run.id}>
                    <span className={'check-icon ' + (run.status === 'OK' ? 'ok' : 'bad')}>
                      <Icon name={run.status === 'OK' ? 'check' : 'alert'} size={12} />
                    </span>
                    <span className="check-label">{titleCase(run.kind)}</span>
                    <span className="check-value">{run.findings} findings · {relative(run.started_at)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <Empty title="No runs yet" />
            )}
          </Panel>
        </div>
      </div>

      <Panel title="Event topics" subtitle="Delivery state per topic" flush>
        {status?.outbox_topics?.length ? (
          <Table
            columns={[
              { key: 'topic', label: 'Topic' },
              { key: 'done', label: 'Done', align: 'right' },
              { key: 'pending', label: 'Pending', align: 'right' },
              { key: 'dead', label: 'Dead', align: 'right' },
              { key: 'last', label: 'Last seq', align: 'right' },
              { key: 'state', label: 'State' },
            ]}
            rows={status.outbox_topics}
            rowKey={(row: any) => row.topic}
            height={320}
            dense
            render={(row: any) => (
              <>
                <td className="mono small">{row.topic}</td>
                <td className="right mono">{row.done}</td>
                <td className={'right mono ' + (row.pending ? 'amber' : '')}>{row.pending}</td>
                <td className={'right mono ' + (row.dead ? 'red' : '')}>{row.dead}</td>
                <td className="right mono tiny faint">{row.last_seq}</td>
                <td><Status value={row.dead ? 'DEAD' : row.pending ? 'PENDING' : 'OK'} /></td>
              </>
            )}
          />
        ) : (
          <Empty title="No topics recorded" />
        )}
      </Panel>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
        <Panel title="Security posture">
          <div className="stack tight">
            <div className="check-row"><span className="check-icon ok"><Icon name="check" size={12} /></span><span className="check-label">Session cookies</span><span className="check-value">HttpOnly · Strict</span></div>
            <div className="check-row"><span className="check-icon ok"><Icon name="check" size={12} /></span><span className="check-label">CSRF on mutations</span><span className="check-value">required</span></div>
            <div className="check-row"><span className="check-icon ok"><Icon name="check" size={12} /></span><span className="check-label">Rate limiting</span><span className="check-value">per route</span></div>
            <div className="check-row"><span className="check-icon ok"><Icon name="check" size={12} /></span><span className="check-label">Webhook replay window</span><span className="check-value">5 min</span></div>
          </div>
        </Panel>
        <Panel title="Access" subtitle="Your session">
          <div className="stack tight">
            <KeyValue k="Identity" v={<span className="mono small">{ctx.actor.email}</span>} />
            <KeyValue k="Role" v={<Badge tone="green">{ctx.actor.role}</Badge>} />
            <KeyValue k="Permissions" v={<span className="mono tiny">{ctx.actor.permissions.length}</span>} />
          </div>
          <div className="btn-row" style={{ marginTop: 12 }}>
            {ctx.actor.permissions.map((permission: string) => (
              <span key={permission} className="badge slate">{permission}</span>
            ))}
          </div>
        </Panel>
        <Panel title="Docs" subtitle="Operational entry points">
          <div className="stack tight">
            <a className="kv" href="/openapi.json" target="_blank" rel="noreferrer"><span>OpenAPI 3.1</span><span className="mono tiny">/openapi.json</span></a>
            <a className="kv" href="/health" target="_blank" rel="noreferrer"><span>Health</span><span className="mono tiny">/health</span></a>
            <a className="kv" href="/metrics" target="_blank" rel="noreferrer"><span>Prometheus</span><span className="mono tiny">/metrics</span></a>
            <div className="kv"><span>Webhook</span><span className="mono tiny">/api/v1/integrations/:id/webhooks</span></div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (!seconds && seconds !== 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86_400)}d`;
}
