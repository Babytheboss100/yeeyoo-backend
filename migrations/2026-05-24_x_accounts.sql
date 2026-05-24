-- Migrasjon: x_accounts (X/Twitter, HOLO Sesjon J). Kjøres MANUELT i Render Shell.
-- Posting krever X API Basic/Pro tier. Tokens lagres kryptert (AES-256-GCM).

CREATE TABLE IF NOT EXISTS x_accounts (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL,
  project_id    TEXT,
  x_user_id     TEXT,
  username      TEXT,
  display_name  TEXT,
  access_token  TEXT NOT NULL,        -- kryptert (OAuth 2.0 user token, tweet.write)
  refresh_token TEXT,                 -- kryptert
  expires_at    TIMESTAMPTZ,
  active        BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_x_user    ON x_accounts (user_id);
CREATE INDEX IF NOT EXISTS idx_x_project ON x_accounts (project_id);

DO $$ BEGIN
  ALTER TABLE x_accounts ADD CONSTRAINT x_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'x user FK hoppet over: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE x_accounts ADD CONSTRAINT x_project_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'x project FK hoppet over: %', SQLERRM; END $$;
