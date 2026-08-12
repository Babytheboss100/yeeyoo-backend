-- Bind core project-scoped rows to the owning user at the database boundary.
CREATE UNIQUE INDEX IF NOT EXISTS projects_id_user_unique ON projects(id,user_id);

ALTER TABLE marketing_campaigns ADD CONSTRAINT marketing_campaigns_owner_fk
  FOREIGN KEY(project_id,user_id) REFERENCES projects(id,user_id) ON DELETE CASCADE;
ALTER TABLE marketing_artifacts ADD CONSTRAINT marketing_artifacts_owner_fk
  FOREIGN KEY(project_id,user_id) REFERENCES projects(id,user_id) ON DELETE CASCADE;
ALTER TABLE ai_jobs ADD CONSTRAINT ai_jobs_owner_fk
  FOREIGN KEY(project_id,user_id) REFERENCES projects(id,user_id) ON DELETE CASCADE;
ALTER TABLE channel_connections ADD CONSTRAINT channel_connections_owner_fk
  FOREIGN KEY(project_id,user_id) REFERENCES projects(id,user_id) ON DELETE CASCADE;
ALTER TABLE marketing_performance_events ADD CONSTRAINT marketing_performance_events_owner_fk
  FOREIGN KEY(project_id,user_id) REFERENCES projects(id,user_id) ON DELETE CASCADE;
ALTER TABLE project_activity ADD CONSTRAINT project_activity_owner_fk
  FOREIGN KEY(project_id,user_id) REFERENCES projects(id,user_id) ON DELETE CASCADE;
