-- Migrasjon: tiktok_accounts (HOLO Sesjon J). Kjøres MANUELT i Render Shell.
-- Krever TikTok app review. Tokens lagres kryptert (AES-256-GCM).

CREATE TABLE IF NOT EXISTS tiktok_accounts (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL,
  project_id    TEXT,
  open_id       TEXT,
  display_name  TEXT,
  access_token  TEXT NOT NULL,        -- kryptert
  refresh_token TEXT,                 -- kryptert
  expires_at    TIMESTAMPTZ,
  active        BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tiktok_user    ON tiktok_accounts (user_id);
CREATE INDEX IF NOT EXISTS idx_tiktok_project ON tiktok_accounts (project_id);

DO $$ BEGIN
  ALTER TABLE tiktok_accounts ADD CONSTRAINT tiktok_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'tiktok user FK hoppet over: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE tiktok_accounts ADD CONSTRAINT tiktok_project_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'tiktok project FK hoppet over: %', SQLERRM; END $$;
