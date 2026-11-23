import React, { useEffect, useMemo, useRef, useState } from 'react';
import { titleCase } from './api';

const paths: Record<string, string> = {
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  orders: 'M6 2h12v20l-3-2-3 2-3-2-3 2z M9 7h6 M9 11h6 M9 15h4',
  box: 'M21 8l-9-5-9 5v8l9 5 9-5z M3 8l9 5 9-5 M12 13v8',
  receive: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3',
  wave: 'M13 2L3 14h8l-1 8 11-13h-9z',
  truck: 'M1 4h14v12H1z M15 8h4l3 4v4h-7 M5.5 19.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4 M18.5 19.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
  link: 'M9 15l6-6 M10 6l1-1a4 4 0 1 1 6 6l-1 1 M14 18l-1 1a4 4 0 1 1-6-6l1-1',
  tag: 'M20.6 13.4L12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8z M7.5 7.5h.01',
  alert: 'M12 3L2 21h20z M12 9v5 M12 17h.01',
  finance: 'M3 7h18v14H3z M3 7l3-4h12l3 4 M8 12h8 M8 16h5',
  shield: 'M12 3l8 4v6c0 5-8 9-8 9s-8-4-8-9V7z M8 12l3 3 5-6',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
  search: 'M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16 M17 17l5 5',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9 M10 21h4',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1 1 M18 18l1 1 M5 19l1-1 M18 6l1-1',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  check: 'M5 12l4 4L19 6',
  close: 'M6 6l12 12 M6 18L18 6',
  refresh: 'M20 7a9 9 0 1 0 1 8 M20 3v5h-5',
  menu: 'M3 6h18 M3 12h18 M3 18h18',
  logout: 'M9 3H3v18h6 M9 12h12 M16 7l5 5-5 5',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2',
  lock: 'M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4',
  play: 'M6 4l14 8-14 8z',
  pause: 'M8 4h3v16H8z M13 4h3v16h-3z',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  chevron: 'M9 6l6 6-6 6',
  external: 'M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6',
  database: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3 M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  plus: 'M12 5v14 M5 12h14',
  bolt: 'M13 2L4 14h6l-1 8 10-12h-6z',
  layers: 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5 M3 17l9 5 9-5',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 8l5-5 5 5 M12 3v12',
  file: 'M6 2h8l5 5v15H6z M14 2v6h5 M9 13h7 M9 17h7',
  users: 'M16 20v-2a4 4 0 0 0-8 0v2 M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M21 20v-2a4 4 0 0 0-3-3.9 M3 20v-2a4 4 0 0 1 3-3.9',
  key: 'M14 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M9.5 13.5L3 20v2h3v-2h2v-2l2-2',
  table: 'M3 4h18v16H3z M3 10h18 M3 16h18 M9 4v16',
};

export function Icon({ name, size = 16, className = '', ...rest }: { name: string; size?: number; className?: string; [key: string]: any }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={'icon ' + className}
      {...rest}
    >
      <path d={paths[name] || paths.box} />
    </svg>
  );
}

const tones: Record<string, string> = {
  green: 'green',
  blue: 'blue',
  amber: 'amber',
  red: 'red',
  purple: 'purple',
  slate: 'slate',
};

export function Badge({ tone = 'slate', children, dot }: { tone?: string; children: React.ReactNode; dot?: boolean }) {
  return (
    <span className={'badge ' + (tones[tone] || 'slate')}>
      {dot && <span className="badge-dot" />}
      {children}
    </span>
  );
}

const statusTone: Record<string, string> = {
  RECEIVED: 'slate',
  MAPPED: 'blue',
  RESERVED: 'purple',
  PICKING: 'amber',
  PACKED: 'amber',
  READY_TO_SHIP: 'green',
  SHIPPED: 'blue',
  DELIVERED: 'green',
  CANCELLED: 'slate',
  EXCEPTION: 'red',
  RETURNED: 'purple',
  CREATED: 'slate',
  BOOKED: 'blue',
  DISPATCHED: 'green',
  IN_TRANSIT: 'blue',
  OPEN: 'amber',
  RESOLVED: 'green',
  IGNORED: 'slate',
  DEAD: 'red',
  PENDING: 'amber',
  PROCESSING: 'blue',
  DONE: 'green',
  OK: 'green',
  FAILED: 'red',
  ENABLED: 'green',
  PAUSED: 'amber',
  ERROR: 'red',
  HIGH: 'red',
  CRITICAL: 'red',
  MEDIUM: 'amber',
  LOW: 'slate',
  COMPLETE: 'green',
  RELEASED: 'blue',
  EXPECTED: 'blue',
  IN_RECEIVING: 'amber',
  APPROVED: 'green',
  ACK: 'green',
  POSTED: 'green',
  DRAFT: 'slate',
  SANDBOX: 'purple',
  LIVE: 'green',
};

export function Status({ value, label }: { value: string; label?: string }) {
  const tone = statusTone[value] || 'slate';
  return (
    <span className={'status ' + tone}>
      <span className="status-dot" />
      {label || titleCase(value)}
    </span>
  );
}

export function ProviderMark({ provider, size = 26 }: { provider: string; size?: number }) {
  const style: Record<string, { background: string; color: string; text: string }> = {
    ozon: { background: '#1f5eff', color: '#fff', text: 'O' },
    yandex: { background: '#ffd43b', color: '#241f05', text: 'Я' },
    wildberries: { background: '#8b2fc9', color: '#fff', text: 'W' },
  };
  const s = style[provider] || { background: '#26342c', color: '#cfe0d3', text: '?' };
  return (
    <span
      className="provider-mark"
      style={{ background: s.background, color: s.color, width: size, height: size, fontSize: size * 0.46 }}
      aria-label={provider}
    >
      {s.text}
    </span>
  );
}

export function Panel({
  title,
  subtitle,
  action,
  children,
  className = '',
  flush,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section className={'panel ' + className}>
      {(title || action) && (
        <header className="panel-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p className="panel-sub">{subtitle}</p>}
          </div>
          {action && <div className="panel-action">{action}</div>}
        </header>
      )}
      <div className={flush ? 'panel-body flush' : 'panel-body'}>{children}</div>
    </section>
  );
}

export function Metric({
  label,
  value,
  sub,
  tone = 'default',
  icon,
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'default' | 'good' | 'warn' | 'bad' | 'accent';
  icon?: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <div className="metric-top">
        <span className="metric-label">{label}</span>
        {icon && (
          <span className={'metric-icon ' + tone}>
            <Icon name={icon} size={14} />
          </span>
        )}
      </div>
      <div className="metric-value">{value}</div>
      {sub && <div className="metric-sub">{sub}</div>}
    </>
  );
  return onClick ? (
    <button type="button" className={'metric metric-button ' + tone} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={'metric ' + tone}>{content}</div>
  );
}

export function Empty({ title = 'Nothing here yet', hint }: { title?: string; hint?: string }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name="box" size={22} />
      </div>
      <div>{title}</div>
      {hint && <p className="tiny faint">{hint}</p>}
    </div>
  );
}

export function Progress({ value, max = 100, tone = 'accent' }: { value: number; max?: number; tone?: string }) {
  const width = Math.max(0, Math.min(100, (value / Math.max(1, max)) * 100));
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemax={max}>
      <span className={'progress-fill ' + tone} style={{ width: width + '%' }} />
    </div>
  );
}

export function Sparkline({
  values,
  height = 64,
  tone = 'var(--accent)',
  fill = true,
  label,
}: {
  values: number[];
  height?: number;
  tone?: string;
  fill?: boolean;
  label?: string;
}) {
  const width = 600;
  const max = Math.max(1, ...values);
  const points = values.map((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * width;
    const y = height - (value / max) * (height - 8) - 4;
    return [x, y] as const;
  });
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `0,${height} ${line} ${width},${height}`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="sparkline" role="img" aria-label={label || 'trend'}>
      {fill && <polygon points={area} fill="url(#sparkfill)" opacity="0.5" />}
      <defs>
        <linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={tone} stopOpacity="0.25" />
          <stop offset="100%" stopColor={tone} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline points={line} fill="none" stroke={tone} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={points[points.length - 1]?.[0] || 0} cy={points[points.length - 1]?.[1] || 0} r="3" fill={tone} />
    </svg>
  );
}

export function Tabs({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ id: string; label: string; count?: number }>;
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={value === tab.id}
          className={'tab ' + (value === tab.id ? 'active' : '')}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count !== undefined && <span className="tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Table({
  columns,
  rows,
  render,
  onRow,
  rowKey,
  height = 520,
  empty,
  dense,
}: {
  columns: Array<{ key: string; label: string; align?: 'right' | 'center'; width?: string }>;
  rows: any[];
  render: (row: any, index: number) => React.ReactNode;
  onRow?: (row: any) => void;
  rowKey: (row: any, index: number) => string;
  height?: number;
  empty?: React.ReactNode;
  dense?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const rowHeight = dense ? 44 : 54;
  const virtualize = rows.length > 60;
  const viewport = Math.min(height, rows.length * rowHeight + 44) || 120;
  const start = virtualize ? Math.max(0, Math.floor(scrollTop / rowHeight) - 4) : 0;
  const end = virtualize ? Math.min(rows.length, start + Math.ceil(viewport / rowHeight) + 8) : rows.length;

  if (!rows.length) return <>{empty || <Empty />}</>;
  return (
    <div className="table-wrap" ref={scrollRef} style={{ maxHeight: height }} onScroll={(event) => setScrollTop((event.target as HTMLDivElement).scrollTop)}>
      <table className={'data-table' + (dense ? ' dense' : '')}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} style={{ textAlign: column.align || 'left', width: column.width }}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {virtualize && start > 0 && (
            <tr aria-hidden="true">
              <td colSpan={columns.length} style={{ height: start * rowHeight, padding: 0, border: 0 }} />
            </tr>
          )}
          {rows.slice(start, end).map((row, index) => (
            <tr
              key={rowKey(row, start + index)}
              onClick={onRow ? () => onRow(row) : undefined}
              className={onRow ? 'clickable' : ''}
              tabIndex={onRow ? 0 : undefined}
              onKeyDown={
                onRow
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onRow(row);
                      }
                    }
                  : undefined
              }
            >
              {render(row, start + index)}
            </tr>
          ))}
          {virtualize && end < rows.length && (
            <tr aria-hidden="true">
              <td colSpan={columns.length} style={{ height: (rows.length - end) * rowHeight, padding: 0, border: 0 }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
  error,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
  error?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export function Copy({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={label}
      title={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size={13} />
    </button>
  );
}

function useFocusTrap(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const element = ref.current;
    const previous = document.activeElement as HTMLElement;
    const focusable = element?.querySelector<HTMLElement>('button,input,select,textarea,a[href],[tabindex]:not([tabindex="-1"])');
    focusable?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab' && element) {
        const nodes = Array.from(
          element.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]'),
        ).filter((node) => node.offsetParent !== null);
        if (!nodes.length) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    document.body.classList.add('locked');
    return () => {
      document.removeEventListener('keydown', handler);
      document.body.classList.remove('locked');
      previous?.focus?.();
    };
  }, [ref, onClose]);
}

export function Modal({
  title,
  subtitle,
  children,
  footer,
  onClose,
  width = 560,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, onClose);
  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref} style={{ maxWidth: width }}>
        <header className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="panel-sub">{subtitle}</p>}
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Drawer({
  title,
  subtitle,
  children,
  footer,
  onClose,
  wide,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, onClose);
  return (
    <div className="overlay drawer-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className={'drawer' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={String(title)} ref={ref}>
        <header className="drawer-head">
          <div className="grow">
            <h2>{title}</h2>
            {subtitle && <div className="panel-sub">{subtitle}</div>}
          </div>
          <button type="button" className="icon-btn" aria-label="Close panel" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-foot">{footer}</footer>}
      </aside>
    </div>
  );
}

export function Meta({ items }: { items: Array<{ label: string; value: React.ReactNode }> }) {
  return (
    <dl className="meta">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function useDebounced<T>(value: T, delay = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function List({ children }: { children: React.ReactNode }) {
  return <ul className="list">{children}</ul>;
}

export function KeyValue({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="kv">
      <span>{k}</span>
      <span>{v}</span>
    </div>
  );
}

export function useSorted<T>(rows: T[], comparator: (a: T, b: T) => number): T[] {
  return useMemo(() => [...rows].sort(comparator), [rows, comparator]);
}
