CREATE TABLE IF NOT EXISTS project_marketing_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id TEXT NOT NULL, project_id TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1, website_url TEXT, profile JSONB NOT NULL, source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS project_marketing_profiles_user_project_idx ON project_marketing_profiles(user_id, project_id);
CREATE TABLE IF NOT EXISTS publish_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id TEXT NOT NULL, project_id TEXT, post_id TEXT NOT NULL,
  adapter TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, provider_result JSONB, error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS publish_attempts_user_post_idx ON publish_attempts(user_id, post_id);
CREATE TABLE IF NOT EXISTS streak_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id TEXT NOT NULL, event_key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id, event_key)
);
ALTER TABLE whatsapp_business_accounts ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE whatsapp_business_accounts ADD COLUMN IF NOT EXISTS project_id TEXT;
CREATE INDEX IF NOT EXISTS whatsapp_business_accounts_user_idx ON whatsapp_business_accounts(user_id);
