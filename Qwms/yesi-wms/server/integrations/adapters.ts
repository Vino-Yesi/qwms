/**
 * Marketplace adapters.
 *
 * Each adapter owns exactly one responsibility: translating between a
 * marketplace's native contract and the canonical order, and describing the
 * outbound calls for status, stock and shipment confirmation. Nothing here
 * touches the database; ingestion, retries, idempotency and audit live in the
 * service layer so all three providers share the same guarantees.
 *
 * The native samples are contract fixtures: they are what the certified
 * sandbox simulator feeds through the exact same normalisation path used in
 * production. A payload that drifts from the documented shape raises
 * ConnectorContractError and parks in the exception queue; it never becomes a
 * guessed order.
 */
import { canonicalOrderSchema, type CanonicalOrder } from '../domain/schema.js';
import {
  ConnectorContractError,
  type ConnectorAdapter,
  type ConnectorContext,
  type NormalizedEvent,
  type OutboundOperation,
  type TransportCall,
} from './types.js';

const HOUR = 3600_000;
const iso = (value: unknown, fallbackMs: number): string => {
  const date = value ? new Date(String(value)) : new Date(fallbackMs);
  if (Number.isNaN(date.getTime())) return new Date(fallbackMs).toISOString();
  return date.toISOString();
};
const minor = (value: unknown): number => {
  const n = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid money value: ${String(value)}`);
  return Math.round(n * 100);
};
const kopeck = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid kopeck value: ${String(value)}`);
  return n;
};
const text = (value: unknown): string => String(value ?? '').trim();

function validate(provider: string, draft: unknown): CanonicalOrder {
  const parsed = canonicalOrderSchema.safeParse(draft);
  if (!parsed.success) {
    throw new ConnectorContractError(provider, 'Canonical order validation failed', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}

function sampleCustomer(seed: number): string {
  return ['Nordwind Retail', 'Apex Mart', 'Lumina Store', 'BrightCart Co.', 'Peak Supply', 'Urban Nest'][seed % 6];
}

// --------------------------------------------------------------------- Ozon --
const ozon: ConnectorAdapter = {
  provider: 'ozon',
  label: 'Ozon',
  docsUrl: 'https://docs.ozon.ru/api/seller/en/',
  capabilities: ['orders.pull', 'orders.webhook', 'status.push', 'stock.push', 'shipment.confirm', 'label'],
  credentialFields: [
    { key: 'clientId', label: 'Client-Id', required: true, secret: false },
    { key: 'apiKey', label: 'Api-Key', required: true, secret: true },
    { key: 'warehouseId', label: 'Warehouse ID', required: false, secret: false },
  ],
  normalize(payload, ctx): NormalizedEvent {
    if (!payload || typeof payload !== 'object') throw new ConnectorContractError('ozon', 'Payload is not an object');
    const posting = text(payload.posting_number);
    if (!posting) throw new ConnectorContractError('ozon', 'posting_number is required');
    const status = text(payload.status).toLowerCase();
    if (status === 'cancelled' || status === 'canceled') {
      return { kind: 'cancel', eventType: 'order.cancelled', externalId: posting, reason: 'Ozon cancelled the posting' };
    }
    if (!Array.isArray(payload.products) || payload.products.length === 0) {
      throw new ConnectorContractError('ozon', 'posting.products must be a non-empty array');
    }
    let total = 0;
    const lines = payload.products.map((product: any) => {
      const external_sku = text(product.offer_id);
      const quantity = Number(product.quantity);
      if (!external_sku || !Number.isInteger(quantity) || quantity <= 0) {
        throw new ConnectorContractError('ozon', 'Each product needs offer_id and a positive integer quantity', { product });
      }
      const unit_price_minor = minor(product.price);
      total += unit_price_minor * quantity;
      return { external_sku, external_name: text(product.name) || undefined, quantity, unit_price_minor };
    });
    const order = validate(
      'ozon',
      {
        event_id: `ozon:${posting}:${status || 'awaiting_packaging'}:${text(payload.in_process_at || payload.created_at)}`,
        external_id: posting,
        customer_ref: `OZON-${posting}`,
        currency: 'RUB',
        total_minor: total,
        ship_by: iso(payload.shipment_date, Date.now() + 24 * HOUR),
        placed_at: iso(payload.in_process_at, Date.now()),
        priority: 'STANDARD',
        lines,
      },
    );
    void ctx;
    return { kind: 'order', eventType: 'order.created', externalId: posting, order };
  },
  sample(scenario, seed, externalId) {
    const id = externalId || `OZ-${String(seed).padStart(6, '0')}`;
    if (scenario === 'malformed') return { posting_number: id, status: 'awaiting_packaging', products: [{ quantity: 1 }] };
    const status = scenario === 'cancelled' ? 'cancelled' : 'awaiting_packaging';
    const products =
      scenario === 'multi_line'
        ? [
            { offer_id: 'OZ-ELC-4821', name: 'Aurora Wireless Earbuds Pro', quantity: 1, price: '2990.00', sku: 901001 },
            { offer_id: 'OZ-ELC-2210', name: 'Nimbus 65W GaN Charger', quantity: 2, price: '1790.00', sku: 901002 },
          ]
        : scenario === 'unmapped'
          ? [{ offer_id: `OZ-UNMAPPED-${seed % 97}`, name: 'New seller SKU awaiting mapping', quantity: 1, price: '1290.00', sku: 902001 }]
          : [{ offer_id: 'OZ-ELC-4821', name: 'Aurora Wireless Earbuds Pro', quantity: 1, price: '2990.00', sku: 901001 }];
    return {
      posting_number: id,
      order_id: seed,
      order_number: `OZ-ORD-${seed}`,
      status,
      in_process_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      shipment_date: new Date(Date.now() + 18 * HOUR).toISOString(),
      products,
      analytics_data: { region: 'Moscow', city: 'Moscow' },
      financial_data: { posting_services: { marketplace_service_item_deliv_to_customer: 0 } },
    };
  },
  request(operation, ctx, input, idempotencyKey): TransportCall {
    const base = 'https://api-seller.ozon.ru';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Client-Id': String(ctx.credentials.clientId || ''),
      'Api-Key': String(ctx.credentials.apiKey || ''),
      'X-Idempotency-Key': idempotencyKey,
    };
    if (operation === 'pull_orders') {
      const since = iso(input.since, Date.now() - 30 * 60_000);
      return {
        operation,
        method: 'POST',
        url: `${base}/v3/posting/fbs/list`,
        headers,
        idempotencyKey,
        body: { dir: 'ASC', filter: { since, to: new Date().toISOString(), status: 'awaiting_packaging' }, limit: 100, offset: Number(input.offset || 0), with: { analytics_data: false, financial_data: false } },
      };
    }
    if (operation === 'push_status' || operation === 'confirm_shipment') {
      const posting = String(input.external_id);
      if (input.status === 'CANCELLED' || input.status === 'CANCELLED_BY_SELLER') {
        return { operation, method: 'POST', url: `${base}/v2/posting/fbs/cancel`, headers, idempotencyKey, body: { posting_number: posting, cancel_reason_id: 402, cancel_reason_message: 'Seller cancellation' } };
      }
      return {
        operation,
        method: 'POST',
        url: `${base}/v2/posting/fbs/ship`,
        headers,
        idempotencyKey,
        body: { posting_number: posting, packages: [{ products: (input.products || []).map((p: any) => ({ product_id: p.product_id, quantity: p.quantity })) }], with: { additional_data: false } },
      };
    }
    if (operation === 'push_stock') {
      return {
        operation,
        method: 'POST',
        url: `${base}/v1/product/import/stocks`,
        headers,
        idempotencyKey,
        body: { stocks: (input.stocks || []).map((s: any) => ({ offer_id: s.external_sku, stock: s.available, warehouse_id: Number(ctx.credentials.warehouseId || 0) || undefined })) },
      };
    }
    return { operation, method: 'POST', url: `${base}/v1/posting/fbs/act/create`, headers, idempotencyKey, body: { posting_number: [String(input.external_id)] } };
  },
  sandboxAck(operation, input) {
    if (operation === 'pull_orders') return { result: { postings: input.postings || [], has_next: false } };
    if (operation === 'push_stock') return { result: { errors: [] } };
    return { result: true };
  },
};

// ------------------------------------------------------------- Yandex Market --
const yandex: ConnectorAdapter = {
  provider: 'yandex',
  label: 'Yandex Market',
  docsUrl: 'https://yandex.ru/dev/market/partner-api/doc/en/reference/orders/getBusinessOrders',
  capabilities: ['orders.pull', 'orders.webhook', 'status.push', 'stock.push', 'shipment.confirm', 'label'],
  credentialFields: [
    { key: 'apiKey', label: 'OAuth token', required: true, secret: true },
    { key: 'businessId', label: 'Business ID', required: true, secret: false },
    { key: 'campaignId', label: 'Campaign ID', required: false, secret: false },
  ],
  normalize(payload, ctx): NormalizedEvent {
    if (!payload || typeof payload !== 'object') throw new ConnectorContractError('yandex', 'Payload is not an object');
    if (payload.id === undefined) throw new ConnectorContractError('yandex', 'order.id is required');
    const externalId = String(payload.id);
    const status = text(payload.status).toUpperCase();
    if (['CANCELLED', 'CANCELED'].includes(status)) {
      return { kind: 'cancel', eventType: 'order.cancelled', externalId, reason: `Yandex Market status ${status}` };
    }
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      throw new ConnectorContractError('yandex', 'order.items must be a non-empty array');
    }
    let total = 0;
    const lines = payload.items.map((item: any) => {
      const external_sku = text(item.offerId);
      const quantity = Number(item.count);
      if (!external_sku || !Number.isInteger(quantity) || quantity <= 0) {
        throw new ConnectorContractError('yandex', 'Each item needs offerId and a positive integer count', { item });
      }
      const unit_price_minor = minor(item.price ?? item.prices?.payment?.value);
      total += unit_price_minor * quantity;
      return { external_sku, external_name: text(item.offerName) || undefined, quantity, unit_price_minor };
    });
    const shipDate = payload.delivery?.shipment?.shipmentDate;
    const order = validate(
      'yandex',
      {
        event_id: `yandex:${externalId}:${status}:${text(payload.updatedAt || payload.createdAt)}`,
        external_id: externalId,
        customer_ref: `YANDEX-${externalId}`,
        currency: 'RUB',
        total_minor: total,
        ship_by: shipDate
          ? new Date(`${String(shipDate).slice(0, 10)}T23:59:59+03:00`).toISOString()
          : iso(undefined, Date.now() + 48 * HOUR),
        placed_at: iso(payload.createdAt, Date.now()),
        priority: payload.delivery?.tags?.includes('EXPRESS') ? 'EXPRESS' : 'STANDARD',
        lines,
      },
    );
    void ctx;
    return { kind: 'order', eventType: 'order.created', externalId, order };
  },
  sample(scenario, seed, externalId) {
    const id = externalId || String(410000 + seed);
    if (scenario === 'malformed') return { id, status: 'PROCESSING', items: [{ count: 2 }] };
    const status = scenario === 'cancelled' ? 'CANCELLED' : 'PROCESSING';
    const items =
      scenario === 'multi_line'
        ? [
            { offerId: 'YM-APR-2245', offerName: 'Summit Fleece Hoodie', count: 2, price: 1590 },
            { offerId: 'YM-APR-4412', offerName: 'Cloudstep Crew Socks 3pk', count: 3, price: 290 },
          ]
        : scenario === 'unmapped'
          ? [{ offerId: `YM-UNMAPPED-${seed % 89}`, offerName: 'Unmapped Yandex offer', count: 1, price: 1990 }]
          : [{ offerId: 'YM-ELC-3390', offerName: 'Pulse Fitness Band X2', count: 1, price: 2490 }];
    return {
      id,
      status,
      createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      updatedAt: new Date().toISOString(),
      items,
      delivery: { shipment: { shipmentDate: new Date(Date.now() + 26 * HOUR).toISOString().slice(0, 10) }, tags: [] },
      buyer: { firstName: 'Demo', lastName: 'Buyer' },
      paymentType: 'PREPAID',
    };
  },
  request(operation, ctx, input, idempotencyKey): TransportCall {
    const business = String(ctx.credentials.businessId || '');
    const campaign = String(ctx.credentials.campaignId || '');
    const base = `https://api.partner.market.yandex.ru/v1/businesses/${encodeURIComponent(business)}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${String(ctx.credentials.apiKey || '')}`,
      'X-Idempotency-Key': idempotencyKey,
    };
    if (operation === 'pull_orders') {
      return {
        operation,
        method: 'POST',
        url: `${base}/orders`,
        headers,
        idempotencyKey,
        body: { dates: { updateDateFrom: iso(input.since, Date.now() - 30 * 60_000), updateDateTo: new Date().toISOString() }, limit: 50 },
      };
    }
    if (operation === 'push_status' || operation === 'confirm_shipment') {
      return {
        operation,
        method: 'PUT',
        url: `${base}/orders/${encodeURIComponent(String(input.external_id))}/status`,
        headers,
        idempotencyKey,
        body: { order: { status: String(input.marketplace_status || 'PROCESSING') } },
      };
    }
    if (operation === 'push_stock') {
      return {
        operation,
        method: 'PUT',
        url: `${base}/offer-mappings/stocks`,
        headers,
        idempotencyKey,
        body: {
          stocks: (input.stocks || []).map((s: any) => ({
            offerId: s.external_sku,
            count: s.available,
            ...(campaign ? { campaignId: campaign } : {}),
          })),
        },
      };
    }
    return { operation, method: 'PUT', url: `${base}/orders/${encodeURIComponent(String(input.external_id))}/status`, headers, idempotencyKey, body: { order: { status: 'PROCESSING' } } };
  },
  sandboxAck(operation, input) {
    if (operation === 'pull_orders') return { orders: input.orders || [], paging: { nextPageToken: null } };
    if (operation === 'push_stock') return { status: 'OK' };
    return { status: 'OK' };
  },
};

// ---------------------------------------------------------------- Wildberries --
const wildberries: ConnectorAdapter = {
  provider: 'wildberries',
  label: 'Wildberries',
  docsUrl: 'https://dev.wildberries.ru/en/docs/openapi/orders-fbs',
  capabilities: ['orders.pull', 'orders.webhook', 'status.push', 'stock.push', 'shipment.confirm', 'sticker'],
  credentialFields: [
    { key: 'apiKey', label: 'API token', required: true, secret: true },
    { key: 'warehouseId', label: 'Warehouse ID', required: true, secret: false },
  ],
  normalize(payload, ctx): NormalizedEvent {
    if (!payload || typeof payload !== 'object') throw new ConnectorContractError('wildberries', 'Payload is not an object');
    if (payload.id === undefined) throw new ConnectorContractError('wildberries', 'order.id is required');
    if (!Number.isFinite(Number(payload.id))) {
      throw new ConnectorContractError('wildberries', 'order.id must be numeric');
    }
    const externalId = String(payload.id);
    const status = text(payload.status).toLowerCase();
    if (['canceled', 'cancelled'].includes(status)) {
      return { kind: 'cancel', eventType: 'order.cancelled', externalId, reason: 'Wildberries cancelled the order' };
    }
    const sku = text(payload.chrtId ?? payload.skus?.[0]);
    const quantity = Number(payload.quantity ?? 1);
    if (!sku) throw new ConnectorContractError('wildberries', 'chrtId (barcode) is required to map the order');
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ConnectorContractError('wildberries', 'quantity must be a positive integer');
    }
    const unit = kopeck(payload.convertedPrice ?? payload.price ?? payload.salePrice);
    if (!unit) throw new ConnectorContractError('wildberries', 'price must be a positive amount in kopecks');
    const order = validate(
      'wildberries',
      {
        event_id: `wb:${externalId}:${status || 'new'}:${text(payload.createdAt || payload.ddate)}`,
        external_id: externalId,
        customer_ref: `WB-${externalId}`,
        currency: 'RUB',
        total_minor: unit * quantity,
        ship_by: iso(payload.ddate, Date.now() + 24 * HOUR),
        placed_at: iso(payload.createdAt, Date.now()),
        priority: 'STANDARD',
        lines: [{ external_sku: sku, external_name: text(payload.article) || undefined, quantity, unit_price_minor: unit }],
      },
    );
    void ctx;
    return { kind: 'order', eventType: 'order.created', externalId, order };
  },
  sample(scenario, seed, externalId) {
    const numeric = Number(externalId ?? 7_700_000 + seed);
    const id = Number.isFinite(numeric) && numeric > 0 ? numeric : 7_700_000 + seed;
    if (scenario === 'malformed') return { id, convertedPrice: 'nope', chrtId: 0 };
    const status = scenario === 'cancelled' ? 'canceled' : 'waiting';
    const base = {
      id,
      rid: `rid-${seed}`,
      createdAt: new Date(Date.now() - 12 * 60_000).toISOString(),
      warehouseId: 507,
      nmId: 8800000 + (seed % 100),
      chrtId: scenario === 'unmapped' ? 999000 + (seed % 71) : 5500001,
      article: scenario === 'unmapped' ? 'WB-UNMAPPED' : 'WB-ELC-5567',
      price: 199000,
      convertedPrice: 199000,
      currencyCode: 643,
      status,
      ddate: new Date(Date.now() + 20 * HOUR).toISOString(),
      offices: ['Koledino'],
      skus: [scenario === 'unmapped' ? `999000${seed % 71}` : '5500001'],
      quantity: 1,
    };
    if (scenario === 'multi_line') {
      return { ...base, price: 389000, convertedPrice: 389000, quantity: 2 };
    }
    return base;
  },
  request(operation, ctx, input, idempotencyKey): TransportCall {
    const base = 'https://marketplace-api.wildberries.ru';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: String(ctx.credentials.apiKey || ''),
      'X-Idempotency-Key': idempotencyKey,
    };
    if (operation === 'pull_orders') {
      return {
        operation,
        method: 'GET',
        url: `${base}/api/v3/orders?limit=100&next=${encodeURIComponent(String(input.next || 0))}`,
        headers,
        idempotencyKey,
      };
    }
    if (operation === 'push_stock') {
      return {
        operation,
        method: 'PUT',
        url: `${base}/api/v3/stocks/${encodeURIComponent(String(ctx.credentials.warehouseId || ''))}`,
        headers,
        idempotencyKey,
        body: { stocks: (input.stocks || []).map((s: any) => ({ sku: s.external_sku, amount: s.available })) },
      };
    }
    if (operation === 'confirm_shipment') {
      return {
        operation,
        method: 'POST',
        url: `${base}/api/v3/orders/stickers?type=png&width=58&height=40`,
        headers,
        idempotencyKey,
        body: { orders: [Number(input.external_id)] },
      };
    }
    return {
      operation,
      method: 'POST',
      url: `${base}/api/v3/orders/status`,
      headers,
      idempotencyKey,
      body: { orders: [Number(input.external_id)] },
    };
  },
  sandboxAck(operation, input) {
    if (operation === 'pull_orders') return { next: 0, orders: input.orders || [] };
    if (operation === 'confirm_shipment') return { stickers: [{ orderId: input.external_id, file: 'sandbox-label' }] };
    return { ok: true };
  },
};

export const adapters: Record<string, ConnectorAdapter> = { ozon, yandex, wildberries };

export function adapterFor(provider: string): ConnectorAdapter {
  const adapter = adapters[provider];
  if (!adapter) throw new ConnectorContractError(provider, `Unknown marketplace provider ${provider}`);
  return adapter;
}

/** Provider-specific order status used when pushing state back. */
export function marketplaceStatus(provider: string, status: string): string {
  if (provider === 'ozon') {
    if (status === 'CANCELLED') return 'CANCELLED';
    if (status === 'SHIPPED' || status === 'DELIVERED') return 'SHIPPED';
    return 'PROCESSING';
  }
  if (provider === 'yandex') {
    if (status === 'CANCELLED') return 'CANCELLED';
    if (status === 'DELIVERED') return 'DELIVERED';
    if (status === 'SHIPPED') return 'DELIVERY';
    if (status === 'READY_TO_SHIP' || status === 'PACKED') return 'READY_TO_SHIP';
    return 'PROCESSING';
  }
  if (status === 'CANCELLED') return 'CANCELLED';
  if (status === 'SHIPPED') return 'SHIPPED';
  if (status === 'DELIVERED') return 'DELIVERED';
  return 'PROCESSING';
}

export function sampleFor(provider: string, scenario: any, seed: number, externalId?: string): any {
  return adapterFor(provider).sample(scenario, seed, externalId);
}

export type { OutboundOperation };
