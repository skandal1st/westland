ALTER TABLE "GiftPromotion" ADD COLUMN "showOnHome" BOOLEAN;
ALTER TABLE "GiftPromotion" ADD COLUMN "homeImageUrl" TEXT;
ALTER TABLE "GiftPromotion" ADD COLUMN "homeDescription" TEXT;

CREATE INDEX "GiftPromotion_storeId_showOnHome_isActive_idx"
  ON "GiftPromotion"("storeId", "showOnHome", "isActive");
