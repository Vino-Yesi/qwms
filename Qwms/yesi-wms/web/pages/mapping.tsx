import { useMemo, useState } from 'react';
import { amount, providerLabel, relative, titleCase } from '../api';
import { Badge, Copy, Empty, Field, Icon, Metric, Modal, Panel, ProviderMark, Status, Table, Tabs } from '../components';
import type { Ctx, Mapping, PendingMapping } from '../types';

export function Mapping({ ctx }: { ctx: Ctx }) {
  const [tab, setTab] = useState('pending');
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<PendingMapping | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const products = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of ctx.data.inventory) if (!map.has(row.sku)) map.set(row.sku, row.name);
    for (const row of ctx.data.mappings) if (!map.has(row.sku)) map.set(row.sku, row.product_name || row.sku);
    return Array.from(map.entries()).map(([sku, name]) => ({ sku, name })).sort((a, b) => a.sku.localeCompare(b.sku));
  }, [ctx.data.inventory, ctx.data.mappings]);

  const approved = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return ctx.data.mappings
      .filter((row) => !needle || row.external_sku.toLowerCase().includes(needle) || row.sku.toLowerCase().includes(needle) || (row.product_name || '').toLowerCase().includes(needle))
      .sort((a, b) => a.sku.localeCompare(b.sku));
  }, [ctx.data.mappings, query]);

  const pending = ctx.data.pending_mappings;
  const waiting = pending.reduce((sum, row) => sum + Number(row.orders_waiting), 0);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Catalogue</div>
          <h1>SKU mapping</h1>
          <p>Marketplace identifiers are translated into internal SKUs before stock is ever touched. Unmapped lines block reservation instead of guessing.</p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => setCreateOpen(true)} disabled={!ctx.can('mapping')}>
            <Icon name="plus" size={14} /> New product
          </button>
        </div>
      </div>

      <div className="metrics">
        <Metric label="Waiting mappings" value={amount(pending.length)} icon="tag" tone={pending.length ? 'warn' : 'good'} sub={`${waiting} orders blocked`} />
        <Metric label="Approved mappings" value={amount(ctx.data.mappings.length)} icon="check" tone="good" sub="across all channels" />
        <Metric label="Channels covered" value={amount(new Set(ctx.data.mappings.map((row) => row.connection_id)).size)} icon="link" sub={`${ctx.data.connections.length} connectors`} />
        <Metric label="Auto-match rate" value={`${ctx.data.mappings.length + pending.length ? Math.round((ctx.data.mappings.length / (ctx.data.mappings.length + pending.length)) * 100) : 100}%`} icon="activity" sub="exact or suggested" />
      </div>

      <Panel flush>
        <div style={{ padding: '6px 16px 0' }}>
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'pending', label: 'Needs decision', count: pending.length },
              { id: 'approved', label: 'Approved', count: ctx.data.mappings.length },
            ]}
          />
          {tab === 'approved' && (
            <div className="toolbar">
              <div className="search">
                <Icon name="search" size={14} />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="External SKU, internal SKU, product…" aria-label="Search mappings" />
              </div>
            </div>
          )}
        </div>

        {tab === 'pending' ? (
          pending.length === 0 ? (
            <Empty title="Every SKU is mapped" hint="New unmapped marketplace lines will appear here with the orders they block." />
          ) : (
            <Table
              columns={[
                { key: 'external', label: 'Marketplace SKU' },
                { key: 'channel', label: 'Channel' },
                { key: 'orders', label: 'Orders waiting', align: 'right' },
                { key: 'seen', label: 'First seen' },
                { key: 'suggestion', label: 'Suggestion' },
                { key: 'action', label: '', align: 'right' },
              ]}
              rows={pending}
              rowKey={(row: PendingMapping) => `${row.connection_id}:${row.external_sku}`}
              height={420}
              empty={<Empty />}
              render={(row: PendingMapping) => (
                <>
                  <td>
                    <div className="cell-primary mono">{row.external_sku}</div>
                    <div className="cell-sub">{row.external_name || '—'}</div>
                  </td>
                  <td>
                    <div className="row tight">
                      <ProviderMark provider={row.provider} size={18} />
                      <span className="small">{providerLabel(row.provider)}</span>
                    </div>
                  </td>
                  <td className="right mono">{row.orders_waiting}</td>
                  <td className="tiny faint">{relative(row.first_seen)}</td>
                  <td className="small mono">{row.suggestion || <span className="faint">no candidate</span>}</td>
                  <td className="right">
                    <button className="btn sm primary" onClick={() => setTarget(row)} disabled={!ctx.can('mapping')}>
                      Map SKU
                    </button>
                  </td>
                </>
              )}
            />
          )
        ) : (
          <Table
            columns={[
              { key: 'external', label: 'Marketplace SKU' },
              { key: 'internal', label: 'Internal SKU' },
              { key: 'product', label: 'Product' },
              { key: 'channel', label: 'Channel' },
              { key: 'confidence', label: 'Confidence', align: 'right' },
              { key: 'created', label: 'Approved', align: 'right' },
            ]}
            rows={approved}
            rowKey={(row: Mapping) => row.id}
            height={520}
            dense
            empty={<Empty title="No mappings match" />}
            render={(row: Mapping) => (
              <>
                <td className="mono small">{row.external_sku}<div className="cell-sub">{row.external_name}</div></td>
                <td className="mono small">{row.sku}</td>
                <td className="small">{row.product_name || <span className="faint">unknown product</span>}</td>
                <td>
                  <div className="row tight">
                    <ProviderMark provider={row.provider} size={16} />
                    <span className="tiny faint">{row.connection_name}</span>
                  </div>
                </td>
                <td className="right mono tiny">{Math.round(Number(row.confidence) * 100)}%</td>
                <td className="right tiny faint">{relative(row.created_at)}</td>
              </>
            )}
          />
        )}
      </Panel>

      {target && (
        <MapModal
          pending={target}
          products={products}
          onClose={() => setTarget(null)}
          onSubmit={async (sku) => {
            await ctx.mutate(
              '/sku-mappings',
              { connection_id: target.connection_id, external_sku: target.external_sku, sku, external_name: target.external_name || undefined },
              { success: `Mapped ${target.external_sku} → ${sku}` },
            );
            await ctx.refresh(true);
            setTarget(null);
          }}
        />
      )}

      {createOpen && (
        <CreateProductModal
          connections={ctx.data.connections}
          onClose={() => setCreateOpen(false)}
          onSubmit={async (body) => {
            await ctx.mutate('/sku-mappings/product', body, { success: 'Product created and mapped' });
            await ctx.refresh(true);
            setCreateOpen(false);
          }}
        />
      )}
    </div>
  );
}

function MapModal({ pending, products, onClose, onSubmit }: { pending: PendingMapping; products: Array<{ sku: string; name: string }>; onClose: () => void; onSubmit: (sku: string) => Promise<void> }) {
  const [sku, setSku] = useState(pending.suggestion || products[0]?.sku || '');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Approve a mapping"
      subtitle={`${providerLabel(pending.provider)} · ${pending.external_sku}${pending.external_name ? ` · ${pending.external_name}` : ''}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!sku || busy}
            onClick={async () => {
              setBusy(true);
              await onSubmit(sku);
              setBusy(false);
            }}
          >
            {busy ? 'Approving…' : 'Approve mapping'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Internal SKU" hint="Waiting orders are repaired and re-validated immediately.">
          <select className="select" value={sku} onChange={(event) => setSku(event.target.value)}>
            <option value="">Select a product…</option>
            {products.map((product) => (
              <option key={product.sku} value={product.sku}>{product.sku} — {product.name}</option>
            ))}
          </select>
        </Field>
        <div className="hint-box">
          {pending.orders_waiting} order(s) blocked · seen {pending.occurrences} time(s) since {new Date(pending.first_seen).toLocaleString('en-GB')}
        </div>
      </div>
    </Modal>
  );
}

function CreateProductModal({ connections, onClose, onSubmit }: { connections: Ctx['data']['connections']; onClose: () => void; onSubmit: (body: any) => Promise<void> }) {
  const [connectionId, setConnectionId] = useState(connections[0]?.id || '');
  const [externalSku, setExternalSku] = useState('');
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('General');
  const [cost, setCost] = useState('10');
  const [busy, setBusy] = useState(false);
  const valid = connectionId && externalSku.trim() && sku.trim() && name.trim();
  return (
    <Modal
      title="Create product & mapping"
      subtitle="One transaction: product, stock position at the dock, and the approved marketplace mapping."
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!valid || busy}
            onClick={async () => {
              setBusy(true);
              await onSubmit({
                connection_id: connectionId,
                external_sku: externalSku.trim(),
                sku: sku.trim().toUpperCase(),
                name: name.trim(),
                category,
                cost_minor: Math.round(Number(cost) * 100),
              });
              setBusy(false);
            }}
          >
            {busy ? 'Creating…' : 'Create product'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Marketplace connection">
          <select className="select" value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>{connection.name}</option>
            ))}
          </select>
        </Field>
        <div className="row">
          <Field label="External SKU">
            <input className="input mono" value={externalSku} onChange={(event) => setExternalSku(event.target.value)} placeholder="OZ-NEW-001" />
          </Field>
          <Field label="Internal SKU">
            <input className="input mono" value={sku} onChange={(event) => setSku(event.target.value)} placeholder="ELC-9001" />
          </Field>
        </div>
        <Field label="Product name">
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <div className="row">
          <Field label="Category">
            <input className="input" value={category} onChange={(event) => setCategory(event.target.value)} />
          </Field>
          <Field label="Unit cost (₽)" hint="Used for COGS and inventory valuation.">
            <input className="input" type="number" value={cost} onChange={(event) => setCost(event.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
