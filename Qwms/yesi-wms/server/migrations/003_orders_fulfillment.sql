-- ============================================================================
-- YESI Fulfillment OS · 003 canonical orders, state machines, fulfillment
-- ============================================================================

-- The allowed transition graph lives in the database. Application code cannot
-- invent a shortcut, and the BEFORE trigger below rejects anything outside the
-- graph even if a future service forgets to check.
CREATE TABLE order_transitions_allowed (
  from_status text NOT NULL,
  to_status   text NOT NULL,
  PRIMARY KEY (from_status, to_status)
);
INSERT INTO order_transitions_allowed (from_status, to_status) VALUES
  ('RECEIVED','MAPPED'), ('RECEIVED','EXCEPTION'), ('RECEIVED','CANCELLED'),
  ('EXCEPTION','MAPPED'), ('EXCEPTION','CANCELLED'),
  ('MAPPED','RESERVED'), ('MAPPED','EXCEPTION'), ('MAPPED','CANCELLED'),
  ('RESERVED','PICKING'), ('RESERVED','MAPPED'), ('RESERVED','CANCELLED'),
  ('PICKING','PACKED'), ('PICKING','EXCEPTION'),
  ('PACKED','READY_TO_SHIP'), ('PACKED','EXCEPTION'),
  ('READY_TO_SHIP','SHIPPED'), ('READY_TO_SHIP','EXCEPTION'),
  ('SHIPPED','DELIVERED'), ('SHIPPED','EXCEPTION'),
  ('DELIVERED','RETURNED');

CREATE TABLE orders (
  id             uuid PRIMARY KEY,
  connection_id  uuid NOT NULL REFERENCES connections(id),
  external_id    text NOT NULL,
  status         text NOT NULL CHECK (status IN (
                   'RECEIVED','EXCEPTION','MAPPED','RESERVED','PICKING',
                   'PACKED','READY_TO_SHIP','SHIPPED','DELIVERED','CANCELLED','RETURNED')),
  version        bigint NOT NULL DEFAULT 1,
  customer_ref   text NOT NULL,
  currency       text NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  total_minor    bigint NOT NULL CHECK (total_minor >= 0),
  priority       text NOT NULL DEFAULT 'STANDARD' CHECK (priority IN ('STANDARD','EXPRESS','SAME_DAY')),
  ship_by        timestamptz NOT NULL,
  placed_at      timestamptz NOT NULL DEFAULT now(),
  raw_event_id   uuid NOT NULL REFERENCES raw_events(id),
  source_hash    text NOT NULL,
  exception_code text,
  cancelled_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_id)
);
CREATE INDEX orders_status_sla ON orders(status, ship_by);
CREATE INDEX orders_recent ON orders(created_at DESC);

CREATE TABLE order_lines (
  id               uuid PRIMARY KEY,
  order_id         uuid NOT NULL REFERENCES orders(id),
  external_sku     text NOT NULL,
  external_name    text,
  sku              text REFERENCES products(sku),
  quantity         int NOT NULL CHECK (quantity > 0 AND quantity <= 10000),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  UNIQUE (order_id, external_sku)
);
CREATE INDEX order_lines_sku ON order_lines(sku);

-- Immutable transition history, written by the trigger (not by application
-- code) so there is no code path that can move an order without a record.
CREATE TABLE order_transitions (
  id          bigserial PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES orders(id),
  from_status text NOT NULL,
  to_status   text NOT NULL,
  version     bigint NOT NULL,
  actor_id    text NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_transitions_order ON order_transitions(order_id, id);
CREATE TRIGGER order_transitions_immutable BEFORE UPDATE OR DELETE ON order_transitions
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE FUNCTION enforce_order_state_machine() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT EXISTS (
      SELECT 1 FROM order_transitions_allowed
      WHERE from_status = OLD.status AND to_status = NEW.status
    ) THEN
      RAISE EXCEPTION 'ILLEGAL_TRANSITION: order cannot move % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.version <= OLD.version THEN
      RAISE EXCEPTION 'VERSION_CONFLICT: status change must bump version'
        USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO order_transitions(order_id, from_status, to_status, version, actor_id, reason)
    VALUES (OLD.id, OLD.status, NEW.status, NEW.version,
            coalesce(current_setting('yesi.actor_id', true), 'system'),
            current_setting('yesi.reason', true));
    NEW.updated_at := now();
  ELSIF NEW.version <> OLD.version THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_state_machine BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION enforce_order_state_machine();

-- Order totals are the sum of lines. Enforced at commit time (deferred) so the
-- header and lines can be written in one transaction.
CREATE FUNCTION assert_order_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target uuid := COALESCE(NEW.order_id, OLD.order_id);
  expected bigint;
  actual bigint;
BEGIN
  SELECT total_minor INTO expected FROM orders WHERE id = target;
  IF expected IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(sum(quantity * unit_price_minor), 0) INTO actual FROM order_lines WHERE order_id = target;
  IF actual <> expected THEN
    RAISE EXCEPTION 'ORDER_TOTAL_MISMATCH: header % <> lines %', expected, actual
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER order_total_balanced
  AFTER INSERT OR UPDATE OR DELETE ON order_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_order_total();

-- Stock promised to an order. Rows are never deleted: they move through
-- ACTIVE -> RELEASED (cancel) or ACTIVE -> CONSUMED (shipped), keeping the
-- promise history auditable.
CREATE TABLE reservations (
  id            uuid PRIMARY KEY,
  order_line_id uuid NOT NULL REFERENCES order_lines(id),
  sku           text NOT NULL,
  location      text NOT NULL,
  quantity      int NOT NULL CHECK (quantity > 0),
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RELEASED','CONSUMED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  FOREIGN KEY (sku, location) REFERENCES inventory(sku, location)
);
CREATE UNIQUE INDEX reservations_one_active ON reservations(order_line_id, location) WHERE status = 'ACTIVE';
CREATE INDEX reservations_order ON reservations(order_line_id);

-- --------------------------------------------------------------- receiving --
CREATE TABLE asns (
  id          uuid PRIMARY KEY,
  supplier    text NOT NULL,
  reference   text,
  status      text NOT NULL DEFAULT 'EXPECTED' CHECK (status IN ('EXPECTED','IN_RECEIVING','RECEIVED','CANCELLED')),
  expected_at timestamptz,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz
);

CREATE TABLE asn_lines (
  asn_id    uuid NOT NULL REFERENCES asns(id) ON DELETE CASCADE,
  sku       text NOT NULL REFERENCES products(sku),
  location  text NOT NULL REFERENCES locations(code),
  expected  int NOT NULL CHECK (expected > 0),
  received  int NOT NULL DEFAULT 0 CHECK (received >= 0 AND received <= expected),
  PRIMARY KEY (asn_id, sku, location)
);

-- ------------------------------------------------------------------- waves --
CREATE TABLE waves (
  id           uuid PRIMARY KEY,
  name         text NOT NULL,
  status       text NOT NULL DEFAULT 'RELEASED' CHECK (status IN ('RELEASED','PICKING','COMPLETE','CANCELLED')),
  zone         text,
  priority     text NOT NULL DEFAULT 'STANDARD' CHECK (priority IN ('STANDARD','EXPRESS','SAME_DAY')),
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  released_at  timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE wave_orders (
  wave_id  uuid NOT NULL REFERENCES waves(id),
  order_id uuid UNIQUE NOT NULL REFERENCES orders(id),
  PRIMARY KEY (wave_id, order_id)
);

CREATE TABLE pick_tasks (
  id             uuid PRIMARY KEY,
  wave_id        uuid NOT NULL REFERENCES waves(id),
  order_id       uuid NOT NULL REFERENCES orders(id),
  order_line_id  uuid NOT NULL REFERENCES order_lines(id),
  sku            text NOT NULL,
  location       text NOT NULL REFERENCES locations(code),
  quantity       int NOT NULL CHECK (quantity > 0),
  picked         int NOT NULL DEFAULT 0 CHECK (picked >= 0 AND picked <= quantity),
  status         text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PICKED','SHORT')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  picked_at      timestamptz
);
CREATE INDEX pick_tasks_wave ON pick_tasks(wave_id, status);

-- --------------------------------------------------------------- shipments --
CREATE TABLE shipment_transitions_allowed (
  from_status text NOT NULL,
  to_status   text NOT NULL,
  PRIMARY KEY (from_status, to_status)
);
INSERT INTO shipment_transitions_allowed (from_status, to_status) VALUES
  ('CREATED','BOOKED'), ('CREATED','EXCEPTION'),
  ('BOOKED','DISPATCHED'), ('BOOKED','EXCEPTION'), ('BOOKED','CANCELLED'),
  ('DISPATCHED','IN_TRANSIT'), ('DISPATCHED','DELIVERED'), ('DISPATCHED','EXCEPTION'),
  ('IN_TRANSIT','DELIVERED'), ('IN_TRANSIT','EXCEPTION'),
  ('EXCEPTION','IN_TRANSIT'), ('EXCEPTION','DELIVERED');

CREATE TABLE shipments (
  id              uuid PRIMARY KEY,
  order_id        uuid UNIQUE NOT NULL REFERENCES orders(id),
  carrier         text NOT NULL,
  service         text NOT NULL DEFAULT 'STANDARD',
  status          text NOT NULL DEFAULT 'CREATED' CHECK (status IN (
                    'CREATED','BOOKED','DISPATCHED','IN_TRANSIT','DELIVERED','EXCEPTION','CANCELLED')),
  external_id     text,
  tracking_number text,
  tracking_url    text,
  label_reference text,
  version         bigint NOT NULL DEFAULT 1,
  exception_code  text,
  booked_at       timestamptz,
  dispatched_at   timestamptz,
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shipment_events (
  id          uuid PRIMARY KEY,
  shipment_id uuid NOT NULL REFERENCES shipments(id),
  status      text NOT NULL,
  source      text NOT NULL CHECK (source IN ('TMS','WMS','MANUAL')),
  message     text,
  payload     jsonb NOT NULL DEFAULT '{}',
  dedupe_key  text NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shipment_events_shipment ON shipment_events(shipment_id, id);
CREATE TRIGGER shipment_events_immutable BEFORE UPDATE OR DELETE ON shipment_events
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE FUNCTION enforce_shipment_state_machine() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT EXISTS (
      SELECT 1 FROM shipment_transitions_allowed
      WHERE from_status = OLD.status AND to_status = NEW.status
    ) THEN
      RAISE EXCEPTION 'ILLEGAL_TRANSITION: shipment cannot move % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.version <= OLD.version THEN
      RAISE EXCEPTION 'VERSION_CONFLICT: shipment status change must bump version'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shipments_state_machine BEFORE UPDATE ON shipments
  FOR EACH ROW EXECUTE FUNCTION enforce_shipment_state_machine();
