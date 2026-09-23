CREATE TABLE "GiftPromotion" (
  "id" TEXT NOT NULL, "storeId" TEXT NOT NULL, "name" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT false, "startsAt" TIMESTAMP(3), "endsAt" TIMESTAMP(3),
  "rule" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GiftPromotion_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "GiftPromotion_storeId_isActive_idx" ON "GiftPromotion"("storeId", "isActive");
ALTER TABLE "GiftPromotion" ADD CONSTRAINT "GiftPromotion_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Cart" ADD COLUMN "giftSelections" JSONB;
ALTER TABLE "OrderItem" ADD COLUMN "giftPromotionId" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "giftPromotionName" TEXT;
