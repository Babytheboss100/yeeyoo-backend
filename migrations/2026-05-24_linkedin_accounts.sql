-- Migrasjon: linkedin_accounts (HOLO Sesjon J). Kjøres MANUELT i Render Shell.
-- Tokens lagres kryptert (AES-256-GCM) — settes via POST /api/linkedin/accounts.

CREATE TABLE IF NOT EXISTS linkedin_accounts (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL,
  project_id    TEXT,
  author_urn    TEXT NOT NULL,        -- urn:li:person:XXXX | urn:li:organization:XXXX
  display_name  TEXT,
  access_token  TEXT NOT NULL,        -- kryptert
  refresh_token TEXT,                 -- kryptert
  expires_at    TIMESTAMPTZ,
  active        BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_linkedin_user    ON linkedin_accounts (user_id);
CREATE INDEX IF NOT EXISTS idx_linkedin_project ON linkedin_accounts (project_id);

DO $$ BEGIN
  ALTER TABLE linkedin_accounts ADD CONSTRAINT linkedin_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'linkedin user FK hoppet over: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE linkedin_accounts ADD CONSTRAINT linkedin_project_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'linkedin project FK hoppet over: %', SQLERRM; END $$;
