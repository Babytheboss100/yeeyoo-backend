-- Migrasjon: moodboards (Brand DNA 2.0, HOLO Sesjon J). Kjøres MANUELT.
-- Én moodboard per prosjekt. items er en JSONB-array av kort (inspo/note/swatch).

CREATE TABLE IF NOT EXISTS moodboards (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id    TEXT NOT NULL,
  project_id TEXT NOT NULL,
  items      JSONB DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id)
);
CREATE INDEX IF NOT EXISTS idx_moodboards_user ON moodboards (user_id);

DO $$ BEGIN
  ALTER TABLE moodboards ADD CONSTRAINT moodboards_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'moodboards user FK hoppet over: %', SQLERRM; END $$;
