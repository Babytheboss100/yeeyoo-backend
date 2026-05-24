-- Migrasjon: youtube_accounts (HOLO Sesjon J). Kjøres MANUELT i Render Shell.
-- YouTube Data API v3 (scope youtube.upload). Tokens lagres kryptert (AES-256-GCM).

CREATE TABLE IF NOT EXISTS youtube_accounts (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL,
  project_id    TEXT,
  channel_id    TEXT,
  channel_title TEXT,
  display_name  TEXT,
  access_token  TEXT NOT NULL,        -- kryptert (utløper ~1t — refresh_token brukes)
  refresh_token TEXT,                 -- kryptert
  expires_at    TIMESTAMPTZ,
  active        BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_youtube_user    ON youtube_accounts (user_id);
CREATE INDEX IF NOT EXISTS idx_youtube_project ON youtube_accounts (project_id);

DO $$ BEGIN
  ALTER TABLE youtube_accounts ADD CONSTRAINT youtube_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'youtube user FK hoppet over: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE youtube_accounts ADD CONSTRAINT youtube_project_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'youtube project FK hoppet over: %', SQLERRM; END $$;
