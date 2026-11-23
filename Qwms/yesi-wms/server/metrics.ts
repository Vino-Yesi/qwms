import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const metrics = {
  requests: new Counter({
    name: 'yesi_http_requests_total',
    help: 'HTTP requests by route and status',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  }),
  duration: new Histogram({
    name: 'yesi_http_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [registry],
  }),
  processed: new Counter({
    name: 'yesi_outbox_events_total',
    help: 'Outbox events processed',
    labelNames: ['topic', 'outcome'] as const,
    registers: [registry],
  }),
  connectorCalls: new Counter({
    name: 'yesi_connector_calls_total',
    help: 'Marketplace connector calls',
    labelNames: ['provider', 'operation', 'status'] as const,
    registers: [registry],
  }),
  ingress: new Counter({
    name: 'yesi_ingress_events_total',
    help: 'Webhook and pull events by status',
    labelNames: ['provider', 'status'] as const,
    registers: [registry],
  }),
  backlog: new Gauge({
    name: 'yesi_outbox_backlog',
    help: 'Outbox events by status',
    labelNames: ['status'] as const,
    registers: [registry],
  }),
  exceptions: new Gauge({
    name: 'yesi_open_exceptions',
    help: 'Open exceptions by severity',
    labelNames: ['severity'] as const,
    registers: [registry],
  }),
  auditValid: new Gauge({
    name: 'yesi_audit_chain_valid',
    help: '1 when the audit hash chain verifies',
    registers: [registry],
  }),
  wsConnections: new Gauge({
    name: 'yesi_websocket_connections',
    help: 'Authenticated realtime clients',
    registers: [registry],
  }),
  wsEvents: new Counter({
    name: 'yesi_websocket_events_total',
    help: 'Events fanned out over WebSocket',
    registers: [registry],
  }),
};
