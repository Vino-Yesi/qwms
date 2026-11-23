// @vitest-environment jsdom
/**
 * Runtime smoke test for the real console.
 *
 * Boots a real server process against a throwaway database, mounts the React
 * application in jsdom and walks every navigation entry. Requests are proxied
 * to the child server, so this exercises the actual API contract, loading
 * states and effects rather than hand-written mocks.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from '../web/App';

const PORT = 3101;
const BASE = `http://127.0.0.1:${PORT}`;
const nativeFetch = globalThis.fetch;
let server: ChildProcess | null = null;
let cookie = '';
let root: Root | null = null;
const errors: string[] = [];

class SilentSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor() {
    setTimeout(() => this.onclose?.({}), 10);
  }
  send() {}
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

async function waitForHealth(timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await nativeFetch(`${BASE}/health`);
      if (response.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error('server did not become healthy');
}

beforeAll(async () => {
  rmSync('.data-console', { recursive: true, force: true });
  server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(PORT),
      DATABASE_URL: 'pglite://.data-console',
      AUTO_SEED: 'true',
      WORKER_ENABLED: 'false',
      APP_ORIGIN: BASE,
    },
    stdio: 'ignore',
  });
  await waitForHealth();

  const login = await nativeFetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@yesi.local', password: 'Yesi!Demo2026' }),
  });
  const body = (await login.json()) as any;
  cookie = String(login.headers.getSetCookie()[0]).split(';')[0];
  const demo = await (
    await nativeFetch(`${BASE}/api/v1/auth/demo-code`, { headers: { cookie } })
  ).json() as any;
  await nativeFetch(`${BASE}/api/v1/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': body.csrf },
    body: JSON.stringify({ code: demo.code }),
  });

  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).WebSocket = SilentSocket;
  (globalThis as any).fetch = async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    return nativeFetch(BASE + url, {
      method: init.method || 'GET',
      headers: { ...(init.headers || {}), cookie },
      body: init.body,
    });
  };
  (window as any).scrollTo = () => {};

  const originalError = console.error;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const text = args.map((value) => (value instanceof Error ? value.message : String(value))).join(' ');
    if (!/not implemented|act\(/.test(text)) errors.push(text);
    originalError(...(args as []));
  });
});

afterAll(async () => {
  root?.unmount();
  if (server?.pid) {
    const exited = new Promise((resolve) => server!.once('exit', resolve));
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    try {
      process.kill(-server.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

async function settle(ms = 350) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe('console runtime', () => {
  it('signs in, renders the control tower and walks every page', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<App />);
    });
    await settle(900);
    expect(document.body.textContent).toContain('Control tower');
    expect(document.body.textContent).toContain('Fulfillment pipeline');
    expect(document.body.textContent).toContain('admin');

    const pages = [
      ['Orders', 'Orders'],
      ['Inventory', 'Stock & locations'],
      ['Receiving', 'Receiving & dock'],
      ['Warehouse', 'Slotting & flow'],
      ['Wave board', 'Wave & pick board'],
      ['Shipping', 'Shipments & tracking'],
      ['Connector hub', 'Marketplace connectors'],
      ['SKU mapping', 'SKU mapping'],
      ['Exceptions', 'Exception queue'],
      ['Finance & ERP', 'Revenue & ERP postings'],
      ['Reconciliation', 'Reconciliation'],
      ['Audit & events', 'Audit & events'],
      ['Platform', 'Runtime'],
    ] as const;

    for (const [nav, heading] of pages) {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button.nav-item')).find((node) =>
        node.textContent?.includes(nav),
      );
      expect(button, `nav entry ${nav}`).toBeTruthy();
      await act(async () => {
        button!.click();
      });
      await settle(500);
      expect(document.body.textContent, `page ${heading}`).toContain(heading);
    }

    expect(document.querySelectorAll('.status, .badge').length).toBeGreaterThan(5);
    expect(errors.join('\n')).toBe('');
  }, 90_000);
});
