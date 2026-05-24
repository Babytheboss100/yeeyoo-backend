-- Migrasjon: pinterest_accounts (HOLO Sesjon J). Kjøres MANUELT i Render Shell.
-- Pinterest API v5. Tokens lagres kryptert (AES-256-GCM).

CREATE TABLE IF NOT EXISTS pinterest_accounts (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id          TEXT NOT NULL,
  project_id       TEXT,
  pinterest_user_id TEXT,
  default_board_id TEXT,
  display_name     TEXT,
  access_token     TEXT NOT NULL,    -- kryptert
  refresh_token    TEXT,             -- kryptert
  expires_at       TIMESTAMPTZ,
  active           BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pinterest_user    ON pinterest_accounts (user_id);
CREATE INDEX IF NOT EXISTS idx_pinterest_project ON pinterest_accounts (project_id);

DO $$ BEGIN
  ALTER TABLE pinterest_accounts ADD CONSTRAINT pinterest_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'pinterest user FK hoppet over: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE pinterest_accounts ADD CONSTRAINT pinterest_project_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'pinterest project FK hoppet over: %', SQLERRM; END $$;
