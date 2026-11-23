import { useEffect, useMemo, useState } from 'react';
import { api, providerLabel, relative, titleCase } from '../api';
import { Badge, Copy, Drawer, Empty, Field, Icon, Meta, Modal, Panel, ProviderMark, Status, Table, Tabs } from '../components';
import type { Connection, Ctx } from '../types';

const SCENARIOS = [
  { id: 'normal', label: 'Normal order', hint: 'One line, healthy stock' },
  { id: 'multi_line', label: 'Multi-line order', hint: 'Several SKUs, split pick' },
  { id: 'unmapped', label: 'Unmapped SKU', hint: 'Exercises the mapping queue' },
  { id: 'cancelled', label: 'Marketplace cancel', hint: 'Releases reservations' },
  { id: 'malformed', label: 'Malformed payload', hint: 'Rejected and quarantined' },
];

export function Connectors({ ctx }: { ctx: Ctx }) {
  const [selected, setSelected] = useState<string | null>(ctx.params.id || ctx.data.connections[0]?.id || null);
  const [detail, setDetail] = useState<any>(null);
  const [tab, setTab] = useState('overview');
  const [simulateOpen, setSimulateOpen] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const connection: Connection | undefined = ctx.data.connections.find((item) => item.id === selected);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    api<any>(`/integrations/${selected}`)
      .then((value) => active && setDetail(value))
      .catch((error) => ctx.notify(error.message, 'error'));
    return () => {
      active = false;
    };
  }, [selected, ctx.data.sequence]);

  const summary = useMemo(
    () => ({
      events: ctx.data.connections.reduce((sum, item) => sum + Number(item.events_received), 0),
      failed: ctx.data.connections.reduce((sum, item) => sum + Number(item.failed_events), 0),
      orders: ctx.data.connections.reduce((sum, item) => sum + Number(item.orders), 0),
      mappings: ctx.data.connections.reduce((sum, item) => sum + Number(item.mappings), 0),
    }),
    [ctx.data.connections],
  );

  async function action(path: string, body: unknown, label: string) {
    setBusy(label);
    try {
      await ctx.mutate(path, body, { success: label });
      await ctx.refresh(true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Integration hub</div>
          <h1>Marketplace connectors</h1>
          <p>
            Signature-verified ingress, stable idempotency keys on egress and an auditable run history for every
            Ozon, Yandex Market and Wildberries call. Current mode: <strong>{ctx.data.connections[0]?.mode || 'sandbox'}</strong>.
          </p>
        </div>
        <div className="page-actions">
          <Badge tone="purple">{summary.mappings} SKU mappings</Badge>
          <button className="btn primary" onClick={() => setCreateOpen(true)} disabled={!ctx.can('integrate')}>
            <Icon name="plus" size={14} /> Connect store
          </button>
        </div>
      </div>

      <div className="connector-grid">
        {ctx.data.connections.map((item) => {
          return (
            <button
              key={item.id}
              className={'connector-card' + (item.id === selected ? ' selected' : '')}
              onClick={() => { setSelected(item.id); setTab('overview'); }}
            >
              <div className="head">
                <ProviderMark provider={item.provider} size={34} />
                <div className="grow">
                  <div className="title">{providerLabel(item.provider)}</div>
                  <div className="sub">{item.account_ref} · {item.mode}</div>
                </div>
                <Status value={item.status === 'enabled' ? 'OK' : 'PAUSED'} label={item.status} />
              </div>
              <div className="between tiny" style={{ marginBottom: 2 }}>
                <span className="faint">last sync {relative(item.last_sync_at)}</span>
                {item.last_error ? <span className="red truncate" style={{ maxWidth: 150 }}>{item.last_error}</span> : <span className="green">healthy</span>}
              </div>
              <div className="connector-stats">
                <div className="connector-stat"><b>{item.orders}</b><span>orders</span></div>
                <div className="connector-stat"><b>{item.events_received}</b><span>events</span></div>
                <div className="connector-stat"><b className={item.failed_events ? 'red' : ''}>{item.failed_events}</b><span>rejected</span></div>
              </div>
              <div className="connector-foot">
                <span className="mono">{item.id.slice(0, 8)}</span>
                <span>{item.mappings} mappings</span>
              </div>
            </button>
          );
        })}
        {ctx.data.connections.length === 0 && (
          <Panel><Empty title="No connectors yet" hint="Register a marketplace store to start ingesting orders." /></Panel>
        )}
      </div>

      {connection && (
        <Panel
          title={
            <span className="row tight">
              <ProviderMark provider={connection.provider} size={20} /> {connection.name}
            </span>
          }
          subtitle={`${connection.mode} · ${detail?.webhook_scheme || schemeFor(connection.provider)} · ${connection.account_ref}`}
          action={
            <div className="btn-row">
              <button className="btn sm" disabled={busy !== null} onClick={() => action(`/integrations/${connection.id}/sync`, {}, 'Pull requested')}>
                <Icon name="refresh" size={13} /> {busy === 'Pull requested' ? 'Pulling…' : 'Sync now'}
              </button>
              <button className="btn sm" onClick={() => setSimulateOpen(true)} disabled={!ctx.can('integrate')}>
                <Icon name="bolt" size={13} /> Simulate
              </button>
              <button
                className="btn sm ghost"
                onClick={async () => {
                  await ctx.mutate(`/integrations/${connection.id}`, { status: connection.status === 'enabled' ? 'paused' : 'enabled' }, { method: 'PATCH', success: connection.status === 'enabled' ? 'Connector paused' : 'Connector resumed' });
                  await ctx.refresh(true);
                }}
              >
                {connection.status === 'enabled' ? 'Pause' : 'Resume'}
              </button>
            </div>
          }
        >
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'overview', label: 'Overview' },
              { id: 'runs', label: 'Sync runs', count: detail?.runs?.length },
              { id: 'operations', label: 'Provider calls', count: detail?.operations?.length },
              { id: 'raw', label: 'Raw events', count: detail?.raw_events?.length },
              { id: 'lab', label: 'Payload lab' },
            ]}
          />

          {tab === 'overview' && (
            <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)' }}>
              <div className="stack">
                <Meta
                  items={[
                    { label: 'Status', value: <Status value={connection.status === 'enabled' ? 'OK' : 'PAUSED'} label={connection.status} /> },
                    { label: 'Mode', value: <Badge tone={connection.mode === 'live' ? 'green' : 'purple'}>{connection.mode}</Badge> },
                    { label: 'Account', value: <span className="mono">{connection.account_ref}</span> },
                    { label: 'Orders', value: <span className="mono">{connection.orders}</span> },
                    { label: 'Events', value: <span className="mono">{connection.events_received} ({connection.failed_events} rejected)</span> },
                    { label: 'Last webhook', value: relative(connection.last_webhook_at) },
                  ]}
                />
                <div>
                  <div className="section-title">Ingress</div>
                  <div className="hint-box">
                    <div className="between">
                      <span className="mono tiny">POST /api/v1/integrations/{connection.id}/webhooks</span>
                      <Copy value={`/api/v1/integrations/${connection.id}/webhooks`} />
                    </div>
                    <div className="tiny faint" style={{ marginTop: 6 }}>
                      HMAC-SHA256 over the raw body with a timestamped nonce. Replays outside the tolerance window are rejected.
                    </div>
                  </div>
                </div>
                <div>
                  <div className="section-title">Egress contract</div>
                  <div className="kv"><span>Status push</span><span className="mono tiny">status:{'{'}orderId{'}'}:{'{'}version{'}'}</span></div>
                  <div className="kv"><span>Stock push</span><span className="mono tiny">stock:{'{'}connection{'}'}:{'{'}hash{'}'}</span></div>
                  <div className="kv"><span>Shipment</span><span className="mono tiny">ship:{'{'}shipmentId{'}'}:{'{'}provider{'}'}</span></div>
                </div>
              </div>
              <div className="stack tight">
                <div className="section-title" style={{ margin: 0 }}>Security</div>
                <div className="check-row">
                  <span className="check-icon ok"><Icon name="lock" size={12} /></span>
                  <span className="check-label">Credentials at rest</span>
                  <span className="check-value">{detail?.has_credentials ? 'AES-GCM' : 'none'}</span>
                </div>
                <div className="check-row">
                  <span className="check-icon ok"><Icon name="shield" size={12} /></span>
                  <span className="check-label">Webhook scheme</span>
                  <span className="check-value mono">{detail?.webhook_scheme || schemeFor(connection.provider)}</span>
                </div>
                <div className="check-row">
                  <span className="check-icon ok"><Icon name="key" size={12} /></span>
                  <span className="check-label">Previous secret</span>
                  <span className="check-value">24h grace</span>
                </div>
                <button className="btn sm" style={{ marginTop: 10 }} onClick={() => setRotateOpen(true)} disabled={!ctx.can('integrate')}>
                  <Icon name="key" size={13} /> Rotate signing secret
                </button>
                <div className="hint-box" style={{ marginTop: 6 }}>
                  Live mode is gated by <span className="mono">ALLOW_LIVE_CONNECTORS</span> plus valid credentials; sandbox calls never touch a marketplace.
                </div>
              </div>
            </div>
          )}

          {tab === 'runs' && (
            <Table
              columns={[
                { key: 'started', label: 'Started' },
                { key: 'kind', label: 'Kind' },
                { key: 'status', label: 'Status' },
                { key: 'stats', label: 'Result' },
                { key: 'duration', label: 'Duration', align: 'right' },
              ]}
              rows={detail?.runs || []}
              rowKey={(row: any) => row.id}
              height={380}
              dense
              empty={<Empty title="No sync runs yet" hint="Trigger a manual pull to see the run history." />}
              render={(row: any) => (
                <>
                  <td className="small">{new Date(row.started_at).toLocaleString('en-GB')}</td>
                  <td className="small">{titleCase(row.kind)}</td>
                  <td><Status value={row.status} /></td>
                  <td className="tiny faint mono">{row.stats ? JSON.stringify(row.stats) : row.error || '—'}</td>
                  <td className="right mono tiny">{row.duration_ms !== null ? `${row.duration_ms} ms` : '—'}</td>
                </>
              )}
            />
          )}

          {tab === 'operations' && (
            <Table
              columns={[
                { key: 'when', label: 'When' },
                { key: 'operation', label: 'Operation' },
                { key: 'direction', label: 'Dir' },
                { key: 'status', label: 'Status' },
                { key: 'http', label: 'HTTP', align: 'right' },
                { key: 'attempts', label: 'Attempts', align: 'right' },
                { key: 'latency', label: 'Latency', align: 'right' },
              ]}
              rows={detail?.operations || []}
              rowKey={(row: any) => row.id}
              height={400}
              dense
              empty={<Empty title="No provider calls recorded" />}
              render={(row: any) => (
                <>
                  <td className="tiny faint nowrap">{new Date(row.created_at).toLocaleTimeString('en-GB')}</td>
                  <td className="small mono">{row.operation}</td>
                  <td className="tiny">{row.direction}</td>
                  <td><Status value={row.status} /></td>
                  <td className="right mono tiny">{row.http_status || '—'}</td>
                  <td className="right mono tiny">{row.attempts}</td>
                  <td className="right mono tiny">{row.latency_ms !== null ? `${row.latency_ms} ms` : '—'}</td>
                </>
              )}
            />
          )}

          {tab === 'raw' && (
            <Table
              columns={[
                { key: 'event', label: 'Event' },
                { key: 'type', label: 'Type' },
                { key: 'status', label: 'Status' },
                { key: 'received', label: 'Received' },
                { key: 'error', label: 'Error' },
                { key: 'action', label: '', align: 'right' },
              ]}
              rows={detail?.raw_events || []}
              rowKey={(row: any) => row.id}
              height={420}
              dense
              empty={<Empty title="No raw events yet" />}
              render={(row: any) => (
                <>
                  <td className="mono tiny truncate" style={{ maxWidth: 220 }} title={row.external_event_id}>{row.external_event_id}</td>
                  <td className="tiny">{row.event_type}</td>
                  <td><Status value={row.status} /></td>
                  <td className="tiny faint">{relative(row.received_at)}</td>
                  <td className="tiny red truncate" style={{ maxWidth: 180 }}>{row.last_error || ''}</td>
                  <td className="right">
                    {row.status !== 'PROCESSED' && ctx.can('replay') && (
                      <button
                        className="btn xs"
                        onClick={async (event) => {
                          event.stopPropagation();
                          await action(`/raw-events/${row.id}/replay`, {}, 'Raw event replayed');
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

          {tab === 'lab' && <PayloadLab connectionId={connection.id} ctx={ctx} />}
        </Panel>
      )}

      {simulateOpen && connection && (
        <SimulateModal
          provider={connection.provider}
          onClose={() => setSimulateOpen(false)}
          onSubmit={async (scenario, seed) => {
            await ctx.mutate(`/integrations/${connection.id}/simulate`, { scenario, seed }, { success: `Simulated ${scenario} payload` });
            await ctx.refresh(true);
            setSimulateOpen(false);
          }}
        />
      )}
      {rotateOpen && connection && (
        <RotateModal
          onClose={() => setRotateOpen(false)}
          onSubmit={async (secret) => {
            await ctx.mutate(`/integrations/${connection.id}/rotate-secret`, { webhook_secret: secret }, { success: 'Signing secret rotated — previous valid for 24h' });
            await ctx.refresh(true);
            setRotateOpen(false);
          }}
        />
      )}
      {createOpen && (
        <CreateConnectorModal
          onClose={() => setCreateOpen(false)}
          onSubmit={async (body) => {
            await ctx.mutate('/integrations', body, { success: 'Connector registered' });
            await ctx.refresh(true);
            setCreateOpen(false);
          }}
        />
      )}
    </div>
  );
}

function schemeFor(provider: string) {
  return ({ ozon: 'yesi-hmac-v1', wildberries: 'wildberries-hmac-v1', yandex: 'yandex-hmac-v1' } as Record<string, string>)[provider] || 'yesi-hmac-v1';
}

function SimulateModal({ provider, onClose, onSubmit }: { provider: string; onClose: () => void; onSubmit: (scenario: string, seed: number) => Promise<void> }) {
  const [scenario, setScenario] = useState('normal');
  const [seed, setSeed] = useState(String(Math.floor(Math.random() * 9000) + 1000));
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={`Simulate ${providerLabel(provider)} payload`}
      subtitle="The sample payload travels the full ingress path: HMAC verification, raw event storage, mapping, order creation."
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onSubmit(scenario, Number(seed));
              setBusy(false);
            }}
          >
            {busy ? 'Sending…' : 'Send payload'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="stack tight">
          {SCENARIOS.map((item) => (
            <label key={item.id} className="check-row" style={{ cursor: 'pointer' }}>
              <input type="radio" name="scenario" checked={scenario === item.id} onChange={() => setScenario(item.id)} />
              <span className="grow">
                <span className="small">{item.label}</span>
                <span className="tiny faint"> · {item.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <Field label="Deterministic seed" hint="Same seed and scenario produce the same external id.">
          <input className="input" value={seed} onChange={(event) => setSeed(event.target.value.replace(/\D/g, ''))} />
        </Field>
      </div>
    </Modal>
  );
}

function RotateModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (secret: string) => Promise<void> }) {
  const [secret] = useState(() => Array.from({ length: 40 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]).join(''));
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Rotate signing secret"
      subtitle="The previous secret remains valid for 24 hours so in-flight deliveries are not lost."
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!confirmed || busy}
            onClick={async () => {
              setBusy(true);
              await onSubmit(secret);
              setBusy(false);
            }}
          >
            {busy ? 'Rotating…' : 'Rotate secret'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="warn-box">This secret is shown once. Store it in the marketplace dashboard before continuing.</div>
        <div className="code-block">{secret}</div>
        <div className="row">
          <Copy value={secret} label="Copy new secret" />
          <span className="tiny faint">40 characters · HMAC-SHA256</span>
        </div>
        <label className="check-row" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          <span className="small">I have stored the new secret and updated the provider.</span>
        </label>
      </div>
    </Modal>
  );
}

function CreateConnectorModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (body: any) => Promise<void> }) {
  const [provider, setProvider] = useState('ozon');
  const [name, setName] = useState('Ozon · New store');
  const [account, setAccount] = useState('store-001');
  const [mode, setMode] = useState('sandbox');
  const [secret, setSecret] = useState(() => Array.from({ length: 40 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join(''));
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Register a marketplace connector"
      subtitle="Webhook secret is encrypted at rest and never returned by the API."
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!name || !account || busy}
            onClick={async () => {
              setBusy(true);
              await onSubmit({ provider, name, account_ref: account, webhook_secret: secret, mode, config: {} });
              setBusy(false);
            }}
          >
            {busy ? 'Registering…' : 'Register connector'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="row">
          <Field label="Marketplace">
            <select
              className="select"
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value);
                const label = event.target.value === 'ozon' ? 'Ozon' : event.target.value === 'yandex' ? 'Yandex Market' : 'Wildberries';
                setName(`${label} · New store`);
              }}
            >
              <option value="ozon">Ozon</option>
              <option value="yandex">Yandex Market</option>
              <option value="wildberries">Wildberries</option>
            </select>
          </Field>
          <Field label="Mode">
            <select className="select" value={mode} onChange={(event) => setMode(event.target.value)}>
              <option value="sandbox">Sandbox</option>
              <option value="live">Live</option>
            </select>
          </Field>
        </div>
        <Field label="Display name">
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Account reference">
          <input className="input" value={account} onChange={(event) => setAccount(event.target.value)} />
        </Field>
        <Field label="Webhook signing secret" hint="At least 32 characters. Rotate any time from the connector panel.">
          <input className="input mono" value={secret} onChange={(event) => setSecret(event.target.value)} />
        </Field>
        {mode === 'live' && <div className="warn-box">Live connectors require credentials configured server-side and ALLOW_LIVE_CONNECTORS=true.</div>}
      </div>
    </Modal>
  );
}

const SIMULATABLE = new Set(['normal', 'multi_line', 'unmapped', 'cancelled', 'malformed']);

function PayloadLab({ connectionId, ctx }: { connectionId: string; ctx: Ctx }) {
  const [samples, setSamples] = useState<any>(null);
  const [sample, setSample] = useState<string>('normal');
  useEffect(() => {
    api<any>(`/integrations/${connectionId}/samples`)
      .then((value) => setSamples(value.samples || value))
      .catch(() => setSamples({}));
  }, [connectionId]);
  if (!samples) return <div className="skeleton" style={{ height: 200 }} />;
  const keys = Object.keys(samples);
  const payload = samples[sample] ?? samples[keys[0]];
  return (
    <div className="stack">
      <div className="toolbar">
        {keys.map((key) => (
          <button key={key} className={'btn sm ' + (sample === key ? 'primary' : 'ghost')} onClick={() => setSample(key)}>
            {titleCase(key)}
          </button>
        ))}
      </div>
      <div className="hint-box">
        Canonical native payloads used to certify the adapter. Send one to the signed webhook to replay the full pipeline.
      </div>
      <pre className="code-block">{JSON.stringify(payload, null, 2)}</pre>
      <div className="btn-row">
        <button
          className="btn sm"
          onClick={async () => {
            await ctx.mutate(
              `/integrations/${connectionId}/simulate`,
              { scenario: SIMULATABLE.has(sample) ? sample : 'normal', seed: 4242 },
              { success: 'Sample ingested' },
            );
            await ctx.refresh(true);
          }}
        >
          <Icon name="upload" size={13} /> Ingest this payload
        </button>
      </div>
    </div>
  );
}
