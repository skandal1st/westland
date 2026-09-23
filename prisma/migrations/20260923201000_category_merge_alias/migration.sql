ALTER TABLE "Category" ADD COLUMN "mergedIntoId" TEXT;
CREATE INDEX "Category_mergedIntoId_idx" ON "Category" ("mergedIntoId");
