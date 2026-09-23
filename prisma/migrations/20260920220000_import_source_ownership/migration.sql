-- Legacy rows remain unclaimed; imports must not silently take ownership.
ALTER TABLE "PriceEntry" ADD COLUMN "sourceConnectionId" TEXT, ADD COLUMN "sourceGenerationId" TEXT, ADD COLUMN "sourceScopeKey" TEXT;
ALTER TABLE "Stock" ADD COLUMN "sourceConnectionId" TEXT, ADD COLUMN "sourceGenerationId" TEXT, ADD COLUMN "sourceScopeKey" TEXT;
CREATE INDEX "PriceEntry_sourceConnectionId_idx" ON "PriceEntry"("sourceConnectionId");
CREATE INDEX "Stock_sourceConnectionId_idx" ON "Stock"("sourceConnectionId");
