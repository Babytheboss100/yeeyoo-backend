-- Migrasjon: Inbox (IG/FB DM, HOLO Sesjon J, #8). Kjøres MANUELT i Render Shell.

CREATE TABLE IF NOT EXISTS inbox_threads (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         TEXT NOT NULL,
  project_id      TEXT,
  meta_account_id TEXT,                 -- FK meta_accounts (kan være null hvis ukjent)
  platform        TEXT NOT NULL,        -- 'facebook' | 'instagram'
  recipient_id    TEXT NOT NULL,        -- vår side: page_id / ig_user_id
  sender_id       TEXT NOT NULL,        -- kundens PSID / IGSID
  customer_name   TEXT,
  status          TEXT DEFAULT 'open',
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (platform, recipient_id, sender_id)
);

CREATE TABLE IF NOT EXISTS inbox_messages (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  thread_id       TEXT NOT NULL REFERENCES inbox_threads(id) ON DELETE CASCADE,
  direction       TEXT CHECK (direction IN ('inbound','outbound')),
  text            TEXT,
  meta_message_id TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inbox_threads_user ON inbox_threads (user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_msgs_thread  ON inbox_messages (thread_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_msgs_meta_message
  ON inbox_messages (meta_message_id) WHERE meta_message_id IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE inbox_threads ADD CONSTRAINT inbox_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'inbox user FK hoppet over: %', SQLERRM; END $$;
