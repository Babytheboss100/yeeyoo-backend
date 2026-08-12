-- Approval is a consumable authorization envelope, not a mutable status flag.
-- Its fingerprint binds the exact action and all execution-relevant versions.
CREATE TABLE IF NOT EXISTS autopilot_action_approvals (
  id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES projects(id), campaign_id UUID NOT NULL REFERENCES campaigns(id),
  plan_id UUID REFERENCES tony_execution_plans(id), artifact_id UUID NOT NULL, artifact_version INTEGER NOT NULL CHECK (artifact_version > 0),
  action TEXT NOT NULL CHECK (action IN ('publish','send')), policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  provider_connection_id TEXT NOT NULL, provider_connection_version INTEGER NOT NULL CHECK (provider_connection_version > 0),
  fingerprint CHAR(64) NOT NULL, nonce UUID NOT NULL, approved_by_user_id UUID NOT NULL REFERENCES users(id),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, consumed_at TIMESTAMPTZ,
  CHECK (expires_at > approved_at), UNIQUE(project_id, nonce), UNIQUE(project_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS autopilot_action_approvals_scope_idx ON autopilot_action_approvals(project_id,campaign_id,action,expires_at);
