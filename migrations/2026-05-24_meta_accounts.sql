-- Migrasjon: meta_accounts — Facebook Page + Instagram posting-mål (HOLO Sesjon J).
-- Kjøres MANUELT i Render Shell. Idempotent. Ingen auto-connect: rader settes
-- manuelt (én rad per Yeeyoo-kunde/prosjekt = whitelabel-identitet).

CREATE TABLE IF NOT EXISTS meta_accounts (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id      TEXT NOT NULL,
  project_id   TEXT,
  page_id      TEXT,                 -- Facebook Page ID
  page_name    TEXT,
  ig_user_id   TEXT,                 -- Instagram business account ID (IG User ID)
  ig_username  TEXT,
  access_token TEXT NOT NULL,        -- Page-/system-user-token (⚠️ klartekst — bør krypteres)
  display_name TEXT,                 -- whitelabel: merkenavn vist per kunde
  active       BOOLEAN DEFAULT TRUE,
  connection_status TEXT NOT NULL DEFAULT 'connected',
  token_expires_at TIMESTAMPTZ,
  last_provider_error TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meta_accounts_user    ON meta_accounts (user_id);
CREATE INDEX IF NOT EXISTS idx_meta_accounts_project ON meta_accounts (project_id);

ALTER TABLE meta_accounts ADD COLUMN IF NOT EXISTS connection_status TEXT NOT NULL DEFAULT 'connected';
ALTER TABLE meta_accounts ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;
ALTER TABLE meta_accounts ADD COLUMN IF NOT EXISTS last_provider_error TEXT;

DO $$
BEGIN
  ALTER TABLE meta_accounts
    ADD CONSTRAINT meta_accounts_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'meta_accounts user FK hoppet over: %', SQLERRM; END $$;

DO $$
BEGIN
  ALTER TABLE meta_accounts
    ADD CONSTRAINT meta_accounts_project_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'meta_accounts project FK hoppet over: %', SQLERRM; END $$;
