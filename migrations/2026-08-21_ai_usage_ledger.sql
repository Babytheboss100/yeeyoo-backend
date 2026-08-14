-- Canonical, append-only AI usage and cost accounting.
CREATE TABLE IF NOT EXISTS ai_usage_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  project_id TEXT,
  campaign_id TEXT,
  plan_id TEXT,
  plan_step_id TEXT,
  job_id UUID,
  specialist TEXT,
  operation TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  status TEXT NOT NULL CHECK (status IN ('reserved','succeeded','failed','throttled','cancelled')),
  input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cached_input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  media_units NUMERIC(16,4) NOT NULL DEFAULT 0 CHECK (media_units >= 0),
  media_unit_type TEXT,
  cost_usd NUMERIC(16,8) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  estimated_cost_usd NUMERIC(16,8) NOT NULL DEFAULT 0 CHECK (estimated_cost_usd >= 0),
  provider_cost_usd NUMERIC(16,8) CHECK (provider_cost_usd >= 0),
  cost_source TEXT NOT NULL CHECK (cost_source IN ('estimated','provider_reported','non_billable')),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  billable BOOLEAN NOT NULL DEFAULT TRUE,
  retry_of UUID REFERENCES ai_usage_ledger(id) ON DELETE SET NULL,
  pricing_version TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_usage_ledger_project_owner_fk
    FOREIGN KEY(project_id,user_id) REFERENCES projects(id,user_id) ON DELETE CASCADE,
  CONSTRAINT ai_usage_ledger_job_fk
    FOREIGN KEY(job_id) REFERENCES ai_jobs(id) ON DELETE SET NULL,
  CONSTRAINT ai_usage_ledger_attempt_unique
    UNIQUE NULLS NOT DISTINCT(user_id, project_id, operation, idempotency_key, attempt)
);

CREATE INDEX IF NOT EXISTS ai_usage_ledger_tenant_time_idx
  ON ai_usage_ledger(user_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_ledger_job_idx ON ai_usage_ledger(job_id);
CREATE INDEX IF NOT EXISTS ai_usage_ledger_dimensions_idx
  ON ai_usage_ledger(user_id,project_id,campaign_id,plan_id,specialist,created_at DESC);

CREATE TABLE IF NOT EXISTS ai_cost_allowances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  project_id TEXT,
  campaign_id TEXT,
  plan_id TEXT,
  job_id UUID,
  period TEXT NOT NULL CHECK (period IN ('job','plan','day','month')),
  ceiling_usd NUMERIC(16,8) NOT NULL CHECK (ceiling_usd >= 0),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_cost_allowances_project_owner_fk
    FOREIGN KEY(project_id,user_id) REFERENCES projects(id,user_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_cost_allowances_scope_unique
  ON ai_cost_allowances(user_id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'),
    COALESCE(campaign_id, ''), COALESCE(plan_id, ''), COALESCE(job_id::text, ''), period);
