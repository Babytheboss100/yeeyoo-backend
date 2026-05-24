-- Migrasjon: WhatsApp multi-WABA (HOLO Sesjon J, del 1).
-- Kjøres MANUELT i Render Shell. Idempotent.
--
-- FK til users(id)/projects(id) gjøres defensivt (DO-block): resten av skjemaet
-- droppet user_id-FK-er pga TEXT↔UUID-mismatch (se db.js). Intra-WhatsApp-FK-er
-- (TEXT→TEXT) er trygge inline.

CREATE TABLE IF NOT EXISTS whatsapp_business_accounts (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  country_code      TEXT NOT NULL,                 -- 'NO' | 'BR'
  phone_number      TEXT NOT NULL UNIQUE,
  waba_id           TEXT NOT NULL,
  phone_number_id   TEXT NOT NULL UNIQUE,          -- Metas ID, brukes til inbound-routing
  display_name      TEXT,
  quality_rating    TEXT,
  messaging_tier    TEXT,
  active            BOOLEAN DEFAULT TRUE,
  system_user_token TEXT NOT NULL,                 -- ⚠️ klartekst — bør krypteres
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  waba_account_id TEXT NOT NULL REFERENCES whatsapp_business_accounts(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  project_id      TEXT,
  customer_phone  TEXT NOT NULL,
  customer_name   TEXT,
  language        TEXT DEFAULT 'no',
  status          TEXT DEFAULT 'active',
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (waba_account_id, customer_phone)
);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  conversation_id TEXT NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  direction       TEXT CHECK (direction IN ('inbound','outbound')),
  message_body    TEXT,
  template_name   TEXT,
  meta_message_id TEXT,
  status          TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_conv_user      ON whatsapp_conversations (user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_conv_waba      ON whatsapp_conversations (waba_account_id);
CREATE INDEX IF NOT EXISTS idx_wa_msg_conv       ON whatsapp_messages (conversation_id, created_at DESC);

-- Defensive FK-er til users/projects (kan feile hvis type-mismatch → hoppes over).
DO $$
BEGIN
  ALTER TABLE whatsapp_conversations
    ADD CONSTRAINT wa_conv_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'wa_conv user FK hoppet over: %', SQLERRM; END $$;

DO $$
BEGIN
  ALTER TABLE whatsapp_conversations
    ADD CONSTRAINT wa_conv_project_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'wa_conv project FK hoppet over: %', SQLERRM; END $$;
