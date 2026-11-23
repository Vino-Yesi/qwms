/**
 * HTTP surface.
 *
 * Same-origin only, cookie sessions + CSRF for humans, HMAC for machines,
 * idempotency keys on every mutation, strict validation, RBAC on every route.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { db, DomainError, fail, normalizeDbError, query, verifyAudit } from '../db/index.js';
import { metrics, registry } from '../metrics.js';
import { registerAuth, SESSION } from '../auth.js';
import { attachRealtime } from '../realtime.js';
import { guard, type RouteDoc } from './shared.js';
import { registerOrderRoutes } from './orders.js';
import { registerIntegrationRoutes } from './integrations.js';
import { registerPlatformRoutes } from './platform.js';
import { outboxTopics } from '../read-models.js';
import { workerHealth } from '../worker.js';
import { auditStatus } from '../read-models.js';

const routeDocs: RouteDoc[] = [];

export async function buildApp(): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  const app = Fastify({
    logger: false,
    bodyLimit: 1_048_576,
    trustProxy: false,
    disableRequestLogging: true,
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: config.development ? ["'self'", 'https://*.e2b.app', 'https://arena.ai'] : ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    frameguard: config.development ? false : { action: 'deny' },
    hsts: config.development ? false : { maxAge: 31_536_000, includeSubDomains: true },
    referrerPolicy: { policy: 'no-referrer' },
  });

  // Preserve the exact bytes for webhook signature verification.
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1_048_576 }, (req, body, done) => {
    const buffer = body as Buffer;
    req.rawBody = buffer;
    if (buffer.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(buffer.toString('utf8')));
    } catch {
      done(Object.assign(new Error('Body is not valid JSON'), { statusCode: 400, code: 'INVALID_JSON' }), undefined);
    }
  });

  app.addHook('onRequest', async (req) => {
    const origin = req.headers.origin;
    if (origin) {
      let allowed = false;
      try {
        const incoming = new URL(origin);
        const host = String(req.headers.host || '');
        allowed = incoming.host === host;
        if (!allowed && config.development) allowed = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(incoming.host) || /\.e2b\.app$/.test(incoming.host);
        if (!allowed && config.appOrigin) allowed = incoming.origin === new URL(config.appOrigin).origin;
      } catch {
        allowed = false;
      }
      if (!allowed) fail(403, 'ORIGIN_REJECTED', 'Cross-origin requests are not allowed');
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url || 'unmatched';
    metrics.requests.inc({ method: req.method, route, status: String(reply.statusCode) });
    metrics.duration.observe({ method: req.method, route }, reply.elapsedTime / 1000);
    console.log(
      JSON.stringify({
        level: reply.statusCode >= 500 ? 'error' : 'info',
        component: 'http',
        request_id: String(req.id),
        method: req.method,
        route,
        status: reply.statusCode,
        duration_ms: Math.round(reply.elapsedTime),
        actor_id: req.actor?.id,
      }),
    );
  });

  app.setErrorHandler((error, req, reply) => {
    const known = normalizeDbError(error);
    const zodError = known instanceof z.ZodError;
    const domain = known instanceof DomainError;
    const status = domain ? known.status : zodError ? 400 : (known as any)?.statusCode || 500;
    const code = domain
      ? known.code
      : zodError
        ? 'VALIDATION_ERROR'
        : status === 429
          ? 'RATE_LIMITED'
          : status === 413
            ? 'PAYLOAD_TOO_LARGE'
            : status === 400
              ? 'BAD_REQUEST'
              : 'INTERNAL_ERROR';
    if (status >= 500) {
      console.error(
        JSON.stringify({
          level: 'error',
          component: 'http',
          request_id: String(req.id),
          code,
          message: (known as Error).message,
        }),
      );
    }
    const message = zodError
      ? (known as z.ZodError).issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      : domain || status < 500
        ? (known as Error).message
        : 'Request failed. Contact support with the request id.';
    reply.status(status).send({ error: { code, message, request_id: String(req.id) } });
  });

  app.get('/health/live', async () => ({ status: 'ok', uptime_seconds: Math.round(process.uptime()) }));
  app.get('/health/ready', async (req, reply) => {
    try {
      await query('SELECT 1');
      const [worker, topics] = await Promise.all([workerHealth(), outboxTopics()]);
      const dead = topics.reduce((sum, topic: any) => sum + Number(topic.dead), 0);
      reply.code(dead > 0 ? 200 : 200);
      return {
        status: 'ok',
        database: db.kind,
        mode: config.connectorMode,
        environment: config.env,
        worker,
        dead_events: dead,
        checks: { database: 'ok', outbox: worker.pending > 500 ? 'degraded' : 'ok' },
      };
    } catch (error) {
      reply.code(503);
      return { status: 'unavailable', error: (error as Error).message };
    }
  });
  const health = async (req: any, reply: any) => {
    try {
      await query('SELECT 1');
      const worker = await workerHealth();
      return { status: 'ok', database: db.kind, worker, mode: config.connectorMode, version: '1.0.0' };
    } catch (error) {
      reply.code(503);
      return { status: 'unavailable', error: (error as Error).message };
    }
  };
  app.get('/health', health);
  app.get('/api/v1/health', health);

  app.get('/metrics', async (req, reply) => {
    if (config.metricsToken) {
      const header = String(req.headers.authorization || '');
      if (header !== 'Bearer ' + config.metricsToken) fail(401, 'UNAUTHENTICATED', 'Metrics token required');
    }
    const [backlog, bySeverity, audit] = await Promise.all([
      query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM outbox GROUP BY status'),
      query<{ severity: string; n: number }>(`SELECT severity, count(*)::int AS n FROM exceptions WHERE status='OPEN' GROUP BY severity`),
      auditStatus(),
    ]);
    for (const status of ['PENDING', 'PROCESSING', 'DONE', 'DEAD']) {
      metrics.backlog.set({ status }, Number(backlog.find((row) => row.status === status)?.n || 0));
    }
    for (const row of bySeverity) metrics.exceptions.set({ severity: row.severity }, Number(row.n));
    metrics.auditValid.set(audit.valid ? 1 : 0);
    reply.type(registry.contentType);
    return registry.metrics();
  });

  registerAuth(app);
  registerOrderRoutes(app, routeDocs);
  registerIntegrationRoutes(app, routeDocs);
  registerPlatformRoutes(app, routeDocs);

  // Route inventory for the OpenAPI document (GETs included automatically).
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/v1')) return;
    const method = String(route.method).toUpperCase();
    if (routeDocs.some((doc) => doc.path === route.url && doc.method === method)) return;
    routeDocs.push({ method, path: route.url, permission: 'read' });
  });

  app.get('/openapi.json', { preHandler: guard('read') }, async () => ({
    openapi: '3.1.0',
    info: {
      title: 'YESI Fulfillment OS',
      version: '1.0.0',
      description:
        'Event-driven fulfillment platform for Ozon, Yandex Market and Wildberries. Session cookie + X-CSRF-Token for humans; Idempotency-Key required on mutations; HMAC signature for marketplace and TMS webhooks.',
    },
    servers: [{ url: config.appOrigin || 'http://localhost:3000' }],
    paths: Object.fromEntries(
      routeDocs
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((doc) => [
          doc.path,
          {
            [doc.method.toLowerCase()]: {
              summary: doc.description || `${doc.permission} · ${doc.path}`,
              tags: [doc.path.split('/')[3] || 'platform'],
              security: doc.permission === 'webhook' ? [{ webhookSignature: [] }] : [{ sessionCookie: [] }],
              parameters: ['POST', 'PATCH', 'PUT'].includes(doc.method)
                ? [{ $ref: '#/components/parameters/IdempotencyKey' }]
                : [],
              requestBody: doc.schema
                ? { required: true, content: { 'application/json': { schema: doc.schema } } }
                : undefined,
              responses: {
                '200': { description: 'Success or idempotent replay' },
                '202': { description: 'Accepted for asynchronous processing' },
                '400': { description: 'Validation error' },
                '401': { description: 'Authentication required' },
                '403': { description: 'RBAC, CSRF or origin rejection' },
                '409': { description: 'State, version, stock or idempotency conflict' },
                '429': { description: 'Rate limited' },
              },
            },
          },
        ]),
    ),
    components: {
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: SESSION },
        webhookSignature: { type: 'apiKey', in: 'header', name: 'X-YESI-Signature' },
      },
      parameters: {
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          schema: { type: 'string', minLength: 8, maxLength: 128 },
        },
      },
    },
  }));

  app.get('/api/v1/audit/health', { preHandler: guard('audit') }, async () => verifyAudit());

  const realtime = attachRealtime(app);

  return {
    app,
    close: async () => {
      await realtime.close();
      await app.close();
    },
  };
}

export type { FastifyRequest };
