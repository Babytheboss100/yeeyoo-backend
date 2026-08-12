-- Additive canonical channel-connection projection. Existing provider tables
-- remain intact and can be migrated incrementally without token duplication.
CREATE TABLE IF NOT EXISTS channel_connections (
  id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected','reconnect_required','error','revoked')),
  scopes             TEXT[] NOT NULL DEFAULT '{}',
  capabilities       JSONB NOT NULL DEFAULT '{}',
  last_verified_at   TIMESTAMPTZ,
  last_error_code    TEXT,
  last_error_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, provider, provider_account_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_connections_user_project
  ON channel_connections (user_id, project_id);

-- Email integrations become project-scoped. Legacy NULL-project rows are kept
-- inactive until an owner explicitly reconnects them to an owned project.
ALTER TABLE email_integrations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE email_integrations ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ;
ALTER TABLE email_integrations ADD COLUMN IF NOT EXISTS last_error TEXT;
UPDATE email_integrations SET active=FALSE WHERE project_id IS NULL;
ALTER TABLE email_integrations DROP CONSTRAINT IF EXISTS email_integrations_user_id_provider_key;
CREATE UNIQUE INDEX IF NOT EXISTS email_integrations_project_provider_unique
  ON email_integrations (project_id, provider) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_integ_user_project
  ON email_integrations (user_id, project_id);

