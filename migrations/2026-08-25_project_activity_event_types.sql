-- Align project_activity_event_type_check with ACTIVITY_TYPES in src/lib/projectActivity.js.
-- The code allowlist grew to fourteen values while the schema constraint stayed at seven,
-- which made every meta_* and sosy_* activity write roll back its enclosing transaction.

ALTER TABLE project_activity
  DROP CONSTRAINT IF EXISTS project_activity_event_type_check;

ALTER TABLE project_activity
  ADD CONSTRAINT project_activity_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'tony_plan_completed',
    'artifact_awaiting_approval',
    'job_failed',
    'campaign_ready',
    'provider_disconnected',
    'content_published',
    'performance_data_available',
    'meta_connection_initiated',
    'meta_connection_completed',
    'meta_capability_verified',
    'meta_reauth_required',
    'sosy_delegation_created',
    'sosy_draft_completed',
    'sosy_voice_turn'
  ]));
