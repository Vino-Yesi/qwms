CREATE TABLE users (
 id uuid PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL,
 role text NOT NULL CHECK(role IN ('admin','supervisor','warehouse','finance','integration','viewer')),
 password_hash text, totp_ciphertext text, mfa_enabled boolean NOT NULL DEFAULT false,
 is_demo boolean NOT NULL DEFAULT false, last_totp_step bigint, active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
 token_hash text PRIMARY KEY, user_id uuid REFERENCES users(id), csrf text NOT NULL,
 expires_at timestamptz NOT NULL, mfa_pending boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth_requests (
 state_hash text PRIMARY KEY, verifier text NOT NULL, nonce text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE ws_tickets (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL
);
CREATE TABLE connections (
 id uuid PRIMARY KEY, provider text NOT NULL CHECK(provider IN ('ozon','yandex','wildberries')),
 account_id text NOT NULL, mode text NOT NULL DEFAULT 'sandbox' CHECK(mode IN ('sandbox','live')),
 enabled boolean NOT NULL DEFAULT true, webhook_ciphertext text NOT NULL,
 access_ciphertext text, last_sync_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider,account_id)
);
CREATE TABLE raw_events (
 id uuid PRIMARY KEY, connection_id uuid NOT NULL REFERENCES connections(id),
 external_event_id text NOT NULL, payload jsonb NOT NULL, payload_hash text NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(), UNIQUE(connection_id,external_event_id)
);
CREATE TABLE idempotency_keys (
 scope text NOT NULL, key text NOT NULL, request_hash text NOT NULL,
 response jsonb, status_code int, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope,key)
);
CREATE TABLE products (sku text PRIMARY KEY, name text NOT NULL, cost_minor bigint NOT NULL CHECK(cost_minor>=0));
CREATE TABLE sku_mappings (
 id uuid PRIMARY KEY, connection_id uuid NOT NULL REFERENCES connections(id),
 external_sku text NOT NULL, sku text NOT NULL REFERENCES products(sku),
 approved_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(connection_id,external_sku)
);
CREATE TABLE inventory (
 sku text NOT NULL REFERENCES products(sku), location text NOT NULL,
 on_hand bigint NOT NULL CHECK(on_hand>=0), reserved bigint NOT NULL CHECK(reserved>=0),
 version bigint NOT NULL DEFAULT 1, CHECK(reserved<=on_hand), PRIMARY KEY(sku,location)
);
CREATE TABLE stock_ledger (
 id bigserial PRIMARY KEY, sku text NOT NULL, location text NOT NULL,
 delta_on_hand bigint NOT NULL, delta_reserved bigint NOT NULL,
 reason text NOT NULL, reference text NOT NULL, actor_id text NOT NULL,
 request_key text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE orders (
 id uuid PRIMARY KEY, connection_id uuid NOT NULL REFERENCES connections(id),
 external_id text NOT NULL, status text NOT NULL CHECK(status IN ('RECEIVED','EXCEPTION','MAPPED','RESERVED','PICKING','PACKED','READY_TO_SHIP','SHIPPED','DELIVERED','CANCELLED')),
 version bigint NOT NULL DEFAULT 1, customer_ref text NOT NULL, currency text NOT NULL DEFAULT 'RUB',
 total_minor bigint NOT NULL CHECK(total_minor>=0), ship_by timestamptz NOT NULL,
 raw_event_id uuid NOT NULL REFERENCES raw_events(id), source_hash text NOT NULL, exception_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(connection_id,external_id)
);
CREATE TABLE order_lines (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id),
 external_sku text NOT NULL, sku text REFERENCES products(sku),
 quantity int NOT NULL CHECK(quantity>0), unit_price_minor bigint NOT NULL CHECK(unit_price_minor>=0),
 UNIQUE(order_id,external_sku)
);
CREATE TABLE reservations (
 order_line_id uuid NOT NULL REFERENCES order_lines(id), sku text NOT NULL, location text NOT NULL,
 quantity int NOT NULL CHECK(quantity>0), PRIMARY KEY(order_line_id,location),
 FOREIGN KEY(sku,location) REFERENCES inventory(sku,location)
);
CREATE TABLE asns (
 id uuid PRIMARY KEY, supplier text NOT NULL, status text NOT NULL DEFAULT 'EXPECTED' CHECK(status IN ('EXPECTED','RECEIVED')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE asn_lines (
 asn_id uuid NOT NULL REFERENCES asns(id), sku text NOT NULL REFERENCES products(sku),
 location text NOT NULL, expected int NOT NULL CHECK(expected>0), received int NOT NULL DEFAULT 0,
 CHECK(received>=0 AND received<=expected), PRIMARY KEY(asn_id,sku,location)
);
CREATE TABLE waves (
 id uuid PRIMARY KEY, name text NOT NULL, status text NOT NULL CHECK(status IN ('RELEASED','PICKING','COMPLETE')),
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE wave_orders (wave_id uuid NOT NULL REFERENCES waves(id), order_id uuid UNIQUE NOT NULL REFERENCES orders(id), PRIMARY KEY(wave_id,order_id));
CREATE TABLE shipments (
 id uuid PRIMARY KEY, order_id uuid UNIQUE NOT NULL REFERENCES orders(id),
 carrier text NOT NULL, status text NOT NULL CHECK(status IN ('CREATED','BOOKED','DISPATCHED','IN_TRANSIT','DELIVERED','EXCEPTION')),
 external_id text, tracking_number text, version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE journal_entries (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id), kind text NOT NULL,
 currency text NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>0),
 debit_account text NOT NULL, credit_account text NOT NULL, posted_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(order_id,kind)
);
CREATE TABLE exceptions (
 id uuid PRIMARY KEY, kind text NOT NULL, entity_id text NOT NULL, message text NOT NULL,
 status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RESOLVED')),
 details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
CREATE TABLE outbox (
 seq bigserial PRIMARY KEY, id uuid UNIQUE NOT NULL, topic text NOT NULL,
 payload jsonb NOT NULL, status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','DONE','DEAD')),
 attempts int NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 locked_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz
);
CREATE INDEX outbox_claim ON outbox(status,next_attempt_at,seq);
CREATE INDEX orders_status ON orders(status,ship_by);
CREATE INDEX exceptions_open ON exceptions(status,created_at);
CREATE INDEX ledger_sku ON stock_ledger(sku,location,id);
CREATE TABLE audit_logs (
 seq bigserial PRIMARY KEY, id uuid NOT NULL, actor_id text NOT NULL, action text NOT NULL,
 entity_type text NOT NULL, entity_id text NOT NULL, before_data jsonb, after_data jsonb,
 request_id text NOT NULL, previous_hash text NOT NULL, entry_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION prevent_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Append-only record: % denied', TG_OP; END; $$;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON stock_ledger FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER raw_immutable BEFORE UPDATE OR DELETE ON raw_events FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER journal_immutable BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
REVOKE UPDATE,DELETE,TRUNCATE ON audit_logs,stock_ledger,journal_entries,raw_events FROM PUBLIC;

CREATE FUNCTION notify_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_notify('yesi_events',NEW.seq::text); RETURN NEW; END; $$;
CREATE TRIGGER outbox_notify AFTER INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION notify_outbox();
