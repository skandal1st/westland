ALTER TABLE "IntegrationConnection" ADD COLUMN "exchangeRevision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "IntegrationJob" ADD COLUMN "generationId" TEXT;
ALTER TABLE "SyncCheckpoint" ADD COLUMN "generationId" TEXT;

CREATE TABLE "OnecExchangeSession" (
  "id" TEXT PRIMARY KEY, "connectionId" TEXT NOT NULL REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "sourceRevision" INTEGER NOT NULL, "credentialDigest" TEXT NOT NULL, "files" JSONB NOT NULL DEFAULT '[]',
  "initializedAt" TIMESTAMP(3), "closedAt" TIMESTAMP(3), "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "OnecExchangeSession_connectionId_createdAt_idx" ON "OnecExchangeSession"("connectionId", "createdAt");
CREATE TABLE "OnecGeneration" (
  "id" TEXT PRIMARY KEY, "connectionId" TEXT NOT NULL REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "sourceRevision" INTEGER NOT NULL, "files" JSONB NOT NULL, "digest" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "OnecGeneration_connectionId_sourceRevision_digest_key" ON "OnecGeneration"("connectionId", "sourceRevision", "digest");
CREATE INDEX "OnecGeneration_connectionId_createdAt_idx" ON "OnecGeneration"("connectionId", "createdAt");

-- Even a disable/reactivate round trip invalidates previously issued sessions/jobs.
CREATE FUNCTION bump_onec_source_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."sourceState" IS DISTINCT FROM OLD."sourceState" OR NEW."enabled" IS DISTINCT FROM OLD."enabled" THEN
    NEW."exchangeRevision" := OLD."exchangeRevision" + 1;
  ELSIF NEW."exchangeRevision" < OLD."exchangeRevision" THEN
    RAISE EXCEPTION 'source revision cannot decrease';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "IntegrationConnection_exchange_revision" BEFORE UPDATE ON "IntegrationConnection"
  FOR EACH ROW EXECUTE FUNCTION bump_onec_source_revision();
