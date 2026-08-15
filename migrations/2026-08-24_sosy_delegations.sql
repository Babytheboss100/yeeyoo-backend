CREATE UNIQUE INDEX IF NOT EXISTS marketing_campaigns_sosy_owner_unique ON marketing_campaigns(id,user_id,project_id);
CREATE UNIQUE INDEX IF NOT EXISTS tony_execution_plans_sosy_owner_unique ON tony_execution_plans(id,user_id,project_id);
CREATE UNIQUE INDEX IF NOT EXISTS marketing_artifacts_sosy_owner_unique ON marketing_artifacts(id,user_id,project_id);

CREATE TABLE IF NOT EXISTS sosy_delegations (
  id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  specialist TEXT NOT NULL DEFAULT 'sosy' CHECK (specialist = 'sosy'), user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, campaign_id TEXT REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
  tony_plan_id TEXT REFERENCES tony_execution_plans(id) ON DELETE SET NULL, source_artifact_id TEXT REFERENCES marketing_artifacts(id) ON DELETE SET NULL,
  task_type TEXT NOT NULL CHECK (task_type IN ('content.create','content.adapt','calendar.propose')), objective TEXT NOT NULL,
  channels JSONB NOT NULL DEFAULT '[]'::jsonb, conversation_language TEXT NOT NULL, output_language TEXT NOT NULL, schedule JSONB,
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','working','waiting_approval','planned','queued','completed','failed')),
  result_artifact_id TEXT REFERENCES marketing_artifacts(id) ON DELETE SET NULL, error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(project_id,user_id) REFERENCES projects(id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(campaign_id,user_id,project_id) REFERENCES marketing_campaigns(id,user_id,project_id),
  FOREIGN KEY(tony_plan_id,user_id,project_id) REFERENCES tony_execution_plans(id,user_id,project_id),
  FOREIGN KEY(source_artifact_id,user_id,project_id) REFERENCES marketing_artifacts(id,user_id,project_id),
  FOREIGN KEY(result_artifact_id,user_id,project_id) REFERENCES marketing_artifacts(id,user_id,project_id)
);
CREATE INDEX IF NOT EXISTS sosy_delegations_owner_project_idx ON sosy_delegations(user_id,project_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS sosy_delegations_tony_plan_idx ON sosy_delegations(user_id,project_id,tony_plan_id) WHERE tony_plan_id IS NOT NULL;
