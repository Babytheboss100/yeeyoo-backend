ALTER TABLE marketing_campaigns DROP CONSTRAINT IF EXISTS marketing_campaigns_status_check;
ALTER TABLE marketing_campaigns ADD CONSTRAINT marketing_campaigns_status_check CHECK (status IN ('draft','planned','active','paused','completed','archived'));
ALTER TABLE posts ADD COLUMN IF NOT EXISTS campaign_id TEXT;
CREATE INDEX IF NOT EXISTS posts_campaign_scope_idx ON posts(user_id,project_id,campaign_id,status);
CREATE TABLE IF NOT EXISTS marketing_approval_decisions (
  id UUID PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL, campaign_id TEXT,
  artifact_id TEXT NOT NULL REFERENCES marketing_artifacts(id), artifact_version INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approved','rejected','changes_requested')),
  comment TEXT, group_id UUID, decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS marketing_approval_idempotency_uq ON marketing_approval_decisions(user_id,project_id,artifact_id,artifact_version,decision);
CREATE INDEX IF NOT EXISTS marketing_approval_pending_idx ON marketing_approval_decisions(user_id,project_id,campaign_id,decided_at DESC);
