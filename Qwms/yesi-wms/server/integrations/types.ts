import type { ConnectorProvider } from '../config.js';
import type { CanonicalOrder } from '../domain/schema.js';

export type ConnectorCredentials = {
  apiKey?: string;
  clientId?: string;
  businessId?: string;
  campaignId?: string;
  warehouseId?: string;
};

export type ConnectorContext = {
  connectionId: string;
  provider: ConnectorProvider;
  accountRef: string;
  mode: 'sandbox' | 'live';
  credentials: ConnectorCredentials;
  config: Record<string, unknown>;
};

export type NormalizedEvent = {
  kind: 'order' | 'cancel';
  eventType: string;
  externalId: string;
  order?: CanonicalOrder;
  reason?: string;
};

/** Raised when a marketplace payload no longer matches the certified contract. */
export class ConnectorContractError extends Error {
  constructor(
    public provider: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ConnectorContractError';
  }
}

export type OutboundOperation =
  | 'pull_orders'
  | 'push_status'
  | 'push_stock'
  | 'confirm_shipment'
  | 'push_cancellation';

export type TransportCall = {
  operation: OutboundOperation;
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  idempotencyKey: string;
};

export type ConnectorAdapter = {
  provider: ConnectorProvider;
  label: string;
  docsUrl: string;
  capabilities: string[];
  credentialFields: Array<{ key: keyof ConnectorCredentials; label: string; required: boolean; secret: boolean }>;
  /** Native payload -> canonical event. Never guesses: throws ConnectorContractError. */
  normalize(payload: any, ctx: ConnectorContext): NormalizedEvent;
  /** Deterministic native payloads used by the certified sandbox simulator. */
  sample(scenario: 'normal' | 'multi_line' | 'unmapped' | 'cancelled' | 'malformed', seed: number, externalId?: string): unknown;
  /** Build the outbound HTTP request for an operation. */
  request(operation: OutboundOperation, ctx: ConnectorContext, input: any, idempotencyKey: string): TransportCall;
  /** Sandbox acknowledgement that mirrors the native response contract. */
  sandboxAck(operation: OutboundOperation, input: any): unknown;
};
