CREATE TABLE "EnterpriseDataRecord" (
 "id" TEXT NOT NULL PRIMARY KEY, "connectionId" TEXT NOT NULL REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "kind" TEXT NOT NULL, "externalId" TEXT NOT NULL, "name" TEXT NOT NULL, "inn" TEXT NOT NULL DEFAULT '', "kpp" TEXT NOT NULL DEFAULT '',
 "archived" BOOLEAN NOT NULL DEFAULT false, "normalized" JSONB NOT NULL, "raw" JSONB NOT NULL, "fingerprint" TEXT NOT NULL,
 "messageNo" INTEGER NOT NULL, "syncToSite" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "EnterpriseDataRecord_kind_check" CHECK ("kind" IN ('product','counterparty','productGroup','counterpartyGroup'))
);
CREATE UNIQUE INDEX "EnterpriseDataRecord_connectionId_kind_externalId_key" ON "EnterpriseDataRecord"("connectionId","kind","externalId");
CREATE INDEX "EnterpriseDataRecord_connectionId_kind_name_idx" ON "EnterpriseDataRecord"("connectionId","kind","name");
CREATE INDEX "EnterpriseDataRecord_connectionId_inn_idx" ON "EnterpriseDataRecord"("connectionId","inn");
CREATE TABLE "EnterpriseDataImport" (
 "id" TEXT NOT NULL PRIMARY KEY, "connectionId" TEXT NOT NULL REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "messageNo" INTEGER NOT NULL, "sha256" TEXT NOT NULL, "objectCount" INTEGER NOT NULL, "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "EnterpriseDataImport_connectionId_messageNo_key" ON "EnterpriseDataImport"("connectionId","messageNo");
