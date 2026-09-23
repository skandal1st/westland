ALTER TABLE "Invoice" ADD COLUMN "issueRequestKey" TEXT;
CREATE UNIQUE INDEX "Invoice_orderId_issueRequestKey_key" ON "Invoice"("orderId", "issueRequestKey");
