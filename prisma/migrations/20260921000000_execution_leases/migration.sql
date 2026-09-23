-- Deploy with old writers stopped. Legacy in-flight rows (NULL lease) are recovered by the new runner.
ALTER TABLE "IntegrationJob" ADD COLUMN "leaseToken" TEXT, ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);
ALTER TABLE "OrderExport" ADD COLUMN "leaseToken" TEXT, ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);
ALTER TABLE "SyncRun" ADD COLUMN "leaseToken" TEXT, ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);
CREATE INDEX "IntegrationJob_status_leaseExpiresAt_idx" ON "IntegrationJob"("status", "leaseExpiresAt");
CREATE INDEX "OrderExport_status_leaseExpiresAt_idx" ON "OrderExport"("status", "leaseExpiresAt");
CREATE INDEX "SyncRun_status_leaseExpiresAt_idx" ON "SyncRun"("status", "leaseExpiresAt");
