-- Project-scope saved inspiration without deleting legacy rows.
ALTER TABLE user_saved_inspo ADD COLUMN IF NOT EXISTS project_id TEXT;

ALTER TABLE user_saved_inspo
  DROP CONSTRAINT IF EXISTS user_saved_inspo_user_id_inspo_item_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS user_saved_inspo_user_project_item_uidx
  ON user_saved_inspo (user_id, project_id, inspo_item_id);

CREATE UNIQUE INDEX IF NOT EXISTS user_saved_inspo_legacy_user_item_uidx
  ON user_saved_inspo (user_id, inspo_item_id)
  WHERE project_id IS NULL;

CREATE INDEX IF NOT EXISTS user_saved_inspo_project_idx
  ON user_saved_inspo (user_id, project_id, saved_at DESC);
