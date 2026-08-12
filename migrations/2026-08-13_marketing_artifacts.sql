CREATE TABLE IF NOT EXISTS competitors (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL, website_url text NOT NULL, status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','queued','analyzed','failed')),
  intelligence jsonb NOT NULL DEFAULT '{}'::jsonb, evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  analyzed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, website_url)
);
CREATE INDEX IF NOT EXISTS competitors_project_idx ON competitors(user_id, project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS marketing_artifacts (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  campaign_id uuid, type text NOT NULL, schema_version integer NOT NULL DEFAULT 1,
  artifact_version integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','approved','rejected','archived')),
  purpose text NOT NULL, channel text, content jsonb NOT NULL,
  provenance jsonb NOT NULL, provider text NOT NULL, model text NOT NULL,
  approved_by uuid REFERENCES users(id), approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_artifacts_project_idx ON marketing_artifacts(user_id, project_id, type, updated_at DESC);
