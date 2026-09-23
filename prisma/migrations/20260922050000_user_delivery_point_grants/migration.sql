-- Preserve existing account behaviour; normal approvals explicitly enable restricted access.
ALTER TABLE "User" ADD COLUMN "deliveryPointsRestricted" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "UserDeliveryPointGrant" (
 "userId" TEXT NOT NULL, "locationId" TEXT NOT NULL, "assignedById" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "UserDeliveryPointGrant_pkey" PRIMARY KEY ("userId", "locationId"),
 CONSTRAINT "UserDeliveryPointGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "UserDeliveryPointGrant_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "CustomerLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "UserDeliveryPointGrant_locationId_idx" ON "UserDeliveryPointGrant"("locationId");
