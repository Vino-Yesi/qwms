-- ---------------------------------------------------------------------------
-- 005 · Reservation immutability
--
-- A reservation is evidence that stock was promised to a customer. It may be
-- consumed or released, but it must never be deleted or silently re-pointed at
-- a different line, SKU or bin. Enforcement belongs in the database.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reservations_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reservations are append-only: release instead of deleting'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.sku IS DISTINCT FROM OLD.sku
     OR NEW.location IS DISTINCT FROM OLD.location
     OR NEW.order_line_id IS DISTINCT FROM OLD.order_line_id THEN
    RAISE EXCEPTION 'reservation identity and quantity are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NOT (OLD.status = 'ACTIVE' AND NEW.status IN ('CONSUMED','RELEASED')) THEN
    RAISE EXCEPTION 'illegal reservation transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.closed_at := coalesce(NEW.closed_at, now());
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reservations_guard ON reservations;
CREATE TRIGGER reservations_guard
  BEFORE UPDATE OR DELETE ON reservations
  FOR EACH ROW EXECUTE FUNCTION reservations_guard();
