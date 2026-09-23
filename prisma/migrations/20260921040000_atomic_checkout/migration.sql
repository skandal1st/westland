ALTER TABLE "Cart" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN "checkoutCartId" TEXT, ADD COLUMN "checkoutCartVersion" INTEGER, ADD COLUMN "checkoutIntent" TEXT;
CREATE UNIQUE INDEX "Order_checkoutCartId_checkoutCartVersion_key" ON "Order"("checkoutCartId", "checkoutCartVersion");
CREATE TABLE "CheckoutReceipt" ("key" TEXT PRIMARY KEY, "orderId" TEXT NOT NULL REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE INDEX "CheckoutReceipt_orderId_idx" ON "CheckoutReceipt"("orderId");
CREATE TABLE "OrderNumberCounter" ("storeId" TEXT PRIMARY KEY REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE, "value" BIGINT NOT NULL DEFAULT 0);
-- Preserve the largest historical suffix across prefixes; deletions never decrement the counter.
INSERT INTO "OrderNumberCounter" ("storeId", "value")
SELECT s.id, COALESCE(MAX(substring(o.number from '-([0-9]+)$')::bigint), 0)
FROM "Store" s LEFT JOIN "Order" o ON o."storeId" = s.id GROUP BY s.id;
