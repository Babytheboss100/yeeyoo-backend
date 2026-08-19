-- OWNER REVIEW REQUIRED; do not execute without approval.
--
-- The requested aliases (locked_at, locked_by, heartbeat_at,
-- next_attempt_at, max_attempts) are intentionally NOT added. Canonical phase
-- 28 already owns the same concerns through the fields below, which are used
-- by src/jobs/workerStore.js and were created by the 2026-08-13/17 migrations:
--
--   locked_by       -> lease_owner
--   heartbeat_at    -> last_heartbeat_at
--   next_attempt_at -> available_at
--   max_attempts    -> retry_count + max_retries
--   locked_at       -> represented by started_at plus lease_expires_at
--
-- Adding a second writable lease vocabulary would create two sources of truth.
-- This migration therefore fails closed if the canonical lease foundation is
-- absent and otherwise performs no schema mutation.
DO $$
DECLARE
  missing_columns TEXT[];
BEGIN
  SELECT ARRAY_AGG(required.column_name ORDER BY required.column_name)
  INTO missing_columns
  FROM (
    VALUES
      ('lease_owner'),
      ('lease_expires_at'),
      ('last_heartbeat_at'),
      ('available_at'),
      ('retry_count'),
      ('max_retries'),
      ('started_at')
  ) AS required(column_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns existing
    WHERE existing.table_schema = 'public'
      AND existing.table_name = 'ai_jobs'
      AND existing.column_name = required.column_name
  );

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION 'Canonical ai_jobs lease foundation is incomplete: %', missing_columns;
  END IF;
END $$;
