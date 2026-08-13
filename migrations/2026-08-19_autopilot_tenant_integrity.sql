-- Bind every approval envelope to one tenant across project, campaign,
-- artifact and Tony plan. Independent FKs only prove that each row exists;
-- these composite FKs prove all referenced rows belong to the same tenant.
ALTER TABLE autopilot_action_approvals ADD COLUMN IF NOT EXISTS user_id TEXT;
UPDATE autopilot_action_approvals a SET user_id=p.user_id FROM projects p
 WHERE a.project_id=p.id AND a.user_id IS NULL;
ALTER TABLE autopilot_action_approvals ALTER COLUMN user_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS phase15_projects_id_user_unique ON projects(id,user_id);
CREATE UNIQUE INDEX IF NOT EXISTS phase15_campaigns_id_project_user_unique ON marketing_campaigns(id,project_id,user_id);
CREATE UNIQUE INDEX IF NOT EXISTS phase15_artifacts_id_project_user_unique ON marketing_artifacts(id,project_id,user_id);
CREATE UNIQUE INDEX IF NOT EXISTS phase15_tony_plans_id_project_user_unique ON tony_execution_plans(id,project_id,user_id);

DO $$ BEGIN
  ALTER TABLE autopilot_action_approvals ADD CONSTRAINT autopilot_approvals_project_tenant_fk
    FOREIGN KEY(project_id,user_id) REFERENCES projects(id,user_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE autopilot_action_approvals ADD CONSTRAINT autopilot_approvals_campaign_tenant_fk
    FOREIGN KEY(campaign_id,project_id,user_id) REFERENCES marketing_campaigns(id,project_id,user_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE autopilot_action_approvals ADD CONSTRAINT autopilot_approvals_artifact_tenant_fk
    FOREIGN KEY(artifact_id,project_id,user_id) REFERENCES marketing_artifacts(id,project_id,user_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE autopilot_action_approvals ADD CONSTRAINT autopilot_approvals_plan_tenant_fk
    FOREIGN KEY(plan_id,project_id,user_id) REFERENCES tony_execution_plans(id,project_id,user_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
