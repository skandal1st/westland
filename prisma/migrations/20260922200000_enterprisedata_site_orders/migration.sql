CREATE TABLE "EnterpriseDataSequence" (
 "connectionId" TEXT PRIMARY KEY REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "namespace" TEXT NOT NULL, "prefix" TEXT NOT NULL, "value" INTEGER NOT NULL DEFAULT 0,
 CONSTRAINT "EnterpriseDataSequence_value_check" CHECK ("value" >= 0 AND "value" <= 999999999)
);
CREATE TABLE "EnterpriseDataDelivery" (
 "id" TEXT PRIMARY KEY, "exportId" TEXT NOT NULL UNIQUE REFERENCES "OrderExport"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "connectionId" TEXT NOT NULL REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "documentId" TEXT NOT NULL, "number" TEXT NOT NULL, "xml" TEXT NOT NULL, "sha256" TEXT NOT NULL,
 "receivedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "EnterpriseDataDelivery_connectionId_documentId_key" ON "EnterpriseDataDelivery"("connectionId", "documentId");
CREATE UNIQUE INDEX "EnterpriseDataDelivery_connectionId_number_key" ON "EnterpriseDataDelivery"("connectionId", "number");
CREATE INDEX "EnterpriseDataDelivery_connectionId_receivedAt_idx" ON "EnterpriseDataDelivery"("connectionId", "receivedAt");
