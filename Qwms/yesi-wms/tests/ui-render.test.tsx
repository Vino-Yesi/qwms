/**
 * Server-render smoke test for every console surface.
 *
 * Effects do not run during SSR, so this isolates render-time faults (missing
 * relations, undefined projections, bad date handling) that a type check and a
 * bundle build cannot see.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import fixture from './fixtures/snapshot.json';
import { Login } from '../web/login';
import { Overview } from '../web/pages/overview';
import { Orders } from '../web/pages/orders';
import { Inventory } from '../web/pages/inventory';
import { Receiving } from '../web/pages/receiving';
import { Waves } from '../web/pages/waves';
import { Warehouse } from '../web/pages/warehouse';
import { Shipping } from '../web/pages/shipping';
import { Connectors } from '../web/pages/connectors';
import { Mapping } from '../web/pages/mapping';
import { Exceptions } from '../web/pages/exceptions';
import { Finance } from '../web/pages/finance';
import { Reconciliation } from '../web/pages/reconciliation';
import { Audit } from '../web/pages/audit';
import { Platform } from '../web/pages/platform';
import type { Ctx } from '../web/types';

const ctx = {
  data: fixture as any,
  actor: { id: 'actor', email: 'admin@yesi.local', role: 'admin', permissions: ['read', 'fulfill', 'stock', 'mapping', 'integrate', 'finance', 'audit', 'replay', 'supervise', 'admin'] },
  can: () => true,
  refresh: async () => null,
  mutate: async () => null,
  notify: () => {},
  navigate: () => {},
  params: {},
  events: [
    { seq: 231, id: 'e1', topic: 'order.created', aggregate_type: 'order', aggregate_id: 'abc', payload: { provider: 'ozon' }, created_at: new Date().toISOString() },
  ],
  connected: true,
} as Ctx;

const surfaces = [
  ['control tower', Overview],
  ['orders', Orders],
  ['inventory', Inventory],
  ['receiving', Receiving],
  ['warehouse', Warehouse],
  ['waves', Waves],
  ['shipping', Shipping],
  ['connectors', Connectors],
  ['mapping', Mapping],
  ['exceptions', Exceptions],
  ['finance', Finance],
  ['reconciliation', Reconciliation],
  ['audit', Audit],
  ['platform', Platform],
] as const;

describe('console surfaces', () => {
  for (const [name, Component] of surfaces) {
    it(`renders ${name}`, () => {
      const html = renderToString(createElement(Component as any, { ctx }));
      expect(html.length).toBeGreaterThan(500);
      expect(html).not.toContain('undefined');
    });
  }

  it('renders the sign-in surface', () => {
    const html = renderToString(createElement(Login, { onAuthenticated: () => {} }));
    expect(html).toContain('Sign in');
    expect(html).toContain('Ozon');
  });

  it('renders an order inspector with relations', () => {
    const selected = { ...ctx, params: { id: fixture.orders[0].id } } as Ctx;
    const html = renderToString(createElement(Orders, { ctx: selected }));
    expect(html).toContain('Orders');
  });
});
