-- Forward-only Phase 27A tenant boundary for channel OAuth state.
ALTER TABLE channel_oauth_states
  ADD CONSTRAINT channel_oauth_states_owner_fk
  FOREIGN KEY(project_id,user_id) REFERENCES projects(id,user_id) ON DELETE CASCADE;
