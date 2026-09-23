ALTER TABLE "EnterpriseDataRecord" DROP CONSTRAINT "EnterpriseDataRecord_kind_check";
ALTER TABLE "EnterpriseDataRecord" ADD CONSTRAINT "EnterpriseDataRecord_kind_check" CHECK ("kind" IN ('product','counterparty','productGroup','counterpartyGroup','partner'));
CREATE TABLE "PartnerDirectoryImport" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "connectionId" TEXT NOT NULL REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "batchId" TEXT NOT NULL, "sha256" TEXT NOT NULL, "objectCount" INTEGER NOT NULL,
 "exportedAt" TIMESTAMP(3) NOT NULL, "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "PartnerDirectoryImport_connectionId_batchId_key" ON "PartnerDirectoryImport"("connectionId", "batchId");
