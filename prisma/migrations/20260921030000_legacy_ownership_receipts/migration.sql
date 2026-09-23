CREATE TABLE "LegacyOwnershipBatch" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "digest" TEXT NOT NULL,
  "plan" JSONB NOT NULL,
  "afterHash" TEXT NOT NULL,
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rolledBackAt" TIMESTAMP(3),
  CONSTRAINT "LegacyOwnershipBatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LegacyOwnershipBatch_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LegacyOwnershipBatch_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "LegacyOwnershipBatch_digest_key" ON "LegacyOwnershipBatch"("digest");
CREATE INDEX "LegacyOwnershipBatch_storeId_connectionId_idx" ON "LegacyOwnershipBatch"("storeId", "connectionId");
