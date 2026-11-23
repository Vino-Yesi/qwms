/**
 * Outbound transport.
 *
 * Sandbox mode acknowledges through the adapter's native response contract and
 * never touches the network. Live mode is opt-in, HTTPS-only, redirect-free,
 * time-boxed, and carries a stable idempotency key on every call.
 */
import { createHmac } from 'node:crypto';
import { config } from '../config.js';
import { fail } from '../db/index.js';
import type { ConnectorAdapter, ConnectorContext, OutboundOperation, TransportCall } from './types.js';

export class UpstreamError extends Error {
  constructor(
    message: string,
    public httpStatus?: number,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export type TransportResult = {
  status: number;
  data: unknown;
  latencyMs: number;
  mode: 'sandbox' | 'live';
  request: TransportCall;
};

export function signBody(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): Record<string, string> {
  return {
    'X-YESI-Timestamp': String(timestamp),
    'X-YESI-Signature': 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'),
  };
}

export async function httpJson(
  call: TransportCall,
  options: { timeoutMs?: number } = {},
): Promise<{ status: number; data: unknown; latencyMs: number }> {
  const url = new URL(call.url);
  if (url.protocol !== 'https:') fail(503, 'HTTPS_REQUIRED', 'Outbound connector calls must use HTTPS');
  if (url.username || url.password) fail(503, 'UNSAFE_ENDPOINT', 'Credentials in a connector URL are forbidden');
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(call.url, {
      method: call.method,
      headers: call.headers,
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (error) {
    throw new UpstreamError(`Network failure: ${(error as Error).message}`);
  }
  const latencyMs = Date.now() - started;
  const textBody = await response.text();
  let data: unknown = null;
  if (textBody) {
    try {
      data = JSON.parse(textBody);
    } catch {
      data = { raw: textBody.slice(0, 2000) };
    }
  }
  if (!response.ok) {
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new UpstreamError(`Upstream HTTP ${response.status}`, response.status, Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined);
  }
  return { status: response.status, data, latencyMs };
}

export function assertLiveAllowed(ctx: ConnectorContext): void {
  if (ctx.mode !== 'live') return;
  if (!config.allowLiveConnectors) {
    fail(403, 'LIVE_CONNECTORS_DISABLED', 'Live connector calls are disabled until platform certification completes');
  }
  if (!ctx.credentials.apiKey) fail(422, 'CREDENTIALS_REQUIRED', 'This connector has no API credentials');
}

export async function callAdapter(
  adapter: ConnectorAdapter,
  ctx: ConnectorContext,
  operation: OutboundOperation,
  input: Record<string, unknown>,
  idempotencyKey: string,
): Promise<TransportResult> {
  const call = adapter.request(operation, ctx, input, idempotencyKey);
  if (ctx.mode === 'sandbox') {
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 2 + Math.floor(Math.random() * 8)));
    return {
      status: 200,
      data: adapter.sandboxAck(operation, input),
      latencyMs: Date.now() - started,
      mode: 'sandbox',
      request: call,
    };
  }
  assertLiveAllowed(ctx);
  const result = await httpJson(call);
  return { ...result, mode: 'live', request: call };
}
