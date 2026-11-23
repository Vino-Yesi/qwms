import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { db, fail, many, maybeOne, tx } from '../db/index.js';
import { guard, mutation, type RouteDoc } from './shared.js';
import {
  connectionDetail,
  createConnection,
  listConnections,
  rotateWebhookSecret,
  runPull,
  simulateInbound,
  updateConnection,
  verifyWebhook,
  connectorSummary,
} from '../integrations/hub.js';
import { adapters } from '../integrations/adapters.js';
import { credentialsSchema } from '../integrations/credentials.js';
import { loadConnection, nativeEventIdentity, replayRawEvent, storeRawEvent } from '../integrations/ingestion.js';
import { applyTrackingUpdate } from '../domain/fulfillment.js';
import {
  approveMapping,
  createProductAndMap,
  listMappings,
  listPendingMappings,
} from '../domain/mapping.js';
import { SYSTEM_ACTOR } from '../config.js';

const uuid = z.uuid();

export function registerIntegrationRoutes(app: FastifyInstance, docs: RouteDoc[]) {
  app.get('/api/v1/integrations', { preHandler: guard('read') }, async () => ({
    items: await listConnections(),
    summary: await connectorSummary(),
    catalog: Object.values(adapters).map((adapter) => ({
      provider: adapter.provider,
      label: adapter.label,
      docs: adapter.docsUrl,
      capabilities: adapter.capabilities,
      credentials: adapter.credentialFields,
    })),
    mode: config.connectorMode,
    live_enabled: config.allowLiveConnectors,
  }));

  app.get('/api/v1/integrations/:id', { preHandler: guard('integrate') }, async (req) => {
    return connectionDetail(uuid.parse((req.params as any).id));
  });

  mutation(app, docs, {
    path: '/api/v1/integrations',
    permission: 'integrate',
    schema: z
      .object({
        provider: z.enum(['ozon', 'yandex', 'wildberries']),
        name: z.string().min(1).max(120),
        account_ref: z.string().min(1).max(120),
        webhook_secret: z.string().min(32).max(200),
        mode: z.enum(['sandbox', 'live']).default('sandbox'),
        webhook_scheme: z.enum(['yesi-hmac-v1', 'wildberries-hmac-v1', 'yandex-hmac-v1']).default('yesi-hmac-v1'),
        credentials: credentialsSchema.optional(),
        config: z.record(z.string(), z.unknown()).default({}),
      })
      .strict(),
    description: 'Register a marketplace connector; secrets are encrypted at rest',
    handler: ({ actor, body }) =>
      createConnection(actor, {
        provider: body.provider,
        name: body.name,
        accountRef: body.account_ref,
        webhookSecret: body.webhook_secret,
        mode: body.mode,
        webhookScheme: body.webhook_scheme,
        credentials: body.credentials,
        config: body.config,
      }),
  });

  mutation(app, docs, {
    path: '/api/v1/integrations/:id',
    permission: 'integrate',
    method: 'PATCH',
    schema: z
      .object({
        name: z.string().min(1).max(120).optional(),
        status: z.enum(['enabled', 'paused']).optional(),
        mode: z.enum(['sandbox', 'live']).optional(),
        credentials: credentialsSchema.optional(),
        config: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    handler: ({ actor, id, body }) => updateConnection(actor, uuid.parse(id), body),
  });

  mutation(app, docs, {
    path: '/api/v1/integrations/:id/rotate-secret',
    permission: 'integrate',
    schema: z.object({ webhook_secret: z.string().min(32).max(200) }).strict(),
    description: 'Rotate the webhook signing secret; the previous secret stays valid for 24 hours',
    handler: ({ actor, id, body }) => rotateWebhookSecret(actor, uuid.parse(id), body.webhook_secret),
  });

  mutation(app, docs, {
    path: '/api/v1/integrations/:id/sync',
    permission: 'integrate',
    schema: z.object({}).strict(),
    description: 'Pull new orders from the marketplace now',
    transactional: false,
    handler: ({ actor, id }) => runPull(uuid.parse(id), actor, 'manual'),
  });

  mutation(app, docs, {
    path: '/api/v1/integrations/:id/simulate',
    permission: 'integrate',
    schema: z
      .object({
        scenario: z.enum(['normal', 'multi_line', 'unmapped', 'cancelled', 'malformed']),
        seed: z.number().int().nonnegative().optional(),
        external_id: z.string().min(1).max(80).optional(),
      })
      .strict(),
    description: 'Feed a native marketplace payload through signature verification and ingestion',
    handler: ({ actor, id, body }) =>
      simulateInbound(actor, uuid.parse(id), body.scenario, body.seed, body.external_id),
  });

  app.get('/api/v1/integrations/:id/raw', { preHandler: guard('integrate') }, async (req) => {
    const id = uuid.parse((req.params as any).id);
    return {
      items: await many(
        db,
        `SELECT id, external_event_id, event_type, status, attempts, last_error, order_id,
                signature_verified, payload_hash, received_at, processed_at
         FROM raw_events WHERE connection_id=$1 ORDER BY received_at DESC LIMIT 200`,
        [id],
      ),
    };
  });

  // Signed marketplace ingress. No session: authenticity comes from the HMAC.
  const webhook = async (req: FastifyRequest, reply: any) => {
    const id = uuid.parse((req.params as any).id);
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    if (raw.length === 0) fail(400, 'EMPTY_BODY', 'Webhook body is empty');
    if (raw.length > 512 * 1024) fail(413, 'PAYLOAD_TOO_LARGE', 'Webhook payload exceeds 512 KB');
    const headerProvider = (req.params as any).provider;
    const connection = await tx((c) => loadConnection(c, id, { enabledOnly: true }));
    if (headerProvider && headerProvider !== connection.provider) {
      fail(422, 'PROVIDER_MISMATCH', `Connection belongs to ${connection.provider}, not ${headerProvider}`);
    }
    const check = verifyWebhook(connection, req.headers as any, raw);
    if (!check.ok) fail(401, 'INVALID_SIGNATURE', `Webhook signature rejected: ${check.reason}`);
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      fail(400, 'INVALID_JSON', 'Webhook body is not valid JSON');
    }
    const result = await storeRawEvent({
      connection,
      payload,
      eventType: String((req.headers['x-yesi-event-type'] as string) || 'order'),
      externalEventId: String((req.headers['x-yesi-event-id'] as string) || ''),
      headers: {
        scheme: check.scheme,
        user_agent: String(req.headers['user-agent'] || ''),
        signature_verified: true,
        provider_event: nativeEventIdentity(connection.provider, payload),
      },
      signatureVerified: true,
    });
    reply.code(202);
    return { accepted: true, ...result };
  };
  app.post(
    '/api/v1/integrations/:id/webhooks',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    webhook,
  );
  app.post(
    '/api/v1/integrations/:id/webhooks/:provider',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    webhook,
  );

  mutation(app, docs, {
    path: '/api/v1/raw-events/:id/replay',
    permission: 'replay',
    schema: z.object({}).strict(),
    handler: ({ actor, id }) => replayRawEvent(actor, uuid.parse(id)),
  });

  // ------------------------------------------------------------------ TMS --
  app.post(
    '/api/v1/tms/webhooks/tracking',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!config.tmsWebhookSecret) fail(503, 'TMS_WEBHOOK_DISABLED', 'No TMS webhook secret is configured');
      const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
      const supplied = String(req.headers['x-tms-signature'] || '').replace(/^sha256=/, '');
      const expected = createHmac('sha256', config.tmsWebhookSecret).update(raw).digest('hex');
      if (!supplied || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
        fail(401, 'INVALID_SIGNATURE', 'Carrier signature rejected');
      }
      const body = z
        .object({
          shipment_id: uuid,
          status: z.enum(['DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'EXCEPTION']),
          event_id: z.string().min(3).max(160),
          message: z.string().max(300).optional(),
          occurred_at: z.iso.datetime().optional(),
        })
        .strict()
        .parse(req.body);
      const result = await applyTrackingUpdate({
        shipmentId: body.shipment_id,
        status: body.status,
        externalEventId: body.event_id,
        message: body.message,
        payload: { occurred_at: body.occurred_at, carrier_push: true },
        source: 'TMS',
      });
      reply.code(202);
      return { accepted: true, ...result };
    },
  );

  // -------------------------------------------------------------- mapping --
  app.get('/api/v1/sku-mappings', { preHandler: guard('read') }, async (req) => {
    const q = z.object({ connection_id: z.uuid().optional() }).parse(req.query);
    return { items: await listMappings(q.connection_id) };
  });

  app.get('/api/v1/sku-mappings/pending', { preHandler: guard('read') }, async () => ({
    items: await listPendingMappings(),
  }));

  mutation(app, docs, {
    path: '/api/v1/sku-mappings',
    permission: 'mapping',
    schema: z
      .object({
        connection_id: uuid,
        external_sku: z.string().min(1).max(120),
        sku: z.string().min(1).max(100),
        external_name: z.string().max(200).optional(),
      })
      .strict(),
    description: 'Approve a marketplace SKU mapping and repair waiting orders',
    handler: ({ actor, body }) =>
      approveMapping(actor, {
        connectionId: body.connection_id,
        externalSku: body.external_sku,
        sku: body.sku,
        externalName: body.external_name,
      }),
  });

  mutation(app, docs, {
    path: '/api/v1/sku-mappings/product',
    permission: 'mapping',
    schema: z
      .object({
        connection_id: uuid,
        external_sku: z.string().min(1).max(120),
        sku: z.string().min(1).max(100),
        name: z.string().min(1).max(200),
        category: z.string().min(1).max(80),
        cost_minor: z.number().int().nonnegative().max(1e10),
        external_name: z.string().max(200).optional(),
      })
      .strict(),
    description: 'Create a product and approve its marketplace mapping atomically',
    handler: ({ actor, body }) =>
      createProductAndMap(actor, {
        connectionId: body.connection_id,
        externalSku: body.external_sku,
        sku: body.sku,
        name: body.name,
        category: body.category,
        costMinor: body.cost_minor,
        externalName: body.external_name,
      }),
  });

  app.get('/api/v1/integrations/:id/ops', { preHandler: guard('integrate') }, async (req) => {
    const id = uuid.parse((req.params as any).id);
    return {
      items: await many(
        db,
        'SELECT * FROM provider_operations WHERE connection_id=$1 ORDER BY created_at DESC LIMIT 200',
        [id],
      ),
    };
  });

  // Exposed for the simulator documentation pane.
  app.get('/api/v1/integrations/:id/samples', { preHandler: guard('integrate') }, async (req) => {
    const id = uuid.parse((req.params as any).id);
    const connection = await maybeOne<any>(db, 'SELECT provider FROM connections WHERE id=$1', [id]);
    if (!connection) fail(404, 'NOT_FOUND', 'Connection not found');
    const adapter = adapters[connection.provider];
    return {
      provider: connection.provider,
      samples: {
        normal: adapter.sample('normal', 1001),
        multi_line: adapter.sample('multi_line', 1002),
        unmapped: adapter.sample('unmapped', 1003),
        cancelled: adapter.sample('cancelled', 1004),
        malformed: adapter.sample('malformed', 1005),
      },
    };
  });

  void SYSTEM_ACTOR;
}
