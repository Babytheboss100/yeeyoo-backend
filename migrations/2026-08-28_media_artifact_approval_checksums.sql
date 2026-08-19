-- Phase E transition:
-- New writes use yeeyoo.artifact.content.sha256.v1 (canonical JSON in the app).
-- Existing rows are retained and deterministically sealed with PostgreSQL jsonb
-- text under the explicitly versioned legacy algorithm. The immutability trigger
-- prevents either representation from drifting; edits must create a new version.
-- pgcrypto is established by 2026-05-23_core_baseline.sql.

ALTER TABLE marketing_artifacts
  ADD COLUMN IF NOT EXISTS checksum_version TEXT,
  ADD COLUMN IF NOT EXISTS content_checksum TEXT,
  ADD COLUMN IF NOT EXISTS output_checksum TEXT;

UPDATE marketing_artifacts
SET checksum_version = 'yeeyoo.artifact.legacy-pg-jsonb.v1',
    content_checksum = encode(digest(convert_to(jsonb_build_object('content',content,'provenance',provenance)::text,'UTF8'),'sha256'),'hex'),
    output_checksum = CASE WHEN content #>> '{media,sha256}' ~ '^[a-f0-9]{64}$' THEN content #>> '{media,sha256}' ELSE NULL END
WHERE checksum_version IS NULL OR content_checksum IS NULL;

ALTER TABLE marketing_artifacts
  ALTER COLUMN checksum_version SET NOT NULL,
  ALTER COLUMN content_checksum SET NOT NULL;
ALTER TABLE marketing_artifacts DROP CONSTRAINT IF EXISTS marketing_artifacts_content_checksum_check;
ALTER TABLE marketing_artifacts ADD CONSTRAINT marketing_artifacts_content_checksum_check CHECK (content_checksum ~ '^[a-f0-9]{64}$');
ALTER TABLE marketing_artifacts DROP CONSTRAINT IF EXISTS marketing_artifacts_output_checksum_check;
ALTER TABLE marketing_artifacts ADD CONSTRAINT marketing_artifacts_output_checksum_check CHECK (output_checksum IS NULL OR output_checksum ~ '^[a-f0-9]{64}$');

ALTER TABLE marketing_approval_decisions
  ADD COLUMN IF NOT EXISTS checksum_version TEXT,
  ADD COLUMN IF NOT EXISTS content_checksum TEXT,
  ADD COLUMN IF NOT EXISTS output_checksum TEXT,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revocation_reason TEXT;

UPDATE marketing_approval_decisions d
SET checksum_version=a.checksum_version, content_checksum=a.content_checksum, output_checksum=a.output_checksum,
    revoked_at=CASE WHEN d.artifact_version<>a.artifact_version OR d.user_id<>a.user_id OR d.project_id<>a.project_id THEN COALESCE(d.revoked_at,NOW()) ELSE d.revoked_at END,
    revocation_reason=CASE WHEN d.artifact_version<>a.artifact_version OR d.user_id<>a.user_id OR d.project_id<>a.project_id THEN COALESCE(d.revocation_reason,'legacy approval scope mismatch') ELSE d.revocation_reason END
FROM marketing_artifacts a
WHERE a.id=d.artifact_id
  AND (d.checksum_version IS NULL OR d.content_checksum IS NULL);

ALTER TABLE marketing_approval_decisions
  ALTER COLUMN checksum_version SET NOT NULL,
  ALTER COLUMN content_checksum SET NOT NULL;
ALTER TABLE marketing_approval_decisions DROP CONSTRAINT IF EXISTS marketing_approval_content_checksum_check;
ALTER TABLE marketing_approval_decisions ADD CONSTRAINT marketing_approval_content_checksum_check CHECK (content_checksum ~ '^[a-f0-9]{64}$');
ALTER TABLE marketing_approval_decisions DROP CONSTRAINT IF EXISTS marketing_approval_output_checksum_check;
ALTER TABLE marketing_approval_decisions ADD CONSTRAINT marketing_approval_output_checksum_check CHECK (output_checksum IS NULL OR output_checksum ~ '^[a-f0-9]{64}$');
CREATE INDEX IF NOT EXISTS marketing_approval_checksum_idx ON marketing_approval_decisions(user_id,project_id,artifact_id,artifact_version,content_checksum) WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION yeeyoo_enforce_artifact_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.content,NEW.provenance,NEW.provider,NEW.model,NEW.checksum_version,NEW.content_checksum,NEW.output_checksum)
     IS DISTINCT FROM ROW(OLD.content,OLD.provenance,OLD.provider,OLD.model,OLD.checksum_version,OLD.content_checksum,OLD.output_checksum) THEN
    RAISE EXCEPTION 'immutable marketing artifact content must be versioned';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS marketing_artifacts_immutable_checksum_guard ON marketing_artifacts;
CREATE TRIGGER marketing_artifacts_immutable_checksum_guard BEFORE UPDATE ON marketing_artifacts
FOR EACH ROW EXECUTE FUNCTION yeeyoo_enforce_artifact_immutability();

CREATE OR REPLACE FUNCTION yeeyoo_revoke_prior_artifact_approvals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE marketing_approval_decisions d SET revoked_at=COALESCE(d.revoked_at,NOW()), revocation_reason=COALESCE(d.revocation_reason,'superseded by artifact version')
  FROM marketing_artifacts prior
  WHERE prior.id=d.artifact_id AND prior.root_id=NEW.root_id AND prior.id<>NEW.id
    AND d.user_id=NEW.user_id AND d.project_id=NEW.project_id AND d.revoked_at IS NULL;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS marketing_artifacts_revoke_prior_approvals ON marketing_artifacts;
CREATE TRIGGER marketing_artifacts_revoke_prior_approvals AFTER INSERT ON marketing_artifacts
FOR EACH ROW WHEN (NEW.artifact_version > 1) EXECUTE FUNCTION yeeyoo_revoke_prior_artifact_approvals();
