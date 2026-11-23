export type Actor = {
  id: string;
  email: string;
  role: string;
  permissions: string[];
  name?: string;
};

export type Order = {
  id: string;
  connection_id: string;
  external_id: string;
  status: string;
  version: number;
  customer_ref: string | null;
  currency: string;
  total_minor: number;
  priority: string;
  ship_by: string | null;
  placed_at: string;
  exception_code: string | null;
  cancelled_reason: string | null;
  created_at: string;
  updated_at: string;
  provider: string;
  connection_name: string;
  mode: string;
  units: number;
  unmapped_lines: number;
  overdue: boolean;
};

export type InventoryRow = {
  sku: string;
  location: string;
  on_hand: number;
  reserved: number;
  damaged: number;
  inbound: number;
  safety_stock: number;
  available: number;
  value_minor: number;
  name: string;
  category: string;
  cost_minor: number;
  version: number;
  updated_at: string;
};

export type Connection = {
  id: string;
  provider: string;
  name: string;
  account_ref: string;
  mode: string;
  status: string;
  config: Record<string, unknown>;
  cursor: Record<string, unknown>;
  last_sync_at: string | null;
  last_webhook_at: string | null;
  last_error: string | null;
  events_received: number;
  failed_events: number;
  orders: number;
  failed_operations: number;
  mappings: number;
  last_run_at: string | null;
  last_run_status: string | null;
  webhook_scheme?: string;
};

export type Wave = {
  id: string;
  name: string;
  status: string;
  zone: string | null;
  priority: string;
  created_at: string;
  released_at: string | null;
  completed_at: string | null;
  order_count: number;
  tasks_total: number;
  tasks_pending: number;
  order_ids: string[];
};

export type Shipment = {
  id: string;
  order_id: string;
  carrier: string;
  service: string;
  status: string;
  external_id: string;
  tracking_number: string | null;
  tracking_url: string | null;
  label_reference: string | null;
  version: number;
  booked_at: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  updated_at: string;
  order_status: string;
  ship_by: string | null;
  provider: string;
  event_count: number;
};

export type ExceptionRow = {
  id: string;
  kind: string;
  severity: string;
  entity_type: string;
  entity_id: string;
  message: string;
  details: Record<string, any>;
  status: string;
  replayable: boolean;
  occurrences: number;
  attempts: number;
  created_at: string;
  updated_at: string;
  resolved_by_email: string | null;
  resolution: string | null;
  resolved_at: string | null;
};

export type Mapping = {
  id: string;
  connection_id: string;
  external_sku: string;
  external_name: string | null;
  sku: string;
  status: string;
  confidence: string;
  created_at: string;
  provider: string;
  connection_name: string;
  product_name: string | null;
};

export type PendingMapping = {
  connection_id: string;
  provider: string;
  connection_name: string;
  external_sku: string;
  external_name: string | null;
  occurrences: number;
  first_seen: string;
  orders_waiting: number;
  suggestion: string | null;
};

export type Asn = {
  id: string;
  supplier: string;
  reference: string;
  status: string;
  expected_at: string;
  received_at: string | null;
  created_at: string;
  lines: Array<{ sku: string; location: string; expected: number; received: number }>;
  units_expected: number;
  units_received: number;
};

export type StockCount = {
  id: string;
  sku: string;
  location: string;
  expected_on_hand: number;
  counted: number;
  variance: number;
  status: string;
  note: string | null;
  created_at: string;
  approved_at: string | null;
  name: string;
};

export type Kpis = {
  open_orders: number;
  orders_today: number;
  shipped_today: number;
  exception_orders: number;
  open_exceptions: number;
  dead_events: number;
  pending_events: number;
  overdue_orders: number;
  available_units: number;
  reserved_units: number;
  inventory_value_minor: number;
  pending_picks: number;
  open_waves: number;
  sequence: number;
  active_connections: number;
  total_connections: number;
  shipped_24h: number;
  by_status: Array<{ status: string; n: number }>;
  by_provider: Array<{ provider: string; orders: number; exceptions: number }>;
};

export type Snapshot = {
  sequence: number;
  server_time: string;
  environment: string;
  kpis: Kpis;
  orders: Order[];
  inventory: InventoryRow[];
  connections: Connection[];
  waves: Wave[];
  shipments: Shipment[];
  exceptions: ExceptionRow[];
  mappings: Mapping[];
  pending_mappings: PendingMapping[];
  asns: Asn[];
  stock_counts: StockCount[];
  worker: { pending: number; processing: number; dead: number; oldest_pending_seconds: number | null };
  connector_health: Array<{
    id: string;
    provider: string;
    name: string;
    mode: string;
    status: string;
    last_sync_at: string | null;
    last_webhook_at: string | null;
    last_error: string | null;
    failed_events: number;
    failed_ops: number;
    failed_runs_24h: number;
  }>;
  audit: { valid: boolean; entries: number; head: string };
  reconciliation: {
    id: string;
    kind: string;
    status: string;
    findings: number;
    details: any;
    started_at: string;
    finished_at: string | null;
    duration_ms: number | null;
  } | null;
};

export type StreamEvent = {
  seq: number;
  id: string;
  topic: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: any;
  created_at: string;
};

export type PageId =
  | 'tower'
  | 'orders'
  | 'inventory'
  | 'warehouse'
  | 'receiving'
  | 'waves'
  | 'shipping'
  | 'connectors'
  | 'mapping'
  | 'exceptions'
  | 'finance'
  | 'reconciliation'
  | 'audit'
  | 'platform';

export type Ctx = {
  data: Snapshot;
  actor: Actor;
  can: (permission: string) => boolean;
  refresh: (silent?: boolean) => Promise<Snapshot | null>;
  mutate: <T = any>(path: string, body?: unknown, options?: { method?: 'POST' | 'PATCH'; success?: string }) => Promise<T | null>;
  notify: (message: string, tone?: 'success' | 'error') => void;
  navigate: (page: PageId, params?: Record<string, any>) => void;
  params: Record<string, any>;
  events: StreamEvent[];
  connected: boolean;
};
