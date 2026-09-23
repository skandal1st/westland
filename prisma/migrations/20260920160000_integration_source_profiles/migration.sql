CREATE TYPE "SourceEnvironment" AS ENUM ('UNCLASSIFIED', 'TEST', 'PRODUCTION');
CREATE TYPE "SourceState" AS ENUM ('PREPARING', 'ACTIVE', 'RETIRED');

ALTER TABLE "IntegrationConnection"
  ADD COLUMN "environment" "SourceEnvironment" NOT NULL DEFAULT 'UNCLASSIFIED',
  ADD COLUMN "sourceState" "SourceState" NOT NULL DEFAULT 'PREPARING';

-- Preserve only an unambiguous legacy selection. Never guess its environment.
WITH sole_enabled AS (
  SELECT "storeId", min("id") AS "id"
  FROM "IntegrationConnection" WHERE "enabled" = true
  GROUP BY "storeId" HAVING count(*) = 1
)
UPDATE "IntegrationConnection" c SET "sourceState" = 'ACTIVE'
FROM sole_enabled s WHERE c."id" = s."id";

CREATE UNIQUE INDEX "IntegrationConnection_one_active_per_store"
  ON "IntegrationConnection" ("storeId") WHERE "sourceState" = 'ACTIVE';
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_active_enabled_check"
  CHECK ("sourceState" <> 'ACTIVE' OR "enabled" = true);
