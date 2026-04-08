import pg from 'pg'
import dotenv from 'dotenv'
dotenv.config()

const { Pool } = pg
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
})

export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      vipps_sub TEXT UNIQUE,
      auth_provider TEXT DEFAULT 'email',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      plan TEXT DEFAULT 'free',
      status TEXT DEFAULT 'active',
      current_period_end TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS projects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      color TEXT DEFAULT '#5555ff',
      tone TEXT DEFAULT 'profesjonell',
      audience TEXT DEFAULT 'investorer og næringslivsfolk',
      keywords TEXT DEFAULT '',
      about TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS posts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
      platform TEXT NOT NULL,
      content TEXT NOT NULL,
      ai_model TEXT DEFAULT 'claude',
      hashtags TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      scheduled_at TIMESTAMPTZ,
      published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      expires_at TIMESTAMPTZ,
      platform_user_id TEXT,
      platform_username TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, platform)
    );

    -- Team members
    CREATE TABLE IF NOT EXISTS team_members (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      invited_by UUID REFERENCES users(id),
      email TEXT NOT NULL,
      role TEXT DEFAULT 'editor',
      status TEXT DEFAULT 'pending',
      invite_token TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(project_id, email)
    );

    -- Notifications
    CREATE TABLE IF NOT EXISTS notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT DEFAULT 'info',
      read BOOLEAN DEFAULT false,
      link TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Onboarding flag
    ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_done BOOLEAN DEFAULT false;

    -- OAuth fields
    ALTER TABLE users ADD COLUMN IF NOT EXISTS vipps_sub TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT DEFAULT 'email';
    DO $$ BEGIN ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL; EXCEPTION WHEN OTHERS THEN NULL; END $$;

    -- Email verification
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token TEXT;

    -- Admin flag
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;

    -- Invite whitelist (closed beta)
    CREATE TABLE IF NOT EXISTS invite_whitelist (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      approved BOOLEAN DEFAULT false,
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- SEO profiles
    CREATE TABLE IF NOT EXISTS seo_profiles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      project_id UUID REFERENCES projects(id) ON DELETE CASCADE UNIQUE,
      company_name TEXT NOT NULL,
      company_offer TEXT DEFAULT '',
      industry TEXT NOT NULL,
      locations TEXT DEFAULT '',
      target_customer TEXT DEFAULT '',
      competitors TEXT DEFAULT '',
      keywords JSONB DEFAULT '[]',
      meta_title TEXT DEFAULT '',
      meta_description TEXT DEFAULT '',
      blog_ideas JSONB DEFAULT '[]',
      action_checklist JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Login tracking
    CREATE TABLE IF NOT EXISTS login_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      country TEXT,
      method TEXT DEFAULT 'email',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

  `)

  // Smart planlegger table — definitive version with ALL columns
  console.log('  Creating smartplan_businesses...')
  await pool.query(`
    CREATE TABLE IF NOT EXISTS smartplan_businesses (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id TEXT,
      url TEXT,
      name TEXT,
      description TEXT,
      industry TEXT,
      target_audience TEXT,
      tone TEXT,
      goals TEXT,
      summary TEXT,
      raw_data TEXT,
      analysis JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  // Ensure all columns exist on existing tables
  await pool.query(`ALTER TABLE smartplan_businesses ADD COLUMN IF NOT EXISTS summary TEXT`)
  await pool.query(`ALTER TABLE smartplan_businesses ADD COLUMN IF NOT EXISTS raw_data TEXT`)
  await pool.query(`ALTER TABLE smartplan_businesses ADD COLUMN IF NOT EXISTS industry TEXT`)
  await pool.query(`ALTER TABLE smartplan_businesses ADD COLUMN IF NOT EXISTS target_audience TEXT`)
  await pool.query(`ALTER TABLE smartplan_businesses ADD COLUMN IF NOT EXISTS tone TEXT`)
  await pool.query(`ALTER TABLE smartplan_businesses ADD COLUMN IF NOT EXISTS goals TEXT`)
  await pool.query(`ALTER TABLE smartplan_businesses ADD COLUMN IF NOT EXISTS description TEXT`)
  console.log('  smartplan_businesses OK')

  // Add smartplan_business_id column to posts
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE posts ADD COLUMN smartplan_business_id TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
  `)
  console.log('  posts.smartplan_business_id OK')

  // Bootstrap admin user
  const ADMIN_EMAIL = 'heljarprebensen@gmail.com'
  await pool.query(
    `INSERT INTO users (id, name, email, auth_provider, is_admin, email_verified, onboarding_done)
     VALUES (gen_random_uuid(), 'Heljar', $1, 'google', true, true, true)
     ON CONFLICT (email) DO UPDATE SET is_admin = true, email_verified = true`,
    [ADMIN_EMAIL]
  )
  console.log(`✅ Admin bootstrap: ${ADMIN_EMAIL}`)
  // Ensure admin is on the whitelist too
  await pool.query(
    `INSERT INTO invite_whitelist (id, email, approved, note)
     VALUES (gen_random_uuid(), LOWER($1), true, 'Admin bootstrap')
     ON CONFLICT (email) DO UPDATE SET approved=true`,
    [ADMIN_EMAIL]
  )

  console.log('✅ DB ready')
}
