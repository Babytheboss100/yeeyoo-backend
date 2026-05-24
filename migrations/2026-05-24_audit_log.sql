-- Migrasjon: audit_log — metadata-only revisjonsspor (HOLO Sesjon J).
-- Kjøres MANUELT i Render Shell. Idempotent.
--
-- Lagrer KUN metadata (aldri meldingsinnhold eller tokens). Telefonnumre
-- maskeres i koden før de havner her. Ingen FK/cascade — sporet skal overleve
-- sletting av relaterte rader.

CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT,
  action        TEXT NOT NULL,              -- f.eks. whatsapp.send | facebook.post | instagram.post
  resource_type TEXT,
  resource_id   TEXT,
  metadata      JSONB DEFAULT '{}'::jsonb,  -- ikke-sensitiv metadata
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_user_created ON audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action       ON audit_log (action);
