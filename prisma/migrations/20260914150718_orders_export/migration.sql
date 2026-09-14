-- CreateEnum
CREATE TYPE "OrderExportStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'RETRYING');

-- CreateTable
CREATE TABLE "OrderExport" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "connectionId" TEXT,
    "status" "OrderExportStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "externalId" TEXT,
    "lastError" TEXT,
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderExport_orderId_key" ON "OrderExport"("orderId");

-- CreateIndex
CREATE INDEX "OrderExport_status_availableAt_idx" ON "OrderExport"("status", "availableAt");

-- CreateIndex
CREATE INDEX "OrderExport_storeId_status_idx" ON "OrderExport"("storeId", "status");

-- AddForeignKey
ALTER TABLE "OrderExport" ADD CONSTRAINT "OrderExport_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

