import { useEffect, useMemo, useState } from 'react';
import { api, money, relative, titleCase } from '../api';
import { Badge, Empty, Icon, Metric, Panel, Status, Table } from '../components';
import type { Ctx } from '../types';

export function Finance({ ctx }: { ctx: Ctx }) {
  const [journals, setJournals] = useState<any[] | null>(null);
  const [selected, setSelected] = useState<any | null>(null);

  useEffect(() => {
    let active = true;
    api<any>('/finance/journals')
      .then((value) => active && setJournals(value.items || []))
      .catch((error) => ctx.notify(error.message, 'error'));
    return () => {
      active = false;
    };
  }, [ctx.data.sequence]);

  const stats = useMemo(() => {
    if (!journals) return null;
    const sum = (kind: string) => journals.filter((row) => row.kind === kind).reduce((total, row) => total + Number(row.amount_minor), 0);
    const revenue = sum('SALE');
    const cogs = sum('COGS');
    const acked = journals.filter((row) => row.erp_status === 'ACK').length;
    return {
      revenue,
      cogs,
      margin: revenue ? ((revenue - cogs) / revenue) * 100 : 0,
      ackRate: journals.length ? Math.round((acked / journals.length) * 100) : 100,
      pending: journals.filter((row) => row.erp_status !== 'ACK').length,
    };
  }, [journals]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Financial control</div>
          <h1>Revenue & ERP postings</h1>
          <p>Dispatch recognises revenue and COGS as balanced double-entry journals, then pushes them to the ERP with an idempotent posting key.</p>
        </div>
        <div className="page-actions">
          <Badge tone={stats?.pending ? 'amber' : 'green'} dot>{stats?.pending ? `${stats.pending} awaiting ERP` : 'ERP in sync'}</Badge>
        </div>
      </div>

      <div className="metrics">
        <Metric label="Revenue recognised" value={money(stats?.revenue || 0)} icon="finance" tone="good" sub="posted at dispatch" />
        <Metric label="Cost of goods" value={money(stats?.cogs || 0)} icon="box" sub="weighted cost" />
        <Metric label="Gross margin" value={`${(stats?.margin || 0).toFixed(1)}%`} icon="activity" tone={(stats?.margin || 0) > 30 ? 'good' : 'warn'} sub="before fees" />
        <Metric label="ERP acknowledged" value={`${stats?.ackRate ?? 100}%`} icon="check" tone={stats?.ackRate === 100 ? 'good' : 'warn'} sub={`${stats?.pending || 0} pending`} />
      </div>

      <Panel title="Journal entries" subtitle="Every entry must balance: Σ debits = Σ credits" flush>
        {!journals ? (
          <div style={{ padding: 18 }}><div className="skeleton" style={{ height: 220 }} /></div>
        ) : (
          <Table
            columns={[
              { key: 'when', label: 'Posted' },
              { key: 'kind', label: 'Kind' },
              { key: 'order', label: 'Order' },
              { key: 'key', label: 'Posting key' },
              { key: 'amount', label: 'Amount', align: 'right' },
              { key: 'erp', label: 'ERP' },
              { key: 'status', label: 'Ledger' },
            ]}
            rows={journals}
            rowKey={(row: any) => row.id}
            onRow={(row: any) => setSelected(row)}
            height={520}
            empty={<Empty title="No postings yet" hint="Dispatch an order to recognise revenue." />}
            render={(row: any) => (
              <>
                <td className="tiny faint nowrap">{new Date(row.created_at).toLocaleString('en-GB')}</td>
                <td><span className="small">{titleCase(row.kind)}</span></td>
                <td className="mono small">{row.external_id || row.order_id.slice(0, 8)}</td>
                <td className="mono tiny faint">{row.posting_key}</td>
                <td className="right mono">{money(row.amount_minor)}</td>
                <td><Status value={row.erp_status || 'PENDING'} /></td>
                <td><Status value={row.status} /></td>
              </>
            )}
          />
        )}
      </Panel>

      {selected && (
        <Panel title={`${titleCase(selected.kind)} · ${money(selected.amount_minor)}`} subtitle={selected.posting_key} action={<button className="btn sm ghost" onClick={() => setSelected(null)}>Close</button>}>
          <div className="stack">
            <div className="between">
              <Status value={selected.status} />
              <span className="tiny faint">ERP reference {selected.erp_reference || '—'} · {selected.erp_status || 'PENDING'}</span>
            </div>
            <Table
              columns={[
                { key: 'account', label: 'Account' },
                { key: 'memo', label: 'Memo' },
                { key: 'debit', label: 'Debit', align: 'right' },
                { key: 'credit', label: 'Credit', align: 'right' },
              ]}
              rows={selected.lines || []}
              rowKey={(row: any) => row.id}
              height={240}
              dense
              render={(row: any) => (
                <>
                  <td className="mono small">{row.account}</td>
                  <td className="small muted">{row.memo}</td>
                  <td className="right mono">{row.debit_minor ? money(row.debit_minor) : '—'}</td>
                  <td className="right mono">{row.credit_minor ? money(row.credit_minor) : '—'}</td>
                </>
              )}
            />
            <div className="between tiny faint">
              <span>Balanced: {selected.lines?.reduce((sum: number, line: any) => sum + Number(line.debit_minor), 0) === selected.lines?.reduce((sum: number, line: any) => sum + Number(line.credit_minor), 0) ? 'yes' : 'no'}</span>
              <span>Posted {relative(selected.posted_at || selected.created_at)}</span>
            </div>
            {selected.erp_response && (
              <>
                <div className="section-title">ERP response</div>
                <pre className="json">{JSON.stringify(selected.erp_response, null, 2)}</pre>
              </>
            )}
          </div>
        </Panel>
      )}

      <div className="footer-note">
        <span className="row tight"><Icon name="shield" size={12} /> Journals and lines are append-only; corrections are new entries.</span>
        <span>Chart: 1100 receivable · 4000 revenue · 5000 COGS · 1200 inventory</span>
      </div>
    </div>
  );
}
