import { useEffect, useState } from 'react';
import { api, relative, titleCase } from '../api';
import { Badge, Empty, Icon, Metric, Panel, Status, Table } from '../components';
import type { Ctx } from '../types';

type Report = {
  checked_at: string;
  ledger_drift: any[];
  reservation_drift: any[];
  missing_journals: any[];
  stale_postings: any[];
  dead_events: any[];
  runs: any[];
  balanced: boolean;
};

export function Reconciliation({ ctx }: { ctx: Ctx }) {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('ledger');

  async function load() {
    try {
      setReport(await api<Report>('/reconciliation'));
    } catch (error: any) {
      ctx.notify(error.message, 'error');
    }
  }

  useEffect(() => {
    load();
  }, [ctx.data.sequence]);

  const checks = report
    ? [
        { id: 'ledger', label: 'Ledger ↔ inventory', rows: report.ledger_drift, hint: 'On-hand balances must equal the latest ledger entry per position.' },
        { id: 'reservation', label: 'Reservations ↔ reserved stock', rows: report.reservation_drift, hint: 'Active reservation quantities must equal the reserved counter.' },
        { id: 'journals', label: 'Shipped orders ↔ journals', rows: report.missing_journals, hint: 'Every shipped or delivered order needs a posted journal.' },
        { id: 'erp', label: 'ERP postings settled', rows: report.stale_postings, hint: 'Postings left pending beyond the grace window.' },
        { id: 'dead', label: 'Dead outbox events', rows: report.dead_events, hint: 'Terminal failures that need replay.' },
      ]
    : [];

  const failing = checks.filter((check) => check.rows.length > 0).length;
  const active = checks.find((check) => check.id === tab);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Data integrity</div>
          <h1>Reconciliation</h1>
          <p>Independent assertions over the ledger, reservations, journals, ERP and event bus. Findings become exceptions with owners — not dashboards to ignore.</p>
        </div>
        <div className="page-actions">
          <Badge tone={report?.balanced ? 'green' : 'red'} dot>
            {report ? (report.balanced ? 'All checks pass' : `${failing} checks failing`) : 'Loading'}
          </Badge>
          <button
            className="btn primary"
            disabled={busy || !ctx.can('finance')}
            onClick={async () => {
              setBusy(true);
              try {
                await ctx.mutate('/reconciliation/run', {}, { success: 'Integrity sweep completed' });
                await load();
                await ctx.refresh(true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Icon name="refresh" size={14} /> {busy ? 'Sweeping…' : 'Run sweep'}
          </button>
        </div>
      </div>

      <div className="metrics">
        <Metric label="Checks passing" value={`${checks.length - failing}/${checks.length || 5}`} icon="shield" tone={failing ? 'bad' : 'good'} sub="continuous assertions" />
        <Metric label="Ledger drift" value={report?.ledger_drift.length ?? '—'} icon="database" tone={(report?.ledger_drift.length || 0) > 0 ? 'bad' : 'good'} sub="positions out of balance" />
        <Metric label="Reservation drift" value={report?.reservation_drift.length ?? '—'} icon="lock" tone={(report?.reservation_drift.length || 0) > 0 ? 'bad' : 'good'} sub="counter mismatches" />
        <Metric label="Last sweep" value={report ? relative(report.checked_at) : '—'} icon="clock" sub={report?.runs?.[0]?.duration_ms ? `${report.runs[0].duration_ms} ms` : 'not yet run'} />
      </div>

      {!report ? (
        <Panel><div className="skeleton" style={{ height: 220 }} /></Panel>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1.6fr)' }}>
          <Panel title="Assertions" subtitle={`Checked ${new Date(report.checked_at).toLocaleString('en-GB')}`}>
            {checks.map((check) => (
              <button
                key={check.id}
                className="check-row"
                style={{ width: '100%', background: tab === check.id ? 'rgba(200,245,111,.04)' : 'transparent', border: 0, borderBottom: '1px solid rgba(27,42,34,.55)', color: 'inherit', cursor: 'pointer', textAlign: 'left' }}
                onClick={() => setTab(check.id)}
              >
                <span className={'check-icon ' + (check.rows.length ? 'bad' : 'ok')}>
                  <Icon name={check.rows.length ? 'alert' : 'check'} size={12} />
                </span>
                <span className="grow">
                  <span className="check-label" style={{ display: 'block' }}>{check.label}</span>
                  <span className="tiny faint">{check.hint}</span>
                </span>
                <span className={'check-value ' + (check.rows.length ? 'red' : '')}>{check.rows.length}</span>
              </button>
            ))}
            <div className="hint-box" style={{ marginTop: 14 }}>
              A balanced system is the only acceptable end state. Drift files an exception and blocks the affected aggregate until repaired.
            </div>
          </Panel>

          <Panel title={active?.label || 'Findings'} subtitle={active?.hint} flush>
            {!active || active.rows.length === 0 ? (
              <Empty title="No findings" hint="This assertion is satisfied for the current snapshot." />
            ) : (
              <Table
                columns={Object.keys(active.rows[0] || {}).slice(0, 6).map((key) => ({ key, label: titleCase(key) }))}
                rows={active.rows}
                rowKey={(row: any, index: number) => JSON.stringify(row) + index}
                height={380}
                dense
                render={(row: any) => (
                  <>
                    {Object.keys(active.rows[0] || {}).slice(0, 6).map((key) => (
                      <td key={key} className={typeof row[key] === 'number' ? 'right mono' : 'small mono'}>
                        {row[key] === null ? <span className="faint">—</span> : String(row[key]).slice(0, 48)}
                      </td>
                    ))}
                  </>
                )}
              />
            )}
          </Panel>
        </div>
      )}

      <Panel title="Sweep history" subtitle="Latest first" flush>
        {!report ? null : (
          <Table
            columns={[
              { key: 'started', label: 'Started' },
              { key: 'kind', label: 'Kind' },
              { key: 'status', label: 'Status' },
              { key: 'findings', label: 'Findings', align: 'right' },
              { key: 'duration', label: 'Duration', align: 'right' },
              { key: 'details', label: 'Detail' },
            ]}
            rows={report.runs}
            rowKey={(row: any) => row.id}
            height={320}
            dense
            empty={<Empty title="No sweep recorded" hint="Run a sweep to capture a point-in-time proof." />}
            render={(row: any) => (
              <>
                <td className="small">{new Date(row.started_at).toLocaleString('en-GB')}</td>
                <td className="small">{titleCase(row.kind)}</td>
                <td><Status value={row.status} /></td>
                <td className={'right mono ' + (row.findings ? 'red' : '')}>{row.findings}</td>
                <td className="right mono tiny">{row.duration_ms !== null ? `${row.duration_ms} ms` : '—'}</td>
                <td className="tiny faint mono truncate" style={{ maxWidth: 320 }}>{row.details ? JSON.stringify(row.details) : '—'}</td>
              </>
            )}
          />
        )}
      </Panel>
    </div>
  );
}
