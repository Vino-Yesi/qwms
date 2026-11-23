import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ApiError, api, providerLabel, relative, setCsrf, titleCase } from './api';
import { Icon, Kbd } from './components';
import { Login } from './login';
import { Overview } from './pages/overview';
import { Orders } from './pages/orders';
import { Inventory } from './pages/inventory';
import { Receiving } from './pages/receiving';
import { Waves } from './pages/waves';
import { Warehouse } from './pages/warehouse';
import { Shipping } from './pages/shipping';
import { Connectors } from './pages/connectors';
import { Mapping } from './pages/mapping';
import { Exceptions } from './pages/exceptions';
import { Finance } from './pages/finance';
import { Reconciliation } from './pages/reconciliation';
import { Audit } from './pages/audit';
import { Platform } from './pages/platform';
import type { Actor, Ctx, PageId, Snapshot, StreamEvent } from './types';

const PAGES: Record<PageId, { label: string; group: string; icon: string; title: string; component: (props: { ctx: Ctx }) => ReactElement }> = {
  tower: { label: 'Control tower', group: 'Operations', icon: 'grid', title: 'Control tower', component: Overview },
  orders: { label: 'Orders', group: 'Operations', icon: 'orders', title: 'Orders', component: Orders },
  inventory: { label: 'Inventory', group: 'Operations', icon: 'box', title: 'Inventory', component: Inventory },
  receiving: { label: 'Receiving', group: 'Operations', icon: 'receive', title: 'Receiving & dock', component: Receiving },
  warehouse: { label: 'Warehouse', group: 'Operations', icon: 'layers', title: 'Slotting & flow', component: Warehouse },
  waves: { label: 'Wave board', group: 'Operations', icon: 'wave', title: 'Wave & pick board', component: Waves },
  shipping: { label: 'Shipping', group: 'Operations', icon: 'truck', title: 'Shipments & tracking', component: Shipping },
  connectors: { label: 'Connector hub', group: 'Integrations', icon: 'link', title: 'Marketplace connectors', component: Connectors },
  mapping: { label: 'SKU mapping', group: 'Integrations', icon: 'tag', title: 'SKU mapping', component: Mapping },
  exceptions: { label: 'Exceptions', group: 'Integrations', icon: 'alert', title: 'Exception queue', component: Exceptions },
  finance: { label: 'Finance & ERP', group: 'Control', icon: 'finance', title: 'Revenue & ERP postings', component: Finance },
  reconciliation: { label: 'Reconciliation', group: 'Control', icon: 'shield', title: 'Reconciliation', component: Reconciliation },
  audit: { label: 'Audit & events', group: 'Governance', icon: 'file', title: 'Audit & events', component: Audit },
  platform: { label: 'Platform', group: 'Governance', icon: 'settings', title: 'Platform', component: Platform },
};

const GROUPS = ['Operations', 'Integrations', 'Control', 'Governance'];
const PAGE_IDS = Object.keys(PAGES) as PageId[];

type Route = { page: PageId; params: Record<string, any> };
type Toast = { id: string; message: string; tone: 'success' | 'error'; detail?: string };

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, query] = raw.split('?');
  const page = (PAGE_IDS as string[]).includes(path) ? (path as PageId) : 'tower';
  const params: Record<string, any> = {};
  if (query) {
    for (const [key, value] of new URLSearchParams(query)) params[key] = value;
  }
  return { page, params };
}

function hashFor(route: Route): string {
  const query = new URLSearchParams(
    Object.entries(route.params).filter(([, value]) => value !== undefined && value !== null && value !== '') as string[][],
  ).toString();
  return `#/${route.page}${query ? `?${query}` : ''}`;
}

export default function App() {
  const [boot, setBoot] = useState<'loading' | 'anon' | 'ready'>('loading');
  const [actor, setActor] = useState<Actor | null>(null);
  const [data, setData] = useState<Snapshot | null>(null);
  const [route, setRoute] = useState<Route>(() => parseHash());
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<{ attempt: number; timer?: number }>({ attempt: 0 });
  const refreshTimer = useRef<number | undefined>(undefined);
  const lastSeq = useRef(0);
  const mounted = useRef(true);

  const notify = useCallback((message: string, tone: 'success' | 'error' = 'success') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((current) => [...current.slice(-3), { id, message, tone }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), tone === 'error' ? 7000 : 4200);
  }, []);

  const loadSnapshot = useCallback(async () => {
    try {
      const snapshot = await api<Snapshot>('/snapshot');
      if (!mounted.current) return null;
      setData(snapshot);
      setLoadError(null);
      return snapshot;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      if (mounted.current) setLoadError(error instanceof Error ? error.message : 'Unable to load data');
      return null;
    }
  }, []);

  const refresh = useCallback(
    async (silent = true) => {
      const snapshot = await loadSnapshot();
      if (!silent) notify('Snapshot refreshed');
      return snapshot;
    },
    [loadSnapshot, notify],
  );

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      void refresh(true);
    }, 350);
  }, [refresh]);

  // ------------------------------------------------------------------ boot --
  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        const me = await api<Actor & { csrf: string }>('/auth/me');
        setCsrf(me.csrf);
        setActor(me);
        const snapshot = await loadSnapshot();
        if (!snapshot) {
          setBoot('anon');
          return;
        }
        setBoot('ready');
        // Seed the live feed with recent committed events so the console is
        // never blank on first paint; the socket then takes over seamlessly.
        if (lastSeq.current === 0) {
          lastSeq.current = Number(snapshot.sequence || 0);
          const after = Math.max(0, lastSeq.current - 40);
          void api<{ items: StreamEvent[] }>(`/events?after=${after}&limit=40`)
            .then((value) => {
              if (mounted.current) setEvents([...(value.items || [])].reverse());
            })
            .catch(() => {});
        }
      } catch {
        setBoot('anon');
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, [loadSnapshot]);

  useEffect(() => {
    const unauthorized = () => {
      setActor(null);
      setBoot('anon');
      setData(null);
      socketRef.current?.close();
    };
    window.addEventListener('yesi:unauthorized', unauthorized);
    return () => window.removeEventListener('yesi:unauthorized', unauthorized);
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Navigation always writes the hash so reloads keep context.
  const navigate = useCallback((page: PageId, params: Record<string, any> = {}) => {
    const next = { page, params };
    setRoute(next);
    setSidebarOpen(false);
    window.location.hash = hashFor(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // ------------------------------------------------------------- realtime --
  useEffect(() => {
    if (boot !== 'ready') return;
    let closed = false;

    async function connect() {
      try {
        const ticket = await api<{ ticket: string }>('/auth/ticket', { method: 'POST', body: {} });
        if (closed) return;
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
        socketRef.current = socket;

        socket.onopen = () => {
          socket.send(JSON.stringify({ type: 'authenticate', ticket: ticket.ticket, last_seq: lastSeq.current }));
        };

        socket.onmessage = (message) => {
          let payload: any;
          try {
            payload = JSON.parse(String(message.data));
          } catch {
            return;
          }
          if (payload.type === 'event') {
            lastSeq.current = Math.max(lastSeq.current, Number(payload.seq));
            setEvents((current) => {
              if (current.some((event) => event.seq === payload.seq)) return current;
              return [payload as StreamEvent, ...current].slice(0, 80);
            });
            if (payload.topic === 'connector.ingest' || payload.topic === 'order.created') {
              scheduleRefresh();
            } else {
              scheduleRefresh();
            }
          } else if (payload.type === 'ready') {
            setConnected(true);
            retryRef.current.attempt = 0;
            if (lastSeq.current === 0) lastSeq.current = Number(payload.sequence || 0);
          } else if (payload.type === 'resync') {
            lastSeq.current = Number(payload.sequence || 0);
            setEvents([]);
            scheduleRefresh();
          }
        };

        socket.onclose = () => {
          setConnected(false);
          socketRef.current = null;
          if (closed) return;
          const attempt = Math.min(6, retryRef.current.attempt + 1);
          retryRef.current.attempt = attempt;
          retryRef.current.timer = window.setTimeout(connect, Math.min(15_000, 800 * 2 ** attempt));
        };

        socket.onerror = () => socket.close();
      } catch {
        setConnected(false);
        if (!closed) {
          const attempt = Math.min(6, retryRef.current.attempt + 1);
          retryRef.current.attempt = attempt;
          retryRef.current.timer = window.setTimeout(connect, Math.min(15_000, 1200 * 2 ** attempt));
        }
      }
    }

    void connect();
    const ping = window.setInterval(() => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
    }, 25_000);
    const fallback = window.setInterval(() => {
      if (!socketRef.current) void refresh(true);
    }, 20_000);

    return () => {
      closed = true;
      window.clearInterval(ping);
      window.clearInterval(fallback);
      if (retryRef.current.timer) window.clearTimeout(retryRef.current.timer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [boot, refresh, scheduleRefresh]);

  // Keep the tab title in sync.
  useEffect(() => {
    document.title = `${PAGES[route.page].title} · YESI Fulfillment OS`;
  }, [route.page]);

  // ---------------------------------------------------------------- mutate --
  const mutate = useCallback(
    async <T,>(path: string, body?: unknown, options: { method?: 'POST' | 'PATCH'; success?: string } = {}): Promise<T | null> => {
      try {
        const result = await api<T>(path, { method: options.method ?? 'POST', body });
        if (options.success) notify(options.success, 'success');
        return result;
      } catch (error) {
        const problem = error as ApiError;
        if (problem.status !== 401) notify(problem.message, 'error');
        return null;
      }
    },
    [notify],
  );

  const can = useCallback((permission: string) => Boolean(actor?.permissions?.includes(permission)), [actor]);

  const ctx: Ctx | null = useMemo(
    () =>
      data && actor
        ? {
            data,
            actor,
            can,
            refresh,
            mutate,
            notify,
            navigate,
            params: route.params,
            events,
            connected,
          }
        : null,
    [data, actor, can, refresh, mutate, notify, navigate, route.params, events, connected],
  );

  // -------------------------------------------------------------- palette --
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.key === 'Escape') setPaletteOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  if (boot === 'loading') {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', position: 'relative', zIndex: 1 }}>
        <div className="stack" style={{ alignItems: 'center' }}>
          <span className="brand-mark" style={{ width: 46, height: 46 }}><Icon name="layers" size={22} /></span>
          <div className="tiny faint">Establishing secure session…</div>
        </div>
      </div>
    );
  }

  if (boot === 'anon' || !ctx) {
    return (
      <Login
        onAuthenticated={async () => {
          const me = await api<Actor & { csrf: string }>('/auth/me');
          setCsrf(me.csrf);
          setActor(me);
          const snapshot = await loadSnapshot();
          if (snapshot) {
            setBoot('ready');
          } else {
            setLoadError('Signed in, but the workspace snapshot failed to load.');
            setBoot('ready');
          }
        }}
      />
    );
  }

  const Page = PAGES[route.page].component;
  const counts: Partial<Record<PageId, number>> = {
    orders: ctx.data.kpis.open_orders,
    exceptions: ctx.data.kpis.open_exceptions,
    mapping: ctx.data.pending_mappings.length,
    audit: ctx.data.kpis.dead_events || undefined,
    receiving: ctx.data.asns.filter((asn) => asn.status !== 'RECEIVED').length || undefined,
    waves: ctx.data.kpis.open_waves || undefined,
    shipping: ctx.data.shipments.filter((shipment) => shipment.status === 'BOOKED').length || undefined,
  };

  return (
    <div className="app">
      <aside className={'sidebar' + (sidebarOpen ? ' open' : '')}>
        <div className="brand">
          <span className="brand-mark"><Icon name="layers" size={19} /></span>
          <div>
            <div className="brand-name">YESI<span className="accent">.</span>OS</div>
            <div className="brand-sub">FULFILLMENT PLATFORM</div>
          </div>
        </div>
        <div className="facility">
          <span className="row tight"><Icon name="box" size={12} /> DC-EAST-02</span>
          <span className="badge slate">{titleCase(ctx.data.environment)}</span>
        </div>

        <nav aria-label="Primary">
          {GROUPS.map((group) => (
            <div key={group}>
              <div className="nav-label">{group}</div>
              {PAGE_IDS.filter((id) => PAGES[id].group === group).map((id) => (
                <button
                  key={id}
                  className={'nav-item' + (route.page === id ? ' active' : '')}
                  onClick={() => navigate(id)}
                  aria-current={route.page === id ? 'page' : undefined}
                >
                  <Icon name={PAGES[id].icon} size={15} />
                  <span>{PAGES[id].label}</span>
                  {counts[id] ? <span className="nav-count">{counts[id]}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="between tiny">
            <span className="row tight">
              <span className={'live-dot' + (connected ? '' : ' off')} />
              <span className="faint">{connected ? 'Realtime' : 'Polling'}</span>
            </span>
            <span className="mono faint">#{ctx.data.sequence}</span>
          </div>
          <div className="profile">
            <span className="avatar">{initials(ctx.actor.email)}</span>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="small truncate">{ctx.actor.email.split('@')[0]}</div>
              <div className="tiny faint">{ctx.actor.role}</div>
            </div>
            <button
              className="icon-btn sm"
              aria-label="Sign out"
              title="Sign out"
              onClick={async () => {
                try {
                  await api('/auth/logout', { method: 'POST', body: {} });
                } catch {
                  /* session may already be gone */
                }
                setActor(null);
                setBoot('anon');
              }}
            >
              <Icon name="logout" size={14} />
            </button>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="row" style={{ minWidth: 0 }}>
            <button className="icon-btn mobile-menu" aria-label="Open navigation" onClick={() => setSidebarOpen((open) => !open)}>
              <Icon name="menu" size={17} />
            </button>
            <div className="breadcrumb">
              <span>{PAGES[route.page].group}</span>
              <Icon name="chevron" size={11} />
              <b>{PAGES[route.page].label}</b>
            </div>
          </div>
          <div className="row">
            <button className="search" style={{ minWidth: 210 }} onClick={() => setPaletteOpen(true)} aria-label="Open command palette">
              <Icon name="search" size={14} />
              <input placeholder="Search or jump…" readOnly style={{ pointerEvents: 'none' }} />
              <Kbd>⌘K</Kbd>
            </button>
            <span className="badge slate" style={{ height: 24 }}>
              <span className={'badge-dot' + (connected ? '' : '')} style={{ background: connected ? 'var(--green)' : 'var(--amber)' }} />
              {connected ? 'Live' : 'Sync'}
            </span>
            <button
              className="icon-btn"
              aria-label={`${ctx.data.kpis.open_exceptions} open exceptions`}
              onClick={() => navigate('exceptions')}
              style={{ position: 'relative' }}
            >
              <Icon name="bell" size={16} />
              {ctx.data.kpis.open_exceptions > 0 && (
                <span
                  style={{
                    position: 'absolute',
                    top: 4,
                    right: 4,
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    background: 'var(--red)',
                  }}
                />
              )}
            </button>
            <span className="avatar">{initials(ctx.actor.email)}</span>
          </div>
        </header>

        <main className="content">
          {loadError && (
            <div className="danger-box" style={{ marginBottom: 16 }} role="alert">
              {loadError}
            </div>
          )}
          <Page ctx={ctx} />
          <div className="footer-note">
            <span className="row tight">
              <Icon name="shield" size={11} /> Signed ingestion · version-checked commands · append-only audit
            </span>
            <span>
              {providerLabel('ozon')} · {providerLabel('yandex')} · {providerLabel('wildberries')} — updated {relative(ctx.data.server_time)}
            </span>
          </div>
        </main>
      </div>

      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          navigate={(page, params) => {
            navigate(page, params);
            setPaletteOpen(false);
          }}
          actions={[
            { id: 'refresh', label: 'Refresh snapshot', icon: 'refresh', run: () => { void refresh(false); setPaletteOpen(false); } },
            { id: 'exceptions', label: 'Triage open exceptions', icon: 'alert', run: () => { navigate('exceptions'); setPaletteOpen(false); } },
            { id: 'audit', label: 'Verify audit chain', icon: 'shield', run: () => { navigate('audit'); setPaletteOpen(false); } },
            { id: 'recon', label: 'Run reconciliation sweep', icon: 'activity', run: () => { navigate('reconciliation'); setPaletteOpen(false); } },
            { id: 'tower', label: 'Control tower', icon: 'grid', run: () => { navigate('tower'); setPaletteOpen(false); } },
          ]}
        />
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div className={'toast ' + toast.tone} key={toast.id} role="status">
            <Icon name={toast.tone === 'error' ? 'alert' : 'check'} size={15} className={toast.tone === 'error' ? 'red' : 'green'} />
            <div className="grow">
              <div>{toast.message}</div>
              {toast.detail && <div className="tiny faint">{toast.detail}</div>}
            </div>
            <button className="icon-btn sm" aria-label="Dismiss" onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}>
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function initials(email: string): string {
  const name = email.split('@')[0] || '?';
  return name.slice(0, 2).toUpperCase();
}

function CommandPalette({
  onClose,
  navigate,
  actions,
}: {
  onClose: () => void;
  navigate: (page: PageId, params?: Record<string, any>) => void;
  actions: Array<{ id: string; label: string; icon: string; run: () => void }>;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const pages = PAGE_IDS.filter((id) => !needle || PAGES[id].label.toLowerCase().includes(needle) || PAGES[id].group.toLowerCase().includes(needle)).map((id) => ({
      id,
      label: PAGES[id].label,
      group: PAGES[id].group,
      icon: PAGES[id].icon,
      run: () => navigate(id),
    }));
    const extras = actions.filter((action) => !needle || action.label.toLowerCase().includes(needle)).map((action) => ({ ...action, group: 'Actions' }));
    return [...pages, ...extras];
  }, [query, actions, navigate]);

  useEffect(() => setActive(0), [query]);

  return (
    <div className="overlay command-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="command" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="command-input">
          <Icon name="search" size={16} className="faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Jump to a page or run an action…"
            aria-label="Command search"
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((index) => (index + 1) % items.length);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((index) => (index - 1 + items.length) % items.length);
              } else if (event.key === 'Enter') {
                items[active]?.run();
              }
            }}
          />
          <Kbd>ESC</Kbd>
        </div>
        <div className="command-list">
          {items.length === 0 && <div className="empty">No matches</div>}
          {items.map((item, index) => (
            <div key={item.id}>
              {(index === 0 || items[index - 1].group !== item.group) && <div className="command-group">{item.group}</div>}
              <button
                className={'command-item' + (index === active ? ' active' : '')}
                onMouseEnter={() => setActive(index)}
                onClick={item.run}
              >
                <Icon name={item.icon} size={14} />
                <span className="grow">{item.label}</span>
                {index === active && <Kbd>↵</Kbd>}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
