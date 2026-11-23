-- ============================================================================
-- YESI Fulfillment OS · 002 catalog, locations, inventory ledger, counts
-- ============================================================================

CREATE TABLE products (
  sku        text PRIMARY KEY,
  name       text NOT NULL,
  category   text NOT NULL DEFAULT 'General',
  barcode    text UNIQUE,
  cost_minor bigint NOT NULL CHECK (cost_minor >= 0),
  weight_g   int NOT NULL DEFAULT 0 CHECK (weight_g >= 0),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE locations (
  code      text PRIMARY KEY,
  zone      text NOT NULL,
  kind      text NOT NULL DEFAULT 'RACK' CHECK (kind IN ('RACK','BULK','DOCK','STAGING','QUARANTINE')),
  capacity  int NOT NULL DEFAULT 10000 CHECK (capacity > 0)
);

-- Marketplace identifier -> internal SKU. Approval is explicit and audited;
-- connectors can never invent a mapping on their own.
CREATE TABLE sku_mappings (
  id            uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  external_sku  text NOT NULL,
  external_name text,
  sku           text NOT NULL REFERENCES products(sku),
  status        text NOT NULL DEFAULT 'APPROVED' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  confidence    numeric(4,3) NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  approved_by   uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_sku)
);
CREATE INDEX sku_mappings_sku ON sku_mappings(sku);

-- Physical inventory. `on_hand` counts everything physically in the bin,
-- `reserved` is promised to orders, `damaged` is unsellable, `inbound` is
-- expected from an ASN. available = on_hand - reserved - damaged.
CREATE TABLE inventory (
  sku          text NOT NULL REFERENCES products(sku),
  location     text NOT NULL REFERENCES locations(code),
  on_hand      bigint NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved     bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  damaged      bigint NOT NULL DEFAULT 0 CHECK (damaged >= 0),
  inbound      bigint NOT NULL DEFAULT 0 CHECK (inbound >= 0),
  safety_stock bigint NOT NULL DEFAULT 0 CHECK (safety_stock >= 0),
  version      bigint NOT NULL DEFAULT 1,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sku, location),
  CONSTRAINT reserved_within_on_hand CHECK (reserved + damaged <= on_hand)
);
CREATE INDEX inventory_available ON inventory(sku, location) WHERE on_hand > reserved;

-- Append-only double-entry style stock ledger. Every delta carries the balance
-- after the move, so reconciliation never needs to re-derive history.
CREATE TABLE stock_ledger (
  id               bigserial PRIMARY KEY,
  sku              text NOT NULL,
  location         text NOT NULL,
  delta_on_hand    bigint NOT NULL,
  delta_reserved   bigint NOT NULL,
  delta_damaged    bigint NOT NULL DEFAULT 0,
  reason           text NOT NULL,
  reference        text NOT NULL,
  actor_id         text NOT NULL,
  request_key      text NOT NULL UNIQUE,
  balance_on_hand  bigint NOT NULL,
  balance_reserved bigint NOT NULL,
  balance_damaged  bigint NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_ledger_position ON stock_ledger(sku, location, id DESC);
CREATE TRIGGER stock_ledger_immutable BEFORE UPDATE OR DELETE ON stock_ledger
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER stock_ledger_no_truncate BEFORE TRUNCATE ON stock_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();

-- Cycle count / variance workflow. Counts never adjust stock directly: a
-- supervisor approval creates the ledger move.
CREATE TABLE stock_counts (
  id              uuid PRIMARY KEY,
  sku             text NOT NULL,
  location        text NOT NULL,
  expected_on_hand bigint NOT NULL,
  counted         bigint NOT NULL CHECK (counted >= 0),
  variance        bigint NOT NULL,
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','APPROVED','REJECTED')),
  counted_by      uuid NOT NULL REFERENCES users(id),
  approved_by     uuid REFERENCES users(id),
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  approved_at     timestamptz
);
CREATE INDEX stock_counts_open ON stock_counts(status, created_at DESC);

-- Placement guard: inventory may only change through a ledger move. The trigger
-- blocks direct updates that do not increment `version`, which is how the
-- service layer proves every mutation is ledger-backed in the same transaction.
CREATE FUNCTION inventory_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'INVENTORY_VERSION: mutation must increment version';
  END IF;
  IF NEW.reserved + NEW.damaged > NEW.on_hand THEN
    RAISE EXCEPTION 'INVENTORY_CONSTRAINT: reserved+damaged exceeds on_hand';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_guard BEFORE UPDATE ON inventory
  FOR EACH ROW EXECUTE FUNCTION inventory_version_guard();
