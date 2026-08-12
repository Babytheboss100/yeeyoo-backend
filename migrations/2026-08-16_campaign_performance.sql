CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  objective TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','completed','archived')),
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS marketing_campaigns_tenant_idx
  ON marketing_campaigns(user_id, project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS marketing_performance_events (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  artifact_id TEXT,
  kind TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  unit TEXT NOT NULL DEFAULT 'count',
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS marketing_performance_event_source_uq
  ON marketing_performance_events(user_id, project_id, (source->>'provider'), (source->>'externalEventId'));
CREATE INDEX IF NOT EXISTS marketing_performance_campaign_idx
  ON marketing_performance_events(user_id, project_id, campaign_id, occurred_at DESC);
