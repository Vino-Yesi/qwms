import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, fail, many, maybeOne } from '../db/index.js';
import { guard, mutation, type RouteDoc } from './shared.js';
import {
  cancelOrder,
  getOrderDetail,
  markReadyToShip,
  reserveOrder,
  slaState,
  versionSchema,
} from '../domain/orders.js';
import {
  applyTrackingUpdate,
  bookShipment,
  completeWave,
  createWave,
  dispatchShipment,
  pickTask,
  shipmentDetail,
} from '../domain/fulfillment.js';
import {
  adjustStock,
  approveCount,
  createAsn,
  listInventory,
  listLedger,
  receiveAsn,
  reconcileStock,
} from '../domain/inventory.js';
import {
  listAsns,
  listOrders,
  listShipments,
  listStockCounts,
  listWaves,
} from '../read-models.js';

const uuid = z.uuid();

export function registerOrderRoutes(app: FastifyInstance, docs: RouteDoc[]) {
  app.get('/api/v1/orders', { preHandler: guard('read') }, async (req) => {
    const q = z
      .object({
        status: z.string().max(30).optional(),
        provider: z.enum(['ozon', 'yandex', 'wildberries']).optional(),
        search: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
        offset: z.coerce.number().int().min(0).max(100_000).default(0),
      })
      .parse(req.query);
    return listOrders(q);
  });

  app.get('/api/v1/orders/:id', { preHandler: guard('read') }, async (req) => {
    const id = uuid.parse((req.params as any).id);
    const order = await getOrderDetail(id);
    return { ...order, sla: slaState(order) };
  });

  mutation(app, docs, {
    path: '/api/v1/orders/:id/reserve',
    permission: 'fulfill',
    schema: versionSchema,
    description: 'Reserve stock for a mapped order, atomically across locations',
    handler: ({ actor, id, body }) => reserveOrder(actor, uuid.parse(id), body.version),
  });

  mutation(app, docs, {
    path: '/api/v1/orders/:id/cancel',
    permission: 'fulfill',
    schema: versionSchema.extend({ reason: z.string().min(3).max(300) }),
    handler: ({ actor, id, body }) => cancelOrder(actor, uuid.parse(id), body.version, body.reason),
  });

  mutation(app, docs, {
    path: '/api/v1/orders/:id/ready',
    permission: 'fulfill',
    schema: versionSchema,
    description: 'Mark a packed order as ready for carrier handover',
    handler: ({ actor, id, body }) => markReadyToShip(actor, uuid.parse(id), body.version),
  });

  mutation(app, docs, {
    path: '/api/v1/orders/:id/ship',
    permission: 'fulfill',
    schema: versionSchema.extend({
      carrier: z.enum(['YESI Ground', 'YESI Express', 'Partner carrier']),
      service: z.enum(['STANDARD', 'EXPRESS', 'SAME_DAY']).default('STANDARD'),
    }),
    description: 'Create a shipment and request a carrier booking',
    handler: ({ actor, id, body }) => bookShipment(actor, uuid.parse(id), body.version, body.carrier, body.service),
  });

  // ------------------------------------------------------------------ waves --
  app.get('/api/v1/waves', { preHandler: guard('read') }, async () => ({ items: await listWaves() }));

  app.get('/api/v1/waves/:id', { preHandler: guard('read') }, async (req) => {
    const id = uuid.parse((req.params as any).id);
    const wave = await maybeOne(db, `SELECT * FROM waves WHERE id=$1`, [id]);
    if (!wave) fail(404, 'NOT_FOUND', 'Wave not found');
    const [orders, tasks] = await Promise.all([
      many(
        db,
        `SELECT o.id, o.external_id, o.status, o.version, c.provider
         FROM wave_orders wo JOIN orders o ON o.id=wo.order_id JOIN connections c ON c.id=o.connection_id
         WHERE wo.wave_id=$1 ORDER BY o.external_id`,
        [id],
      ),
      many(db, 'SELECT * FROM pick_tasks WHERE wave_id=$1 ORDER BY location, sku', [id]),
    ]);
    return { ...wave, orders, tasks };
  });

  mutation(app, docs, {
    path: '/api/v1/waves',
    permission: 'fulfill',
    schema: z
      .object({
        order_ids: z.array(uuid).min(1).max(100),
        versions: z.record(z.string(), z.number().int().positive()),
      })
      .strict(),
    description: 'Release a wave of reserved orders and generate pick tasks',
    handler: ({ actor, body }) => createWave(actor, body.order_ids, body.versions),
  });

  mutation(app, docs, {
    path: '/api/v1/waves/:id/pick',
    permission: 'fulfill',
    schema: z.object({ task_id: uuid, picked: z.number().int().nonnegative().max(10_000) }).strict(),
    handler: async ({ actor, id, body }) => {
      uuid.parse(id);
      return pickTask(actor, body.task_id, body.picked);
    },
  });

  mutation(app, docs, {
    path: '/api/v1/waves/:id/complete',
    permission: 'fulfill',
    schema: z.object({}).strict(),
    description: 'Complete a fully picked wave and pack its orders',
    handler: ({ actor, id }) => completeWave(actor, uuid.parse(id)),
  });

  // -------------------------------------------------------------- shipments --
  app.get('/api/v1/shipments', { preHandler: guard('read') }, async () => ({ items: await listShipments() }));

  app.get('/api/v1/shipments/:id', { preHandler: guard('read') }, async (req) => {
    return shipmentDetail(uuid.parse((req.params as any).id));
  });

  mutation(app, docs, {
    path: '/api/v1/shipments/:id/dispatch',
    permission: 'fulfill',
    schema: versionSchema,
    description: 'Confirm carrier handover: consume reservations, recognise revenue, notify marketplace',
    handler: ({ actor, id, body }) => dispatchShipment(actor, uuid.parse(id), body.version),
  });

  mutation(app, docs, {
    path: '/api/v1/shipments/:id/tracking',
    permission: 'integrate',
    schema: z
      .object({
        status: z.enum(['DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'EXCEPTION']),
        event_id: z.string().min(3).max(160).optional(),
        message: z.string().max(300).optional(),
      })
      .strict(),
    description: 'Apply a carrier tracking scan (manual or simulated)',
    handler: ({ id, body }) => {
      uuid.parse(id);
      return applyTrackingUpdate({
        shipmentId: id,
        status: body.status,
        externalEventId: body.event_id || `manual:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        message: body.message,
        source: 'MANUAL',
      });
    },
  });

  // -------------------------------------------------------------- inventory --
  app.get('/api/v1/inventory', { preHandler: guard('read') }, async () => ({ items: await listInventory() }));

  app.get('/api/v1/inventory/ledger', { preHandler: guard('read') }, async (req) => {
    const q = z
      .object({ sku: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) })
      .parse(req.query);
    return { items: await listLedger(q.sku, q.limit) };
  });

  app.get('/api/v1/inventory/velocity', { preHandler: guard('read') }, async () => {
    const { inventoryVelocity } = await import('../domain/inventory.js');
    return { items: await inventoryVelocity() };
  });

  app.get('/api/v1/stock-counts', { preHandler: guard('read') }, async () => ({ items: await listStockCounts('') }));

  app.get('/api/v1/asns', { preHandler: guard('read') }, async () => ({ items: await listAsns() }));

  mutation(app, docs, {
    path: '/api/v1/asns',
    permission: 'stock',
    schema: z
      .object({
        supplier: z.string().min(1).max(160),
        reference: z.string().max(80).optional(),
        expected_at: z.iso.datetime().optional(),
        lines: z
          .array(
            z
              .object({
                sku: z.string().min(1).max(100),
                location: z.string().regex(/^[A-Z]-\d{2}-\d{2}$/),
                expected: z.number().int().positive().max(100_000),
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict(),
    handler: ({ actor, body }) =>
      createAsn(actor, { supplier: body.supplier, reference: body.reference, expectedAt: body.expected_at, lines: body.lines }),
  });

  mutation(app, docs, {
    path: '/api/v1/asns/:id/receive',
    permission: 'fulfill',
    schema: z
      .object({
        lines: z
          .array(
            z
              .object({
                sku: z.string().min(1).max(100),
                location: z.string().min(1).max(20),
                quantity: z.number().int().positive().max(100_000),
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict(),
    handler: ({ actor, id, body }) => receiveAsn(actor, uuid.parse(id), body),
  });

  mutation(app, docs, {
    path: '/api/v1/inventory/counts',
    permission: 'stock',
    schema: z
      .object({
        sku: z.string().min(1).max(100),
        location: z.string().min(1).max(20),
        counted: z.number().int().nonnegative().max(1_000_000),
        expected_version: z.number().int().positive(),
      })
      .strict(),
    description: 'Record a cycle count; variances require a separate approval',
    handler: ({ actor, body }) =>
      reconcileStock(actor, {
        sku: body.sku,
        location: body.location,
        counted: body.counted,
        expectedVersion: body.expected_version,
      }),
  });

  mutation(app, docs, {
    path: '/api/v1/stock-counts/:id/approve',
    permission: 'supervise',
    schema: z.object({}).strict(),
    handler: ({ actor, id }) => approveCount(actor, uuid.parse(id)),
  });

  mutation(app, docs, {
    path: '/api/v1/inventory/adjust',
    permission: 'supervise',
    schema: z
      .object({
        sku: z.string().min(1).max(100),
        location: z.string().min(1).max(20),
        delta: z.number().int().min(-100_000).max(100_000).refine((value) => value !== 0, 'delta must be non-zero'),
        reason: z.enum(['DAMAGE','FOUND','LOST','SUPPLIER_SHORTAGE','MANUAL_CORRECTION']),
        note: z.string().max(300).optional(),
      })
      .strict(),
    handler: ({ actor, body }) => adjustStock(actor, body),
  });
}
