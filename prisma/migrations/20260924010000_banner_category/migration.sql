ALTER TABLE "SiteBanner" ADD COLUMN "categoryId" TEXT;
CREATE INDEX "SiteBanner_categoryId_idx" ON "SiteBanner"("categoryId");
ALTER TABLE "SiteBanner" ADD CONSTRAINT "SiteBanner_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
