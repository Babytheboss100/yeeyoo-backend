CREATE TABLE IF NOT EXISTS tony_execution_plans (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id), project_id UUID NOT NULL REFERENCES projects(id), campaign_id UUID REFERENCES campaigns(id),
  schema_version INTEGER NOT NULL DEFAULT 3, objective TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned','running','completed','failed','cancelled')),
  graph JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tony_execution_plans_project_idx ON tony_execution_plans(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS autopilot_policies (
  id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES projects(id), campaign_id UUID NOT NULL REFERENCES campaigns(id),
  level SMALLINT NOT NULL CHECK (level BETWEEN 0 AND 3), channels JSONB NOT NULL DEFAULT '[]', max_budget NUMERIC(14,2), currency VARCHAR(8),
  version INTEGER NOT NULL DEFAULT 1, created_by UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, campaign_id)
);

CREATE TABLE IF NOT EXISTS autopilot_action_audit (
  id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES projects(id), campaign_id UUID NOT NULL REFERENCES campaigns(id), plan_id UUID REFERENCES tony_execution_plans(id),
  action TEXT NOT NULL, decision TEXT NOT NULL, decision_code TEXT NOT NULL, idempotency_key TEXT NOT NULL, context_hash TEXT NOT NULL,
  actor_user_id UUID REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(project_id, idempotency_key)
);
