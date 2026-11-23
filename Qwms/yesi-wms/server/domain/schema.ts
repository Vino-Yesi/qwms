/** Canonical contracts shared by every marketplace, ERP and TMS integration. */
import { z } from 'zod';

export const canonicalOrderSchema = z
  .object({
    event_id: z.string().min(1).max(200),
    external_id: z.string().min(1).max(120),
    customer_ref: z.string().min(1).max(200),
    currency: z.literal('RUB'),
    total_minor: z.number().int().nonnegative().max(1e12),
    ship_by: z.iso.datetime(),
    placed_at: z.iso.datetime().optional(),
    priority: z.enum(['STANDARD', 'EXPRESS', 'SAME_DAY']).optional(),
    lines: z
      .array(
        z
          .object({
            external_sku: z.string().min(1).max(120),
            external_name: z.string().max(200).optional(),
            quantity: z.number().int().positive().max(10000),
            unit_price_minor: z.number().int().nonnegative().max(1e10),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict()
  .superRefine((value, ctx) => {
    const total = value.lines.reduce((sum, line) => sum + line.quantity * line.unit_price_minor, 0);
    if (total !== value.total_minor) {
      ctx.addIssue({ code: 'custom', path: ['total_minor'], message: 'Order total must equal the sum of line totals' });
    }
    if (new Set(value.lines.map((line) => line.external_sku)).size !== value.lines.length) {
      ctx.addIssue({ code: 'custom', path: ['lines'], message: 'Duplicate external SKU in order lines' });
    }
  });

export type CanonicalOrder = z.infer<typeof canonicalOrderSchema>;

export const ORDER_STATUSES = [
  'RECEIVED',
  'EXCEPTION',
  'MAPPED',
  'RESERVED',
  'PICKING',
  'PACKED',
  'READY_TO_SHIP',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'RETURNED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Application-level mirror of the database transition graph (for messages). */
export const ORDER_FLOWS: Record<OrderStatus, OrderStatus[]> = {
  RECEIVED: ['MAPPED', 'EXCEPTION', 'CANCELLED'],
  EXCEPTION: ['MAPPED', 'CANCELLED'],
  MAPPED: ['RESERVED', 'EXCEPTION', 'CANCELLED'],
  RESERVED: ['PICKING', 'MAPPED', 'CANCELLED'],
  PICKING: ['PACKED', 'EXCEPTION'],
  PACKED: ['READY_TO_SHIP', 'EXCEPTION'],
  READY_TO_SHIP: ['SHIPPED', 'EXCEPTION'],
  SHIPPED: ['DELIVERED', 'EXCEPTION'],
  DELIVERED: ['RETURNED'],
  CANCELLED: [],
  RETURNED: [],
};

export const SHIPMENT_FLOWS: Record<string, string[]> = {
  CREATED: ['BOOKED', 'EXCEPTION'],
  BOOKED: ['DISPATCHED', 'EXCEPTION', 'CANCELLED'],
  DISPATCHED: ['IN_TRANSIT', 'DELIVERED', 'EXCEPTION'],
  IN_TRANSIT: ['DELIVERED', 'EXCEPTION'],
  EXCEPTION: ['IN_TRANSIT', 'DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

export const MARKETPLACE_STATUS: Record<string, string> = {
  RECEIVED: 'PROCESSING',
  MAPPED: 'PROCESSING',
  RESERVED: 'PROCESSING',
  PICKING: 'PROCESSING',
  PACKED: 'READY_TO_SHIP',
  READY_TO_SHIP: 'READY_TO_SHIP',
  SHIPPED: 'SHIPPED',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
  EXCEPTION: 'PROCESSING',
  RETURNED: 'RETURNED',
};
