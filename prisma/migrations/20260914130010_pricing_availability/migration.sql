-- DropForeignKey
ALTER TABLE "ProductPrice" DROP CONSTRAINT "ProductPrice_priceGroupId_fkey";

-- DropForeignKey
ALTER TABLE "ProductPrice" DROP CONSTRAINT "ProductPrice_productId_fkey";

-- DropForeignKey
ALTER TABLE "Stock" DROP CONSTRAINT "Stock_productId_fkey";

-- DropIndex
DROP INDEX "Stock_productId_locationId_key";

-- AlterTable
ALTER TABLE "FulfillmentChannel" ADD COLUMN     "invoiceProfile" JSONB,
ADD COLUMN     "priceBookId" TEXT,
ADD COLUMN     "sellerLegalEntity" JSONB;

-- AlterTable
ALTER TABLE "PriceGroup" ADD COLUMN     "priceBookId" TEXT;

-- AlterTable
ALTER TABLE "Stock" DROP COLUMN "productId",
ADD COLUMN     "sourceUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "variantId" TEXT NOT NULL;

-- DropTable
DROP TABLE "ProductPrice";

-- CreateTable
CREATE TABLE "PriceBook" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceBook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceEntry" (
    "id" TEXT NOT NULL,
    "priceBookId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerPriceAssignment" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "priceGroupId" TEXT NOT NULL,
    "assignedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuyerPriceAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvailabilityProjection" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "fulfillmentChannelId" TEXT NOT NULL,
    "availableQuantity" DECIMAL(18,3) NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AvailabilityProjection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PriceBook_storeId_code_key" ON "PriceBook"("storeId", "code");

-- CreateIndex
CREATE INDEX "PriceEntry_variantId_idx" ON "PriceEntry"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceEntry_priceBookId_variantId_key" ON "PriceEntry"("priceBookId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "BuyerPriceAssignment_customerId_key" ON "BuyerPriceAssignment"("customerId");

-- CreateIndex
CREATE INDEX "BuyerPriceAssignment_storeId_idx" ON "BuyerPriceAssignment"("storeId");

-- CreateIndex
CREATE INDEX "BuyerPriceAssignment_priceGroupId_idx" ON "BuyerPriceAssignment"("priceGroupId");

-- CreateIndex
CREATE INDEX "AvailabilityProjection_fulfillmentChannelId_idx" ON "AvailabilityProjection"("fulfillmentChannelId");

-- CreateIndex
CREATE UNIQUE INDEX "AvailabilityProjection_variantId_fulfillmentChannelId_key" ON "AvailabilityProjection"("variantId", "fulfillmentChannelId");

-- CreateIndex
CREATE INDEX "FulfillmentChannel_priceBookId_idx" ON "FulfillmentChannel"("priceBookId");

-- CreateIndex
CREATE INDEX "PriceGroup_priceBookId_idx" ON "PriceGroup"("priceBookId");

-- CreateIndex
CREATE UNIQUE INDEX "Stock_variantId_locationId_key" ON "Stock"("variantId", "locationId");

-- AddForeignKey
ALTER TABLE "PriceGroup" ADD CONSTRAINT "PriceGroup_priceBookId_fkey" FOREIGN KEY ("priceBookId") REFERENCES "PriceBook"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceBook" ADD CONSTRAINT "PriceBook_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceEntry" ADD CONSTRAINT "PriceEntry_priceBookId_fkey" FOREIGN KEY ("priceBookId") REFERENCES "PriceBook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceEntry" ADD CONSTRAINT "PriceEntry_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerPriceAssignment" ADD CONSTRAINT "BuyerPriceAssignment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerPriceAssignment" ADD CONSTRAINT "BuyerPriceAssignment_priceGroupId_fkey" FOREIGN KEY ("priceGroupId") REFERENCES "PriceGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentChannel" ADD CONSTRAINT "FulfillmentChannel_priceBookId_fkey" FOREIGN KEY ("priceBookId") REFERENCES "PriceBook"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stock" ADD CONSTRAINT "Stock_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilityProjection" ADD CONSTRAINT "AvailabilityProjection_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilityProjection" ADD CONSTRAINT "AvailabilityProjection_fulfillmentChannelId_fkey" FOREIGN KEY ("fulfillmentChannelId") REFERENCES "FulfillmentChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

