ALTER TABLE "UserDeliveryPointGrant" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'MODERATOR';
ALTER TABLE "UserDeliveryPointGrant" ADD CONSTRAINT "UserDeliveryPointGrant_origin_check" CHECK ("origin" IN ('MODERATOR', 'SELF_CREATED'));
