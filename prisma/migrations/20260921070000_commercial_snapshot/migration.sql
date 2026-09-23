ALTER TABLE "Order" ADD COLUMN "commercialSnapshot" JSONB;

-- No backfill: live directories cannot establish the historical terms of legacy orders.
CREATE FUNCTION protect_order_commercial_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."commercialSnapshot" IS NOT NULL AND NEW."commercialSnapshot" IS DISTINCT FROM OLD."commercialSnapshot" THEN
    RAISE EXCEPTION 'order_commercial_snapshot_immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."commercialSnapshot" IS NULL AND NEW."commercialSnapshot" IS NOT NULL
     AND (OLD.status <> 'DRAFT' OR NEW.status <> 'SUBMITTED') THEN
    RAISE EXCEPTION 'order_commercial_snapshot_requires_submit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER order_commercial_snapshot_guard
BEFORE UPDATE OF "commercialSnapshot" ON "Order"
FOR EACH ROW EXECUTE FUNCTION protect_order_commercial_snapshot();
