/** Typed API client: session cookie, CSRF header, idempotency keys, honest errors. */
let csrf = '';

export function setCsrf(value: string) {
  csrf = value;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Options = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT';
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export async function api<T = any>(path: string, options: Options = {}): Promise<T> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = csrf;
    headers['Idempotency-Key'] = options.idempotencyKey ?? crypto.randomUUID();
  }
  let response: Response;
  try {
    response = await fetch('/api/v1' + path, {
      method,
      credentials: 'include',
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}),
      signal: options.signal,
    });
  } catch (error) {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and retry.');
  }
  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { error: { message: text.slice(0, 300) } };
  }
  if (!response.ok) {
    const error = payload?.error || {};
    const message = Array.isArray(error.message)
      ? error.message.map((issue: any) => `${issue.path}: ${issue.message}`).join('; ')
      : error.message || `Request failed (${response.status})`;
    if (response.status === 401) window.dispatchEvent(new CustomEvent('yesi:unauthorized'));
    throw new ApiError(response.status, error.code || 'ERROR', message, error.request_id);
  }
  return payload as T;
}

export const money = (value: number | string | null | undefined): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(
    Number(value || 0) / 100,
  );

export const amount = (value: number | string | null | undefined): string =>
  Number(value || 0).toLocaleString('en-US');

export const pct = (value: number, total: number): number => (total ? Math.round((value / total) * 100) : 0);

export const clock = (value?: string | null): string =>
  value
    ? new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';

export const shortDate = (value?: string | null): string =>
  value ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '—';

export const relative = (value?: string | null): string => {
  if (!value) return '—';
  const diff = Date.now() - new Date(value).getTime();
  const future = diff < 0;
  const seconds = Math.abs(diff) / 1000;
  const units: Array<[number, string]> = [
    [60, 's'],
    [3600, 'm'],
    [86400, 'h'],
    [604800, 'd'],
  ];
  let label = `${Math.round(seconds)}s`;
  if (seconds >= 60) label = `${Math.round(seconds / 60)}m`;
  if (seconds >= 3600) label = `${Math.round(seconds / 3600)}h`;
  if (seconds >= 86400) label = `${Math.round(seconds / 86400)}d`;
  void units;
  return future ? `in ${label}` : `${label} ago`;
};

export const providerLabel = (provider: string): string =>
  ({ ozon: 'Ozon', yandex: 'Yandex Market', wildberries: 'Wildberries' } as Record<string, string>)[provider] || provider;

export const titleCase = (value: string): string =>
  value
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
