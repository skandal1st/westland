-- Run after enum additions have committed. Preserve original counters/history.
-- Only legacy flat stats can match; new result envelopes are left unchanged.
WITH latest AS (
  SELECT DISTINCT ON ("jobId") "jobId", stats
  FROM "IntegrationAttempt" ORDER BY "jobId", "startedAt" DESC, id DESC
), failures AS (
  SELECT "jobId", stats FROM latest
  WHERE jsonb_typeof(stats->'failed') = 'number' AND (stats->>'failed')::numeric > 0
)
UPDATE "IntegrationJob" j SET status = CASE
  WHEN COALESCE((f.stats->>'imported')::numeric, 0) + COALESCE((f.stats->>'skipped')::numeric, 0) > 0 THEN 'PARTIAL'::"IntegrationJobStatus"
  ELSE 'FAILED'::"IntegrationJobStatus" END, "lastError" = 'import_rows_failed'
FROM failures f WHERE j.id = f."jobId" AND j.status = 'SUCCEEDED';
UPDATE "IntegrationAttempt" SET status = CASE
  WHEN COALESCE((stats->>'imported')::numeric, 0) + COALESCE((stats->>'skipped')::numeric, 0) > 0 THEN 'PARTIAL'::"IntegrationJobStatus"
  ELSE 'FAILED'::"IntegrationJobStatus" END,
  error = COALESCE(error, 'import_rows_failed')
WHERE status = 'SUCCEEDED' AND jsonb_typeof(stats->'failed') = 'number' AND (stats->>'failed')::numeric > 0;
