-- ADDITIVE ONLY. Prepared for owner review; do not execute without approval.
ALTER TABLE marketing_artifacts
  ADD COLUMN IF NOT EXISTS genome JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'marketing_artifacts_genome_object_check'
      AND conrelid = 'marketing_artifacts'::regclass
  ) THEN
    ALTER TABLE marketing_artifacts
      ADD CONSTRAINT marketing_artifacts_genome_object_check
      CHECK (genome IS NULL OR jsonb_typeof(genome) = 'object') NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS marketing_artifacts_genome_gin_idx
  ON marketing_artifacts USING GIN (genome jsonb_path_ops)
  WHERE genome IS NOT NULL;
