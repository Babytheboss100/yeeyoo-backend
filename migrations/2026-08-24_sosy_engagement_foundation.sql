-- Provider-neutral, tenant-bound social engagement foundation. No provider execution lives here.
CREATE TABLE IF NOT EXISTS social_engagement_interactions (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  provider_interaction_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('comment','mention','direct_message','review')),
  author_ref TEXT,
  body TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  classification JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT social_engagement_interactions_project_owner_fk
    FOREIGN KEY(project_id,user_id) REFERENCES projects(id,user_id) ON DELETE CASCADE,
  UNIQUE(user_id,project_id,provider,provider_account_id,provider_interaction_id),
  UNIQUE(id,user_id,project_id)
);

CREATE INDEX IF NOT EXISTS social_engagement_scope_time_idx
  ON social_engagement_interactions(user_id,project_id,occurred_at DESC);

CREATE TABLE IF NOT EXISTS social_engagement_reply_drafts (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  interaction_id UUID NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','WAITING_APPROVAL','APPROVED','SENT','REJECTED','ESCALATED')),
  model TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT social_engagement_reply_project_owner_fk
    FOREIGN KEY(project_id,user_id) REFERENCES projects(id,user_id) ON DELETE CASCADE,
  CONSTRAINT social_engagement_reply_interaction_fk
    FOREIGN KEY(interaction_id,user_id,project_id) REFERENCES social_engagement_interactions(id,user_id,project_id) ON DELETE CASCADE,
  UNIQUE(user_id,project_id,idempotency_key)
);

CREATE TABLE IF NOT EXISTS social_engagement_leads (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  interaction_id UUID NOT NULL,
  source TEXT NOT NULL,
  channel TEXT NOT NULL,
  campaign_id TEXT,
  score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'DETECTED' CHECK(status IN ('DETECTED','REVIEWING','QUALIFIED','DISMISSED')),
  assigned_owner_id TEXT,
  notes TEXT,
  follow_up_at TIMESTAMPTZ,
  reason TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT social_engagement_lead_project_owner_fk
    FOREIGN KEY(project_id,user_id) REFERENCES projects(id,user_id) ON DELETE CASCADE,
  CONSTRAINT social_engagement_lead_campaign_tenant_fk
    FOREIGN KEY(campaign_id,project_id,user_id) REFERENCES marketing_campaigns(id,project_id,user_id),
  CONSTRAINT social_engagement_lead_interaction_fk
    FOREIGN KEY(interaction_id,user_id,project_id) REFERENCES social_engagement_interactions(id,user_id,project_id) ON DELETE CASCADE,
  UNIQUE(user_id,project_id,interaction_id)
);

CREATE TABLE IF NOT EXISTS social_engagement_escalations (
  id UUID PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL, interaction_id UUID NOT NULL,
  reason TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(project_id,user_id) REFERENCES projects(id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(interaction_id,user_id,project_id) REFERENCES social_engagement_interactions(id,user_id,project_id) ON DELETE CASCADE,
  UNIQUE(user_id,project_id,interaction_id,reason)
);

CREATE TABLE IF NOT EXISTS social_engagement_trigger_rules (
  id UUID PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL, channel TEXT NOT NULL,
  pattern JSONB NOT NULL, campaign_id TEXT, template_id TEXT, approval_required BOOLEAN NOT NULL DEFAULT TRUE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE, scope JSONB NOT NULL DEFAULT '{}'::jsonb, expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(project_id,user_id) REFERENCES projects(id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(campaign_id,project_id,user_id) REFERENCES marketing_campaigns(id,project_id,user_id),
  CHECK(approval_required = TRUE), CHECK(enabled = FALSE OR expires_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS social_engagement_learning (
  id UUID PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('OBSERVATION','HYPOTHESIS','RECOMMENDATION')),
  body JSONB NOT NULL, evidence JSONB NOT NULL DEFAULT '[]'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(project_id,user_id) REFERENCES projects(id,user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS social_engagement_daily_briefs (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  brief_date DATE NOT NULL,
  summary JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT social_engagement_brief_project_owner_fk
    FOREIGN KEY(project_id,user_id) REFERENCES projects(id,user_id) ON DELETE CASCADE,
  UNIQUE(user_id,project_id,brief_date)
);
