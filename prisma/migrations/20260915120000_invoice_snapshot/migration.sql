-- DropIndex
DROP INDEX "Invoice_orderId_key";

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "buyerSnapshot" JSONB,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'RUB',
ADD COLUMN     "sellerSnapshot" JSONB,
ADD COLUMN     "storeId" TEXT NOT NULL,
ADD COLUMN     "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "total" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "vatAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "vatRate" DECIMAL(6,3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "packaging" TEXT NOT NULL DEFAULT '',
    "quantity" DECIMAL(18,3) NOT NULL,
    "unitPrice" DECIMAL(18,2) NOT NULL,
    "lineTotal" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLine_invoiceId_position_key" ON "InvoiceLine"("invoiceId", "position");

-- CreateIndex
CREATE INDEX "Invoice_storeId_status_idx" ON "Invoice"("storeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_orderId_version_key" ON "Invoice"("orderId", "version");

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
