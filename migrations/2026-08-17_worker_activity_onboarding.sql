ALTER TABLE ai_jobs
  ADD COLUMN IF NOT EXISTS lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ai_jobs_worker_claim_idx
  ON ai_jobs(status, available_at, created_at)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS ai_jobs_expired_lease_idx
  ON ai_jobs(lease_expires_at)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS project_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'tony_plan_completed','artifact_awaiting_approval','job_failed','campaign_ready',
    'provider_disconnected','content_published','performance_data_available'
  )),
  subject_type TEXT,
  subject_id TEXT,
  summary TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, project_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS project_activity_feed_idx
  ON project_activity(user_id, project_id, created_at DESC);

