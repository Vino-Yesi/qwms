-- ============================================================================
-- YESI Fulfillment OS · 001 identity, connector registry, outbox, audit
-- Every table is deliberately explicit: no ORM, no hidden magic. The database
-- is the last line of defence for integrity, not just a bucket of rows.
-- ============================================================================

-- ---------------------------------------------------------------- identity --
CREATE TABLE users (
  id              uuid PRIMARY KEY,
  email           text UNIQUE NOT NULL,
  name            text NOT NULL,
  role            text NOT NULL CHECK (role IN ('admin','supervisor','warehouse','finance','integration','viewer')),
  password_hash   text,
  totp_ciphertext text,
  mfa_enabled     boolean NOT NULL DEFAULT false,
  is_demo         boolean NOT NULL DEFAULT false,
  last_totp_step  bigint,
  failed_logins   int NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash   text PRIMARY KEY,
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  csrf         text NOT NULL,
  mfa_pending  boolean NOT NULL DEFAULT true,
  ip           text,
  user_agent   text,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE auth_requests (
  state_hash text PRIMARY KEY,
  verifier   text NOT NULL,
  nonce      text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE ws_tickets (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

-- -------------------------------------------------------------- audit trail --
-- Append-only, hash chained. UPDATE/DELETE/TRUNCATE are blocked by trigger and
-- by privilege revocation. `entry_hash` covers the canonical JSON payload plus
-- the previous hash, so any silent rewrite is detectable end to end.
CREATE TABLE audit_logs (
  seq           bigserial PRIMARY KEY,
  id            uuid NOT NULL,
  actor_id      text NOT NULL,
  actor_type    text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','system','connector')),
  actor_ip      text,
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text NOT NULL,
  before_data   jsonb,
  after_data    jsonb,
  request_id    text NOT NULL,
  previous_hash text NOT NULL,
  entry_hash    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity ON audit_logs(entity_type, entity_id, seq);
CREATE INDEX audit_action ON audit_logs(action, created_at);

CREATE FUNCTION prevent_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY_VIOLATION: % denied on %', TG_OP, TG_TABLE_NAME;
END $$;

CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();

-- ------------------------------------------------------- idempotent commands --
-- A command key is bound to a canonical request hash. Re-use with the same
-- body returns the stored response; re-use with a different body is a 409.
CREATE TABLE idempotency_keys (
  scope        text NOT NULL,
  key          text NOT NULL,
  request_hash text NOT NULL,
  response     jsonb,
  status_code  int,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (scope, key)
);

-- -------------------------------------------------------- connector registry --
CREATE TABLE connections (
  id                         uuid PRIMARY KEY,
  provider                   text NOT NULL CHECK (provider IN ('ozon','yandex','wildberries')),
  name                       text NOT NULL,
  account_ref                text NOT NULL,
  mode                       text NOT NULL DEFAULT 'sandbox' CHECK (mode IN ('sandbox','live')),
  status                     text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','paused','error')),
  credentials_ciphertext     text,
  webhook_secret_ciphertext  text NOT NULL,
  previous_secret_ciphertext text,
  previous_secret_expires_at timestamptz,
  webhook_scheme             text NOT NULL DEFAULT 'yesi-hmac-v1',
  config                     jsonb NOT NULL DEFAULT '{}',
  cursor                     jsonb NOT NULL DEFAULT '{}',
  last_sync_at               timestamptz,
  last_webhook_at            timestamptz,
  last_error                 text,
  version                    bigint NOT NULL DEFAULT 1,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, account_ref)
);

CREATE TABLE connector_runs (
  id            uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('pull','push','webhook','simulate','certify')),
  status        text NOT NULL CHECK (status IN ('RUNNING','OK','FAILED')),
  stats         jsonb NOT NULL DEFAULT '{}',
  error         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  duration_ms   int
);
CREATE INDEX connector_runs_recent ON connector_runs(connection_id, started_at DESC);

-- Every outbound call to a provider is recorded here with a stable idempotency
-- key. Retries update the same row, so operators can see what was actually
-- sent, what came back and how many attempts it took.
CREATE TABLE provider_operations (
  id              uuid PRIMARY KEY,
  connection_id   uuid REFERENCES connections(id) ON DELETE CASCADE,
  provider        text NOT NULL,
  operation       text NOT NULL,
  direction       text NOT NULL CHECK (direction IN ('IN','OUT')),
  idempotency_key text NOT NULL,
  request         jsonb,
  response        jsonb,
  http_status     int,
  status          text NOT NULL CHECK (status IN ('PENDING','OK','FAILED','SKIPPED')),
  attempts        int NOT NULL DEFAULT 0,
  latency_ms      int,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  UNIQUE (connection_id, operation, idempotency_key)
);
CREATE INDEX provider_operations_recent ON provider_operations(created_at DESC);

-- Raw marketplace payloads are stored before any interpretation. A bug in the
-- normaliser never loses the source of truth: the row can be replayed.
CREATE TABLE raw_events (
  id                 uuid PRIMARY KEY,
  connection_id      uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  provider           text NOT NULL,
  external_event_id  text NOT NULL,
  event_type         text NOT NULL DEFAULT 'order',
  payload            jsonb NOT NULL,
  payload_hash       text NOT NULL,
  headers            jsonb NOT NULL DEFAULT '{}',
  signature_verified boolean NOT NULL DEFAULT false,
  status             text NOT NULL DEFAULT 'RECEIVED'
                     CHECK (status IN ('RECEIVED','PROCESSING','PROCESSED','DUPLICATE','FAILED','IGNORED')),
  attempts           int NOT NULL DEFAULT 0,
  last_error         text,
  order_id           uuid,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  UNIQUE (connection_id, external_event_id)
);
CREATE INDEX raw_events_status ON raw_events(status, received_at);
CREATE INDEX raw_events_recent ON raw_events(connection_id, received_at DESC);

CREATE FUNCTION raw_payload_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payload IS DISTINCT FROM OLD.payload OR NEW.payload_hash <> OLD.payload_hash THEN
    RAISE EXCEPTION 'APPEND_ONLY_VIOLATION: raw payload cannot be rewritten';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER raw_immutable BEFORE UPDATE ON raw_events
  FOR EACH ROW EXECUTE FUNCTION raw_payload_immutable();

-- ------------------------------------------------------------ durable event --
-- Transactional outbox. Business effects and their events commit atomically.
CREATE TABLE outbox (
  seq             bigserial PRIMARY KEY,
  id              uuid UNIQUE NOT NULL,
  topic           text NOT NULL,
  aggregate_type  text NOT NULL,
  aggregate_id    text NOT NULL,
  payload         jsonb NOT NULL,
  headers         jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','PROCESSING','DONE','DEAD')),
  attempts        int NOT NULL DEFAULT 0,
  max_attempts    int NOT NULL DEFAULT 12,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at       timestamptz,
  locked_by       text,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz
);
CREATE INDEX outbox_claim ON outbox(next_attempt_at, seq) WHERE status IN ('PENDING','PROCESSING');
CREATE INDEX outbox_aggregate ON outbox(aggregate_type, aggregate_id, seq);
CREATE INDEX outbox_topic ON outbox(topic, seq);

-- Consumer inbox: exactly-once effects on top of at-least-once delivery.
CREATE TABLE inbox (
  consumer   text NOT NULL,
  event_id   uuid NOT NULL,
  topic      text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

-- --------------------------------------------------------------- exceptions --
-- Operators live in this table. Exceptions are deduplicated per (kind, entity)
-- while open; each occurrence increments `occurrences` instead of flooding.
CREATE TABLE exceptions (
  id           uuid PRIMARY KEY,
  kind         text NOT NULL,
  severity     text NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  entity_type  text NOT NULL,
  entity_id    text NOT NULL,
  message      text NOT NULL,
  details      jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','IGNORED')),
  replayable   boolean NOT NULL DEFAULT false,
  occurrences  int NOT NULL DEFAULT 1,
  attempts     int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  resolved_by  uuid REFERENCES users(id),
  resolved_at  timestamptz,
  resolution   text
);
CREATE UNIQUE INDEX exceptions_open_unique ON exceptions(kind, entity_id) WHERE status = 'OPEN';
CREATE INDEX exceptions_queue ON exceptions(status, severity, created_at);

-- ------------------------------------------------------------ reconciliation --
CREATE TABLE reconciliation_runs (
  id           uuid PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('inventory','finance','reservations','connectors')),
  status       text NOT NULL CHECK (status IN ('OK','DRIFT')),
  findings     int NOT NULL DEFAULT 0,
  details      jsonb NOT NULL DEFAULT '[]',
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  duration_ms  int
);

-- Runtime flags / circuit breakers (pause outbound pushes during an incident).
CREATE TABLE platform_flags (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Fan out committed events to every API instance (PostgreSQL deployments).
CREATE FUNCTION notify_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('yesi_events', NEW.seq::text);
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_notify AFTER INSERT ON outbox
  FOR EACH ROW EXECUTE FUNCTION notify_outbox();

-- Operational views used by the control tower and health checks.
CREATE VIEW v_connector_health AS
SELECT c.id, c.provider, c.name, c.mode, c.status,
       c.last_sync_at, c.last_webhook_at, c.last_error,
       (SELECT count(*) FROM raw_events r WHERE r.connection_id = c.id AND r.status = 'FAILED') AS failed_events,
       (SELECT count(*) FROM provider_operations p WHERE p.connection_id = c.id AND p.status = 'FAILED') AS failed_ops,
       (SELECT count(*) FROM connector_runs cr WHERE cr.connection_id = c.id AND cr.status = 'FAILED'
          AND cr.started_at > now() - interval '24 hours') AS failed_runs_24h
FROM connections c;

CREATE VIEW v_outbox_health AS
SELECT topic,
       count(*) FILTER (WHERE status = 'PENDING') AS pending,
       count(*) FILTER (WHERE status = 'PROCESSING') AS processing,
       count(*) FILTER (WHERE status = 'DEAD') AS dead,
       count(*) FILTER (WHERE status = 'DONE') AS done,
       max(seq) AS last_seq
FROM outbox GROUP BY topic;
