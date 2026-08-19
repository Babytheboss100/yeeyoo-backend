ALTER TABLE sosy_delegations
  ADD COLUMN IF NOT EXISTS media_request JSONB,
  ADD COLUMN IF NOT EXISTS media_job_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS ai_jobs_sosy_owner_unique
  ON ai_jobs(id,user_id,project_id);

DO $$ BEGIN
  ALTER TABLE sosy_delegations ADD CONSTRAINT sosy_delegations_media_job_owner_fk
    FOREIGN KEY(media_job_id,user_id,project_id)
    REFERENCES ai_jobs(id,user_id,project_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS sosy_delegations_media_job_idx
  ON sosy_delegations(user_id,project_id,media_job_id)
  WHERE media_job_id IS NOT NULL;
