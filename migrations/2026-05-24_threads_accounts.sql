-- Migrasjon: threads_accounts (HOLO Sesjon J). Kjøres MANUELT i Render Shell.
-- Threads Graph API (graph.threads.net). Token kan være samme Meta-token som IG
-- hvis threads_content_publish-scope er gitt. Lagres kryptert (AES-256-GCM).

CREATE TABLE IF NOT EXISTS threads_accounts (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id          TEXT NOT NULL,
  project_id       TEXT,
  threads_user_id  TEXT NOT NULL,
  username         TEXT,
  display_name     TEXT,
  access_token     TEXT NOT NULL,    -- kryptert
  refresh_token    TEXT,             -- kryptert
  expires_at       TIMESTAMPTZ,
  active           BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_threads_user    ON threads_accounts (user_id);
CREATE INDEX IF NOT EXISTS idx_threads_project ON threads_accounts (project_id);

DO $$ BEGIN
  ALTER TABLE threads_accounts ADD CONSTRAINT threads_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'threads user FK hoppet over: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE threads_accounts ADD CONSTRAINT threads_project_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'threads project FK hoppet over: %', SQLERRM; END $$;
