CREATE TABLE "OnecSaleInbox" (
 "id" TEXT PRIMARY KEY, "connectionId" TEXT NOT NULL, "sessionId" TEXT NOT NULL,
 "filename" TEXT NOT NULL, "sha256" TEXT NOT NULL, "xml" TEXT NOT NULL,
 "bytes" INTEGER NOT NULL, "documentCount" INTEGER NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 FOREIGN KEY ("sessionId") REFERENCES "OnecExchangeSession"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OnecSaleInbox_connectionId_sha256_key" ON "OnecSaleInbox"("connectionId", "sha256");
CREATE INDEX "OnecSaleInbox_connectionId_status_createdAt_idx" ON "OnecSaleInbox"("connectionId", "status", "createdAt");
CREATE FUNCTION immutable_onec_sale_inbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."connectionId" IS DISTINCT FROM OLD."connectionId"
 OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId" OR NEW."filename" IS DISTINCT FROM OLD."filename"
 OR NEW."sha256" IS DISTINCT FROM OLD."sha256" OR NEW."xml" IS DISTINCT FROM OLD."xml"
 OR NEW."bytes" IS DISTINCT FROM OLD."bytes" OR NEW."documentCount" IS DISTINCT FROM OLD."documentCount"
 OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN RAISE EXCEPTION 'onec_sale_inbox_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_onec_sale_inbox BEFORE UPDATE ON "OnecSaleInbox" FOR EACH ROW EXECUTE FUNCTION immutable_onec_sale_inbox();
