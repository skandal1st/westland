ALTER TABLE "SyncRun" ADD COLUMN "queued" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "IntegrationJob" ADD COLUMN "syncRunId" TEXT, ADD COLUMN "dependsOnId" TEXT;
ALTER TABLE "IntegrationJob" ADD CONSTRAINT "IntegrationJob_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "SyncRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationJob" ADD CONSTRAINT "IntegrationJob_dependsOnId_fkey" FOREIGN KEY ("dependsOnId") REFERENCES "IntegrationJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "IntegrationJob_syncRunId_idx" ON "IntegrationJob"("syncRunId");
CREATE INDEX "IntegrationJob_dependsOnId_idx" ON "IntegrationJob"("dependsOnId");
CREATE TABLE "IntegrationWorker" (
  "id" TEXT NOT NULL PRIMARY KEY, "storeId" TEXT NOT NULL UNIQUE,
  "leaseToken" TEXT, "leaseExpiresAt" TIMESTAMP(3), "lastStartedAt" TIMESTAMP(3), "lastFinishedAt" TIMESTAMP(3), "lastError" TEXT,
  CONSTRAINT "IntegrationWorker_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
