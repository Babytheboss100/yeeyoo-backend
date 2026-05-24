-- Migrasjon: ai_usage — per-bruker AI-bruksgrenser + kostnadssporing.
-- Kjøres MANUELT i Render Shell (psql $DATABASE_URL eller `prisma db execute`).
-- Idempotent: trygg å kjøre flere ganger.
--
-- MERK: kolonnen `status` er lagt til utover den opprinnelige spesifikasjonen.
-- Den skiller vellykkede kall ('success', teller mot grensen) fra throttlede
-- kall ('throttled', logges for innsikt men teller IKKE). Uten den ville
-- throttle-logging blåst opp telleren.

CREATE TABLE IF NOT EXISTS ai_usage (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT NOT NULL,
  endpoint    TEXT NOT NULL,              -- tony_chat | brand_dna | smart_planner | seo | seo_competitors
  tokens_in   INTEGER DEFAULT 0,
  tokens_out  INTEGER DEFAULT 0,
  cost_usd    NUMERIC(10,4) DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'success',  -- 'success' | 'throttled'
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_user_created
  ON ai_usage (user_id, created_at DESC);

-- FK til users(id) ON DELETE CASCADE. Defensiv: resten av skjemaet droppet
-- bevisst user_id-FK-er pga TEXT↔UUID-mismatch (se db.js). Hvis users.id er
-- UUID vil denne feile — da hopper vi over uten å avbryte migrasjonen.
DO $$
BEGIN
  ALTER TABLE ai_usage
    ADD CONSTRAINT ai_usage_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;             -- allerede lagt til
  WHEN others THEN RAISE NOTICE 'ai_usage FK hoppet over: %', SQLERRM;
END $$;
