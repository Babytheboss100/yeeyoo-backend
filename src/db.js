import pg from 'pg'
import dotenv from 'dotenv'
dotenv.config()

const { Pool } = pg
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
})

export async function initDB() {
  try {
    const dbUrl = new URL(process.env.DATABASE_URL || '')
    console.log(`📡 DB connecting to: ${dbUrl.hostname}${dbUrl.pathname} (port ${dbUrl.port || 5432})`)
  } catch {
    console.log('⚠️ DATABASE_URL not set or invalid')
  }
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
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      country TEXT,
      method TEXT DEFAULT 'email',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Smart planlegger
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
    );

  `)

  // Drop all user_id FK constraints — users.id is TEXT but FKs expect UUID
  console.log('  Dropping user_id FK constraints...')
  await pool.query(`ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_user_id_fkey`)
  await pool.query(`ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_user_id_fkey`)
  await pool.query(`ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_user_id_fkey`)
  await pool.query(`ALTER TABLE oauth_tokens DROP CONSTRAINT IF EXISTS oauth_tokens_user_id_fkey`)
  await pool.query(`ALTER TABLE team_members DROP CONSTRAINT IF EXISTS team_members_user_id_fkey`)
  await pool.query(`ALTER TABLE team_members DROP CONSTRAINT IF EXISTS team_members_invited_by_fkey`)
  await pool.query(`ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_user_id_fkey`)
  await pool.query(`ALTER TABLE seo_profiles DROP CONSTRAINT IF EXISTS seo_profiles_user_id_fkey`)
  await pool.query(`ALTER TABLE login_logs DROP CONSTRAINT IF EXISTS login_logs_user_id_fkey`)
  console.log('  FK constraints dropped OK')

  // Fix id defaults on tables that may have UUID type but need text-compatible defaults
  await pool.query(`ALTER TABLE login_logs ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`)
  await pool.query(`ALTER TABLE notifications ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`)
  await pool.query(`ALTER TABLE posts ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`)
  await pool.query(`ALTER TABLE projects ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`)
  await pool.query(`ALTER TABLE subscriptions ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`)
  await pool.query(`ALTER TABLE oauth_tokens ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`)
  await pool.query(`ALTER TABLE team_members ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`)
  await pool.query(`ALTER TABLE seo_profiles ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`)
  console.log('  id defaults fixed OK')

  // Ensure all columns exist on smartplan_businesses
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

  // Verify smartplan_businesses exists before proceeding
  const { rows: tableCheck } = await pool.query(
    `SELECT to_regclass('public.smartplan_businesses') AS tbl`
  )
  if (!tableCheck[0]?.tbl) {
    throw new Error('smartplan_businesses table was not created — aborting startup')
  }
  console.log('  smartplan_businesses verified ✓')

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
