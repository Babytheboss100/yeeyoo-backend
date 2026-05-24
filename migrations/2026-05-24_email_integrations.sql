-- Migrasjon: email_integrations (Klaviyo + Mailchimp, HOLO Sesjon J, #9).
-- Kjøres MANUELT i Render Shell. API-nøkler lagres kryptert (AES-256-GCM).

CREATE TABLE IF NOT EXISTS email_integrations (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL,
  project_id    TEXT,
  provider      TEXT NOT NULL,        -- 'klaviyo' | 'mailchimp'
  api_key       TEXT NOT NULL,        -- kryptert
  list_id       TEXT,                 -- klaviyo list_id / mailchimp audience_id
  server_prefix TEXT,                 -- mailchimp datacenter (f.eks. us21)
  active        BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_email_integ_user ON email_integrations (user_id);

DO $$ BEGIN
  ALTER TABLE email_integrations ADD CONSTRAINT email_integ_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'email_integrations user FK hoppet over: %', SQLERRM; END $$;
