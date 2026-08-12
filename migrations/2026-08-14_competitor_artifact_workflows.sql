CREATE TABLE IF NOT EXISTS competitor_analysis_runs (
  id uuid PRIMARY KEY, competitor_id uuid NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('completed','failed')),
  intelligence jsonb NOT NULL DEFAULT '{}'::jsonb, evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_url text NOT NULL, analyzed_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS competitor_analysis_runs_scope_idx ON competitor_analysis_runs(user_id,project_id,competitor_id,analyzed_at DESC);

ALTER TABLE marketing_artifacts ADD COLUMN IF NOT EXISTS root_id uuid;
ALTER TABLE marketing_artifacts ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES marketing_artifacts(id) ON DELETE SET NULL;
UPDATE marketing_artifacts SET root_id=id WHERE root_id IS NULL;
ALTER TABLE marketing_artifacts ALTER COLUMN root_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS marketing_artifacts_version_unique ON marketing_artifacts(user_id,project_id,root_id,artifact_version);

ALTER TABLE posts ADD COLUMN IF NOT EXISTS artifact_id uuid REFERENCES marketing_artifacts(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS artifact_version integer;
CREATE UNIQUE INDEX IF NOT EXISTS posts_artifact_enqueue_unique ON posts(user_id,project_id,artifact_id,artifact_version) WHERE artifact_id IS NOT NULL;
