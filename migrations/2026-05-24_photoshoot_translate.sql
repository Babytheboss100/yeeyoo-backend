-- Migrasjon: Photoshoot AI + Translate-i-bilder (HOLO Sesjon J, #11).
-- Kjøres MANUELT i Render Shell.

CREATE TABLE IF NOT EXISTS photoshoot_generations (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id        TEXT NOT NULL,
  project_id     TEXT,
  prompt         TEXT NOT NULL,
  scene_type     TEXT,
  aspect_ratio   TEXT DEFAULT '1:1',
  status         TEXT DEFAULT 'pending',     -- pending | completed | failed
  image_url      TEXT,
  fal_request_id TEXT,
  error          TEXT,
  cost_usd       NUMERIC(10,4),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  completed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_photoshoot_user ON photoshoot_generations (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS image_translations (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id              TEXT NOT NULL,
  project_id           TEXT,
  source_image_url     TEXT NOT NULL,
  translated_image_url TEXT,
  source_lang          TEXT,
  target_lang          TEXT,
  detected_text        TEXT,
  translated_text      TEXT,
  status               TEXT DEFAULT 'pending',   -- pending | completed | failed
  error                TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_imgtrans_user ON image_translations (user_id, created_at DESC);

DO $$ BEGIN
  ALTER TABLE photoshoot_generations ADD CONSTRAINT photoshoot_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'photoshoot user FK hoppet over: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE image_translations ADD CONSTRAINT imgtrans_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'image_translations user FK hoppet over: %', SQLERRM; END $$;
