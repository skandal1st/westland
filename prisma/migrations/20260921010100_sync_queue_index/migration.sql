-- Keep repeated queue scans independent of accumulated historical reports.
CREATE INDEX "SyncRun_active_queue_idx" ON "SyncRun"("connectionId", "createdAt")
WHERE queued = true AND status IN ('PENDING', 'RUNNING');
