-- Migrasjon: reddit_accounts (HOLO Sesjon J). Kjøres MANUELT i Render Shell.
-- Reddit API (oauth.reddit.com). Tokens lagres kryptert (AES-256-GCM).

CREATE TABLE IF NOT EXISTS reddit_accounts (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         TEXT NOT NULL,
  project_id      TEXT,
  reddit_username TEXT,
  display_name    TEXT,
  access_token    TEXT NOT NULL,      -- kryptert
  refresh_token   TEXT,               -- kryptert
  expires_at      TIMESTAMPTZ,
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reddit_user    ON reddit_accounts (user_id);
CREATE INDEX IF NOT EXISTS idx_reddit_project ON reddit_accounts (project_id);

DO $$ BEGIN
  ALTER TABLE reddit_accounts ADD CONSTRAINT reddit_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'reddit user FK hoppet over: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE reddit_accounts ADD CONSTRAINT reddit_project_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'reddit project FK hoppet over: %', SQLERRM; END $$;
