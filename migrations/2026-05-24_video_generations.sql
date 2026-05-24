-- Migrasjon: video_generations (AI-video MVP, HOLO Sesjon J). Kjøres MANUELT.
-- fal.ai (samme provider som FLUX). Asynkron jobb: status processing→completed/failed.

CREATE TABLE IF NOT EXISTS video_generations (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id        TEXT NOT NULL,
  project_id     TEXT,
  model          TEXT NOT NULL,
  prompt         TEXT,
  image_url      TEXT,
  status         TEXT DEFAULT 'processing',   -- processing | completed | failed
  fal_request_id TEXT,
  video_url      TEXT,
  error          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_video_user ON video_generations (user_id, created_at DESC);

DO $$ BEGIN
  ALTER TABLE video_generations ADD CONSTRAINT video_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'video user FK hoppet over: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE video_generations ADD CONSTRAINT video_project_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'video project FK hoppet over: %', SQLERRM; END $$;
