-- DropIndex
DROP INDEX "Product_storeId_sku_key";

-- DropIndex
DROP INDEX "Product_storeId_slug_key";

-- AlterTable
ALTER TABLE "Product" DROP COLUMN "contentData",
DROP COLUMN "description",
DROP COLUMN "imageUrls",
DROP COLUMN "importedData",
DROP COLUMN "name",
DROP COLUMN "packaging",
DROP COLUMN "sku",
DROP COLUMN "slug",
DROP COLUMN "unitsPerPack",
ADD COLUMN     "canonicalName" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "packaging" TEXT NOT NULL DEFAULT '',
    "unitsPerPack" INTEGER NOT NULL DEFAULT 1,
    "isDefault" BOOLEAN NOT NULL DEFAULT true,
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductIdentifier" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceProductContent" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "imageUrls" TEXT[],
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "attributes" JSONB,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommerceProductContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderSnapshot" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "connectionId" TEXT,
    "entityType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "sourceFingerprint" TEXT NOT NULL,
    "providerVersion" TEXT,
    "sourceUpdatedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "normalizationVersion" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductVariant_productId_idx" ON "ProductVariant"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_storeId_sku_key" ON "ProductVariant"("storeId", "sku");

-- CreateIndex
CREATE INDEX "ProductIdentifier_type_value_idx" ON "ProductIdentifier"("type", "value");

-- CreateIndex
CREATE UNIQUE INDEX "ProductIdentifier_variantId_type_value_key" ON "ProductIdentifier"("variantId", "type", "value");

-- CreateIndex
CREATE UNIQUE INDEX "CommerceProductContent_productId_key" ON "CommerceProductContent"("productId");

-- CreateIndex
CREATE INDEX "CommerceProductContent_storeId_idx" ON "CommerceProductContent"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "CommerceProductContent_storeId_slug_key" ON "CommerceProductContent"("storeId", "slug");

-- CreateIndex
CREATE INDEX "ProviderSnapshot_storeId_entityType_externalId_idx" ON "ProviderSnapshot"("storeId", "entityType", "externalId");

-- CreateIndex
CREATE INDEX "ProviderSnapshot_entityType_externalId_sourceFingerprint_idx" ON "ProviderSnapshot"("entityType", "externalId", "sourceFingerprint");

-- CreateIndex
CREATE INDEX "Product_storeId_status_idx" ON "Product"("storeId", "status");

-- CreateIndex
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

-- CreateIndex
CREATE INDEX "Product_brandId_idx" ON "Product"("brandId");

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductIdentifier" ADD CONSTRAINT "ProductIdentifier_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceProductContent" ADD CONSTRAINT "CommerceProductContent_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

