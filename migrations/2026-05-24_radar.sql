-- Migrasjon: Yeeyoo Radar (RSS/nyhetsovervåkning, HOLO Sesjon J). Kjøres MANUELT.

CREATE TABLE IF NOT EXISTS radar_feeds (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         TEXT NOT NULL,
  project_id      TEXT,
  type            TEXT DEFAULT 'rss',   -- 'rss' | 'keyword'
  keyword         TEXT,                 -- satt for type='keyword'
  url             TEXT NOT NULL,        -- keyword → Google News RSS-søk
  title           TEXT,
  active          BOOLEAN DEFAULT TRUE,
  last_fetched_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, url)
);

CREATE TABLE IF NOT EXISTS radar_items (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  feed_id      TEXT NOT NULL REFERENCES radar_feeds(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  title        TEXT,
  link         TEXT,
  summary      TEXT,
  guid         TEXT NOT NULL,
  published_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (feed_id, guid)
);

CREATE INDEX IF NOT EXISTS idx_radar_feeds_user ON radar_feeds (user_id);
CREATE INDEX IF NOT EXISTS idx_radar_items_user ON radar_items (user_id, published_at DESC);

DO $$ BEGIN
  ALTER TABLE radar_feeds ADD CONSTRAINT radar_feeds_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'radar_feeds user FK hoppet over: %', SQLERRM; END $$;
