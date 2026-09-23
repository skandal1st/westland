-- Additive migration: never rename canonical SKUs or rewrite historical order snapshots.
ALTER TABLE "ProductVariant" ADD COLUMN "sourceSku" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "sourceSku" TEXT;

-- Ownership checks must be indexed independently of connectionId.
CREATE INDEX "ExternalReference_entityType_entityId_idx" ON "ExternalReference"("entityType", "entityId");

-- Backfill only unambiguous ONE_C defaults, using indexed anti-joins.
UPDATE "ProductVariant" v SET "sourceSku" = COALESCE(NULLIF(r."externalCode", ''), NULLIF(r."sourceData"->>'sku', ''))
FROM "Product" p, "ExternalReference" r, "IntegrationConnection" c
WHERE v."productId" = p.id AND v."isDefault" = true AND v."sourceSku" IS NULL
  AND r."entityType" = 'product' AND r."entityId" = p.id AND r."connectionId" = c.id
  AND c.provider = 'ONE_C' AND c."storeId" = p."storeId" AND v."storeId" = p."storeId"
  AND NOT EXISTS (SELECT 1 FROM "ExternalReference" other WHERE other."entityType" = 'product' AND other."entityId" = p.id AND other.id <> r.id)
  AND NOT EXISTS (SELECT 1 FROM "ProductVariant" other WHERE other."productId" = p.id AND other."isDefault" = true AND other.id <> v.id);
