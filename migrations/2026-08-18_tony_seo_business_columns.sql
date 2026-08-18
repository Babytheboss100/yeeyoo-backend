-- Migrasjon: tony_conversations, tony_messages, seo_reports og de to
-- businesses-kolonnene koden har skrevet mot uten at skjemaet fulgte etter.
--
-- Kjøres MANUELT (psql $DATABASE_URL i Render Shell), som de øvrige
-- migrasjonene her. Idempotent: trygg å kjøre flere ganger, og trygg på en
-- database der deler av dette allerede finnes.
--
-- Alle nøkler er TEXT fordi users.id og projects.id er TEXT i denne
-- databasen. Se merknaden om TEXT↔UUID i 2026-05-24_ai_usage.sql.
--
-- Bevisst utelatt: CHECK på tony_messages.role. En allowlist i skjemaet som
-- koden vokser fra er nøyaktig feilen project_activity_event_type_check var.

-- ── tony_conversations ───────────────────────────────────────────────────
-- tony.js: INSERT (id,user_id,project_id,title,model); eierskapssjekk på
-- (id,user_id); listing på user_id + valgfri project_id sortert updated_at
-- DESC; UPDATE ... SET updated_at=NOW() etter hver melding.
CREATE TABLE IF NOT EXISTS tony_conversations (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT NOT NULL,
  project_id  TEXT,
  title       TEXT,
  model       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tony_conversations_user_updated
  ON tony_conversations (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tony_conversations_project_updated
  ON tony_conversations (project_id, updated_at DESC);

-- ── tony_messages ────────────────────────────────────────────────────────
-- tony.js skriver user-meldingen uten token-tall og assistant-svaret med
-- tokens_in/tokens_out, og leser (id,role,content,created_at) sortert stigende.
CREATE TABLE IF NOT EXISTS tony_messages (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  conversation_id TEXT NOT NULL REFERENCES tony_conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  tokens_in       INTEGER DEFAULT 0,
  tokens_out      INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tony_messages_conversation_created
  ON tony_messages (conversation_id, created_at);

-- ── seo_reports ──────────────────────────────────────────────────────────
-- seo.js: INSERT (id,user_id,project_id,url,keyword,result) der result er
-- JSON.stringify(...); listing på (project_id,user_id) sortert created_at DESC.
-- seo_profiles finnes allerede og røres ikke.
CREATE TABLE IF NOT EXISTS seo_reports (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  url         TEXT,
  keyword     TEXT,
  result      JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_seo_reports_project_created
  ON seo_reports (project_id, user_id, created_at DESC);

-- ── businesses: project_id + brand_dna ───────────────────────────────────
-- smartplan.js slår opp business via project_id, brand-dna.js skriver og
-- leser brand_dna som JSONB. Ingen av kolonnene fantes.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS brand_dna  JSONB;

-- Dekker smartplan.js: WHERE project_id=$1 AND user_id=$2 ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS idx_businesses_project_user_created
  ON businesses (project_id, user_id, created_at DESC);
-- Dekker brand-dna.js: WHERE user_id=$1 AND url=$2.
CREATE INDEX IF NOT EXISTS idx_businesses_user_url
  ON businesses (user_id, url);

-- ── Fremmednøkler ────────────────────────────────────────────────────────
-- Defensive, etter mønsteret i 2026-05-24_ai_usage.sql: en type-mismatch skal
-- gi en NOTICE, ikke avbryte migrasjonen midtveis.
DO $$
BEGIN
  ALTER TABLE tony_conversations
    ADD CONSTRAINT tony_conversations_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN others THEN RAISE NOTICE 'tony_conversations user FK hoppet over: %', SQLERRM;
END $$;

DO $$
BEGIN
  ALTER TABLE tony_conversations
    ADD CONSTRAINT tony_conversations_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN others THEN RAISE NOTICE 'tony_conversations project FK hoppet over: %', SQLERRM;
END $$;

DO $$
BEGIN
  ALTER TABLE seo_reports
    ADD CONSTRAINT seo_reports_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN others THEN RAISE NOTICE 'seo_reports user FK hoppet over: %', SQLERRM;
END $$;

DO $$
BEGIN
  ALTER TABLE seo_reports
    ADD CONSTRAINT seo_reports_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN others THEN RAISE NOTICE 'seo_reports project FK hoppet over: %', SQLERRM;
END $$;

DO $$
BEGIN
  ALTER TABLE businesses
    ADD CONSTRAINT businesses_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN others THEN RAISE NOTICE 'businesses project FK hoppet over: %', SQLERRM;
END $$;
