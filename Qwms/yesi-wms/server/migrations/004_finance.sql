-- ============================================================================
-- YESI Fulfillment OS · 004 double-entry finance and ERP posting
-- ============================================================================

-- A minimal but real chart of accounts. Revenue is recognised at dispatch,
-- inventory is relieved at cost, and the receivable lands in ERP.
CREATE TABLE gl_accounts (
  code text PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE'))
);
INSERT INTO gl_accounts (code, name, type) VALUES
  ('1100','Accounts Receivable','ASSET'),
  ('1200','Inventory','ASSET'),
  ('2100','Marketplace Payable','LIABILITY'),
  ('4000','Product Revenue','REVENUE'),
  ('4100','Shipping Revenue','REVENUE'),
  ('5000','Cost of Goods Sold','EXPENSE'),
  ('5100','Carrier Cost','EXPENSE'),
  ('5200','Marketplace Commission','EXPENSE');

CREATE TABLE journal_entries (
  id            uuid PRIMARY KEY,
  order_id      uuid NOT NULL REFERENCES orders(id),
  shipment_id   uuid REFERENCES shipments(id),
  kind          text NOT NULL CHECK (kind IN ('SALE','COGS','SHIPPING','REFUND','REVERSAL')),
  currency      text NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  status        text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED','FAILED','REVERSED')),
  posting_key   text NOT NULL UNIQUE,
  erp_reference text,
  posted_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, kind)
);
CREATE INDEX journal_entries_status ON journal_entries(status, created_at);

CREATE TABLE journal_lines (
  id          uuid PRIMARY KEY,
  entry_id    uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account     text NOT NULL REFERENCES gl_accounts(code),
  debit_minor bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  memo        text,
  CHECK (NOT (debit_minor > 0 AND credit_minor > 0))
);
CREATE INDEX journal_lines_entry ON journal_lines(entry_id);
CREATE TRIGGER journal_lines_immutable BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- Double-entry invariant, checked at commit. You cannot post a one-sided
-- journal even if every application check is bypassed.
CREATE FUNCTION assert_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target uuid := COALESCE(NEW.entry_id, OLD.entry_id);
  debits bigint;
  credits bigint;
BEGIN
  SELECT COALESCE(sum(debit_minor),0), COALESCE(sum(credit_minor),0)
    INTO debits, credits FROM journal_lines WHERE entry_id = target;
  IF debits <> credits THEN
    RAISE EXCEPTION 'JOURNAL_UNBALANCED: debits % <> credits %', debits, credits
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

CREATE TABLE erp_postings (
  id              uuid PRIMARY KEY,
  order_id        uuid NOT NULL REFERENCES orders(id),
  idempotency_key text NOT NULL UNIQUE,
  amount_minor    bigint NOT NULL,
  currency        text NOT NULL DEFAULT 'RUB',
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACK','FAILED')),
  request         jsonb NOT NULL,
  response        jsonb,
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  acked_at        timestamptz
);
CREATE INDEX erp_postings_status ON erp_postings(status, created_at);
