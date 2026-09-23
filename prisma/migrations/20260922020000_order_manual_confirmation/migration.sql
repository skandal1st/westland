CREATE TABLE "OrderManualConfirmation" (
 "id" TEXT NOT NULL PRIMARY KEY, "orderId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
 "connectionId" TEXT NOT NULL, "documentNumber" TEXT NOT NULL, "documentDate" DATE NOT NULL,
 "termsHash" TEXT NOT NULL, "total" DECIMAL(18,2) NOT NULL, "vatAmount" DECIMAL(18,2) NOT NULL,
 "actorId" TEXT NOT NULL, "actorEmail" TEXT NOT NULL, "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "revokedAt" TIMESTAMP(3),
 CONSTRAINT "OrderManualConfirmation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OrderManualConfirmation_orderId_key" ON "OrderManualConfirmation"("orderId");
CREATE UNIQUE INDEX "OrderManualConfirmation_connectionId_documentNumber_documentDate_key" ON "OrderManualConfirmation"("connectionId", "documentNumber", "documentDate");
CREATE INDEX "OrderManualConfirmation_storeId_confirmedAt_idx" ON "OrderManualConfirmation"("storeId", "confirmedAt");
CREATE FUNCTION protect_order_manual_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW) - 'revokedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'revokedAt') OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt") THEN
  RAISE EXCEPTION 'manual_confirmation_immutable';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER order_manual_confirmation_immutable BEFORE UPDATE ON "OrderManualConfirmation" FOR EACH ROW EXECUTE FUNCTION protect_order_manual_confirmation();
