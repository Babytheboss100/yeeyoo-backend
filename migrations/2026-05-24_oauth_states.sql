-- Migrasjon: oauth_states (HOLO Sesjon J). Kjøres MANUELT i Render Shell.
-- CSRF-/state-validering for OAuth-redirect-flyt. Forbrukes ved callback.

CREATE TABLE IF NOT EXISTS oauth_states (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  state      TEXT UNIQUE NOT NULL,
  user_id    TEXT NOT NULL,
  provider   TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_state ON oauth_states (state);
