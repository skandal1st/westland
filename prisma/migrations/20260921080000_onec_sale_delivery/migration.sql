ALTER TYPE "OrderExportStatus" ADD VALUE 'AWAITING_ACK';
ALTER TYPE "OrderExportStatus" ADD VALUE 'DELIVERED';

CREATE TABLE "OnecSaleDelivery" (
  "id" TEXT PRIMARY KEY, "exportId" TEXT NOT NULL UNIQUE,
  "connectionId" TEXT NOT NULL, "xml" TEXT NOT NULL, "sha256" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("exportId") REFERENCES "OrderExport"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "OnecSaleDelivery_connectionId_receivedAt_idx" ON "OnecSaleDelivery"("connectionId", "receivedAt");
CREATE TABLE "OnecSaleBatch" (
  "id" TEXT PRIMARY KEY, "sessionId" TEXT NOT NULL UNIQUE, "xml" TEXT NOT NULL, "sha256" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("sessionId") REFERENCES "OnecExchangeSession"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "OnecSaleBatchItem" (
  "batchId" TEXT NOT NULL, "deliveryId" TEXT NOT NULL,
  PRIMARY KEY ("batchId", "deliveryId"),
  FOREIGN KEY ("batchId") REFERENCES "OnecSaleBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("deliveryId") REFERENCES "OnecSaleDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "OnecSaleBatchItem_deliveryId_idx" ON "OnecSaleBatchItem"("deliveryId");
CREATE FUNCTION immutable_onec_sale_payload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."xml" IS DISTINCT FROM OLD."xml" OR NEW."sha256" IS DISTINCT FROM OLD."sha256"
    OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'onec_sale_payload_immutable';
  END IF;
  IF TG_TABLE_NAME = 'OnecSaleDelivery' THEN
    IF NEW."exportId" IS DISTINCT FROM OLD."exportId" OR NEW."connectionId" IS DISTINCT FROM OLD."connectionId" THEN
      RAISE EXCEPTION 'onec_sale_identity_immutable';
    END IF;
  ELSE
    IF NEW."sessionId" IS DISTINCT FROM OLD."sessionId" THEN RAISE EXCEPTION 'onec_sale_identity_immutable'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_onec_sale_delivery BEFORE UPDATE ON "OnecSaleDelivery" FOR EACH ROW EXECUTE FUNCTION immutable_onec_sale_payload();
CREATE TRIGGER immutable_onec_sale_batch BEFORE UPDATE ON "OnecSaleBatch" FOR EACH ROW EXECUTE FUNCTION immutable_onec_sale_payload();
