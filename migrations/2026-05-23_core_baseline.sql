-- Additive core baseline for a disposable/empty database. TEXT identifiers
-- intentionally match the existing relationship columns; ID normalization is
-- a later expand/backfill/contract operation, never an in-place cast here.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  vipps_sub TEXT UNIQUE,
  google_sub TEXT UNIQUE,
  auth_provider TEXT NOT NULL DEFAULT 'email',
  onboarding_done BOOLEAN NOT NULL DEFAULT FALSE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  verify_token TEXT,
  phone_number TEXT,
  address TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  last_project_id TEXT,
  streak_count INTEGER NOT NULL DEFAULT 0,
  last_post_at TIMESTAMPTZ,
  referral_code VARCHAR(20) UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  color TEXT DEFAULT '#5555ff', tone TEXT DEFAULT 'profesjonell',
  audience TEXT DEFAULT '', keywords TEXT DEFAULT '', about TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, slug)
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  platform TEXT NOT NULL, content TEXT NOT NULL, ai_model TEXT DEFAULT 'claude',
  hashtags TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', image_url TEXT,
  scheduled_at TIMESTAMPTZ, published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL, name TEXT, industry TEXT, summary TEXT, raw_data TEXT,
  analysis TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, user_id TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE, stripe_customer_id TEXT, stripe_subscription_id TEXT, plan TEXT DEFAULT 'free', status TEXT DEFAULT 'active', current_period_end TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS oauth_tokens (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, platform TEXT NOT NULL, access_token TEXT, refresh_token TEXT, expires_at TIMESTAMPTZ, platform_user_id TEXT, platform_username TEXT, updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(user_id, platform));
CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, message TEXT NOT NULL, type TEXT DEFAULT 'info', read BOOLEAN DEFAULT FALSE, link TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS invite_whitelist (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, email TEXT UNIQUE NOT NULL, approved BOOLEAN DEFAULT FALSE, note TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS invite_codes (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, code TEXT UNIQUE NOT NULL, email TEXT, used BOOLEAN DEFAULT FALSE, used_by TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS seo_profiles (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, project_id TEXT UNIQUE REFERENCES projects(id) ON DELETE CASCADE, company_name TEXT NOT NULL, company_offer TEXT DEFAULT '', industry TEXT NOT NULL, locations TEXT DEFAULT '', target_customer TEXT DEFAULT '', competitors TEXT DEFAULT '', keywords JSONB DEFAULT '[]', meta_title TEXT DEFAULT '', meta_description TEXT DEFAULT '', blog_ideas JSONB DEFAULT '[]', action_checklist JSONB DEFAULT '[]', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
