import { useMemo, useState } from 'react';
import { amount, relative, titleCase } from '../api';
import { Badge, Drawer, Empty, Field, Icon, Meta, Metric, Modal, Panel, Progress, Status } from '../components';
import type { Asn, Ctx } from '../types';

export function Receiving({ ctx }: { ctx: Ctx }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const asn = ctx.data.asns.find((item) => item.id === selected) || null;

  const totals = useMemo(() => {
    const expected = ctx.data.asns.reduce((sum, item) => sum + Number(item.units_expected), 0);
    const received = ctx.data.asns.reduce((sum, item) => sum + Number(item.units_received), 0);
    return {
      expected,
      received,
      open: ctx.data.asns.filter((item) => item.status !== 'RECEIVED').length,
      arrivals: ctx.data.asns.filter((item) => item.status !== 'RECEIVED' && new Date(item.expected_at).toDateString() === new Date().toDateString()).length,
    };
  }, [ctx.data.asns]);

  const products = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of ctx.data.inventory) if (!map.has(row.sku)) map.set(row.sku, row.name);
    return Array.from(map.entries()).map(([sku, name]) => ({ sku, name })).sort((a, b) => a.sku.localeCompare(b.sku));
  }, [ctx.data.inventory]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Inbound</div>
          <h1>Receiving & dock</h1>
          <p>Advance ship notices open purchase orders; receipt posts stock through the ledger, never by direct update.</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" onClick={() => setCreateOpen(true)} disabled={!ctx.can('stock')}>
            <Icon name="plus" size={14} /> New ASN
          </button>
        </div>
      </div>

      <div className="metrics">
        <Metric label="Open ASNs" value={amount(totals.open)} icon="receive" sub={`${ctx.data.asns.length} total`} />
        <Metric label="Units expected" value={amount(totals.expected)} icon="box" sub={`${amount(totals.received)} received`} />
        <Metric label="Arriving today" value={amount(totals.arrivals)} icon="clock" tone={totals.arrivals ? 'accent' : 'default'} sub="scheduled dock slots" />
        <Metric label="Receipt accuracy" value={totals.expected ? `${Math.round((totals.received / totals.expected) * 100)}%` : '—'} icon="check" tone="good" sub="received vs expected" />
      </div>

      {ctx.data.asns.length === 0 ? (
        <Panel><Empty title="No inbound shipments" hint="Create an ASN to schedule a delivery." /></Panel>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
          {ctx.data.asns.map((item: Asn) => {
            const progress = item.units_expected ? (item.units_received / item.units_expected) * 100 : 0;
            return (
              <button
                key={item.id}
                className="panel"
                style={{ textAlign: 'left', cursor: 'pointer', color: 'inherit', padding: 0, background: 'var(--panel)' }}
                onClick={() => setSelected(item.id)}
              >
                <div style={{ padding: '16px 18px' }}>
                  <div className="between">
                    <div>
                      <div className="row tight">
                        <span className="cell-primary">{item.supplier}</span>
                        <Badge tone={item.status === 'RECEIVED' ? 'green' : 'blue'}>{item.status === 'RECEIVED' ? 'Received' : item.status === 'IN_RECEIVING' ? 'In receiving' : 'Expected'}</Badge>
                      </div>
                      <div className="tiny faint mono" style={{ marginTop: 4 }}>{item.reference} · {item.lines.length} line(s)</div>
                    </div>
                    <Status value={item.status} />
                  </div>
                  <div style={{ marginTop: 16 }}>
                    <div className="between tiny" style={{ marginBottom: 6 }}>
                      <span className="muted">{amount(item.units_received)} / {amount(item.units_expected)} units</span>
                      <span className="mono">{Math.round(progress)}%</span>
                    </div>
                    <Progress value={item.units_received} max={Math.max(1, item.units_expected)} tone={progress === 100 ? 'accent' : 'amber'} />
                  </div>
                  <div className="between tiny faint" style={{ marginTop: 12 }}>
                    <span>Expected {new Date(item.expected_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                    <span>{relative(item.expected_at)}</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {asn && (
        <Drawer
          title={asn.supplier}
          subtitle={<span className="mono">{asn.reference} · {titleCase(asn.status)}</span>}
          onClose={() => setSelected(null)}
          footer={
            asn.status !== 'RECEIVED' && ctx.can('fulfill') ? (
              <button className="btn primary" onClick={() => setReceiveOpen(true)}>
                <Icon name="receive" size={14} /> Receive units
              </button>
            ) : (
              <span className="tiny faint">Posted to ledger {asn.received_at ? relative(asn.received_at) : ''}</span>
            )
          }
        >
          <div className="stack">
            <Meta
              items={[
                { label: 'Status', value: <Status value={asn.status} /> },
                { label: 'Expected', value: new Date(asn.expected_at).toLocaleString('en-GB') },
                { label: 'Created', value: relative(asn.created_at) },
              ]}
            />
            <div>
              <div className="section-title">Lines</div>
              {asn.lines.map((line) => (
                <div className="check-row" key={`${line.sku}:${line.location}`}>
                  <div className="grow">
                    <div className="small mono">{line.sku}</div>
                    <div className="tiny faint">putaway {line.location}</div>
                  </div>
                  <div className="right" style={{ minWidth: 130 }}>
                    <div className="tiny faint">{line.received} / {line.expected}</div>
                    <Progress value={line.received} max={Math.max(1, line.expected)} />
                  </div>
                </div>
              ))}
            </div>
            <div className="hint-box">
              Receipts are idempotent per ASN line and request key. Re-sending a receipt cannot inflate stock.
            </div>
          </div>
        </Drawer>
      )}

      {createOpen && (
        <CreateAsnModal
          products={products}
          onClose={() => setCreateOpen(false)}
          onSubmit={async (body) => {
            await ctx.mutate('/asns', body, { success: 'ASN created' });
            await ctx.refresh(true);
            setCreateOpen(false);
          }}
        />
      )}
      {receiveOpen && asn && (
        <ReceiveModal
          asn={asn}
          onClose={() => setReceiveOpen(false)}
          onSubmit={async (lines) => {
            await ctx.mutate(`/asns/${asn.id}/receive`, { lines }, { success: 'Receipt posted' });
            await ctx.refresh(true);
            setReceiveOpen(false);
          }}
        />
      )}
    </div>
  );
}

function CreateAsnModal({ products, onClose, onSubmit }: { products: Array<{ sku: string; name: string }>; onClose: () => void; onSubmit: (body: any) => Promise<void> }) {
  const [supplier, setSupplier] = useState('');
  const [reference, setReference] = useState(`PO-${Math.floor(10000 + Math.random() * 89999)}`);
  const [expected, setExpected] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 16));
  const [lines, setLines] = useState<Array<{ sku: string; location: string; expected: string }>>([
    { sku: products[0]?.sku || '', location: 'A-01-01', expected: '60' },
  ]);
  const [busy, setBusy] = useState(false);
  const valid = supplier.trim().length > 1 && lines.every((line) => line.sku && /^[A-Z]-\d{2}-\d{2}$/.test(line.location) && Number(line.expected) > 0);
  return (
    <Modal
      title="New advance ship notice"
      subtitle="Reserve a dock slot and tell the floor what to expect."
      width={640}
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
                supplier: supplier.trim(),
                reference: reference.trim(),
                expected_at: new Date(expected).toISOString(),
                lines: lines.map((line) => ({ sku: line.sku, location: line.location, expected: Number(line.expected) })),
              });
              setBusy(false);
            }}
          >
            {busy ? 'Creating…' : 'Create ASN'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="row">
          <Field label="Supplier">
            <input className="input" value={supplier} onChange={(event) => setSupplier(event.target.value)} placeholder="Trailhead Apparel Co" />
          </Field>
          <Field label="Reference">
            <input className="input" value={reference} onChange={(event) => setReference(event.target.value)} />
          </Field>
        </div>
        <Field label="Expected arrival">
          <input className="input" type="datetime-local" value={expected} onChange={(event) => setExpected(event.target.value)} />
        </Field>
        <div className="section-title">Lines</div>
        {lines.map((line, index) => (
          <div className="row" key={index}>
            <select
              className="select"
              value={line.sku}
              onChange={(event) => setLines(lines.map((item, i) => (i === index ? { ...item, sku: event.target.value } : item)))}
            >
              {products.map((product) => (
                <option key={product.sku} value={product.sku}>{product.sku} — {product.name}</option>
              ))}
            </select>
            <input
              className="input"
              style={{ width: 110 }}
              value={line.location}
              onChange={(event) => setLines(lines.map((item, i) => (i === index ? { ...item, location: event.target.value.toUpperCase() } : item)))}
              aria-label="Putaway location"
            />
            <input
              className="input"
              type="number"
              style={{ width: 100 }}
              value={line.expected}
              onChange={(event) => setLines(lines.map((item, i) => (i === index ? { ...item, expected: event.target.value } : item)))}
              aria-label="Expected quantity"
            />
            <button className="icon-btn" aria-label="Remove line" onClick={() => setLines(lines.filter((_, i) => i !== index))} disabled={lines.length === 1}>
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
        <button className="btn sm ghost" onClick={() => setLines([...lines, { sku: products[0]?.sku || '', location: 'A-01-01', expected: '20' }])}>
          <Icon name="plus" size={13} /> Add line
        </button>
      </div>
    </Modal>
  );
}

function ReceiveModal({ asn, onClose, onSubmit }: { asn: Asn; onClose: () => void; onSubmit: (lines: any[]) => Promise<void> }) {
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(asn.lines.map((line) => [`${line.sku}:${line.location}`, String(Math.max(0, line.expected - line.received))])),
  );
  const [busy, setBusy] = useState(false);
  const lines = asn.lines
    .map((line) => ({ sku: line.sku, location: line.location, quantity: Number(quantities[`${line.sku}:${line.location}`] || 0) }))
    .filter((line) => line.quantity > 0);
  return (
    <Modal
      title="Post receipt"
      subtitle="Quantities are added to stock through the ledger and flagged on the ASN."
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!lines.length || busy}
            onClick={async () => {
              setBusy(true);
              await onSubmit(lines);
              setBusy(false);
            }}
          >
            {busy ? 'Posting…' : `Receive ${amount(lines.reduce((sum, line) => sum + line.quantity, 0))} units`}
          </button>
        </>
      }
    >
      <div className="stack">
        {asn.lines.map((line) => {
          const key = `${line.sku}:${line.location}`;
          const remaining = Math.max(0, line.expected - line.received);
          return (
            <div className="row" key={key}>
              <div className="grow">
                <div className="small mono">{line.sku}</div>
                <div className="tiny faint">{line.location} · {remaining} remaining</div>
              </div>
              <input
                className="input"
                style={{ width: 110 }}
                type="number"
                min={0}
                max={remaining}
                value={quantities[key]}
                onChange={(event) => setQuantities({ ...quantities, [key]: event.target.value })}
                aria-label={`Quantity for ${line.sku}`}
              />
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
