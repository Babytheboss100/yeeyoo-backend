import pg from 'pg'
import dotenv from 'dotenv'
import { databaseSslForRuntime, databaseUrlForRuntime, strictTestMode, verifyStrictTestDatabase } from './services/databaseStartup.js'
dotenv.config()

const { Pool } = pg
export const pool = new Pool({
  connectionString: databaseUrlForRuntime(process.env),
  ssl: databaseSslForRuntime(process.env),
  max: Number(process.env.DB_POOL_MAX || 10),
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 10000),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
  allowExitOnIdle: process.env.NODE_ENV === 'test',
})

// Post-ALTER verifikasjon mot information_schema.columns. Fanger silent
// failures der ALTER returnerte uten å kaste, men endringen ikke faktisk
// persisted (typisk: type-mismatch på DEFAULT-uttrykk, eller en annen
// prosess som overstyrer schemaet senere). Returnerer true hvis state matcher
// forventning; logger ⚠️ WARNING og returnerer false hvis ikke. Stille på
// suksess slik at normal log-output forblir uendret.
async function verifyColumn(table, column, { hasDefault = null } = {}) {
  const { rows } = await pool.query(
    `SELECT column_default FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  )
  if (rows.length === 0) {
    console.warn(`  ⚠️ WARNING: ${table}.${column} mangler i schema — ALTER tok ikke effekt`)
    return false
  }
  if (hasDefault === true && !rows[0].column_default) {
    console.warn(`  ⚠️ WARNING: ${table}.${column} har ingen DEFAULT — SET DEFAULT tok ikke effekt`)
    return false
  }
  return true
}

export async function initDB() {
  if(strictTestMode(process.env)){
    const client=await pool.connect()
    try{return await verifyStrictTestDatabase(client)}finally{client.release()}
  }
  try {
    const dbUrl = new URL(process.env.DATABASE_URL || '')
    console.log(`📡 DB connecting to: ${dbUrl.hostname}${dbUrl.pathname} (port ${dbUrl.port || 5432})`)
  } catch {
    console.log('⚠️ DATABASE_URL not set or invalid')
  }
  // ─── Block 1: smartplan_businesses (independent, no FK deps) ────────────────
  try {
    console.log('Creating smartplan_businesses table...')
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
      );
    `)
    console.log('smartplan_businesses table ready!')
  } catch (e) {
    console.error('smartplan_businesses CREATE failed:', e.message)
  }

  // ─── Block 2: Core tables ─────────────────────────────────────────────────
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
      user_id TEXT UNIQUE,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      plan TEXT DEFAULT 'free',
      status TEXT DEFAULT 'active',
      current_period_end TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS projects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT,
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
      user_id TEXT,
      project_id TEXT,
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
      user_id TEXT,
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
      project_id TEXT,
      user_id TEXT,
      invited_by TEXT,
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
      user_id TEXT,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT DEFAULT 'info',
      read BOOLEAN DEFAULT false,
      link TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Onboarding flag
    ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_done BOOLEAN DEFAULT false;

    -- Image URL on posts
    ALTER TABLE posts ADD COLUMN IF NOT EXISTS image_url TEXT;

    -- OAuth fields
    ALTER TABLE users ADD COLUMN IF NOT EXISTS vipps_sub TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT DEFAULT 'email';
    DO $$ BEGIN ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL; EXCEPTION WHEN OTHERS THEN NULL; END $$;

    -- Email verification
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token TEXT;

    -- Phone & address
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT;

    -- Admin flag
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;

    -- Sist valgte prosjekt (cross-device persistens for ProjectSwitcher)
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_project_id TEXT;

    -- Streak gamification (HOLO Sesjon J)
    ALTER TABLE users ADD COLUMN IF NOT EXISTS streak_count INTEGER DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_post_at TIMESTAMPTZ;

    -- Referral code on users
    ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20) UNIQUE;

    -- Invite whitelist (closed beta)
    CREATE TABLE IF NOT EXISTS invite_whitelist (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      approved BOOLEAN DEFAULT false,
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Invite codes
    CREATE TABLE IF NOT EXISTS invite_codes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code TEXT UNIQUE NOT NULL,
      email TEXT,
      used BOOLEAN DEFAULT false,
      used_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- SEO profiles
    CREATE TABLE IF NOT EXISTS seo_profiles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT,
      project_id TEXT UNIQUE,
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

    -- Referrals / Affiliate
    CREATE TABLE IF NOT EXISTS referrals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      referrer_id TEXT NOT NULL,
      referred_id TEXT NOT NULL,
      commission DECIMAL(10,2) DEFAULT 0,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Login tracking
    CREATE TABLE IF NOT EXISTS login_logs (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id TEXT,
      email TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      country TEXT,
      method TEXT DEFAULT 'email',
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

  // ─── Explicit column/default migrations (run every startup) ─────────────
  await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS image_url TEXT`)
  console.log('  ✓ posts.image_url ensured')
  await verifyColumn('posts', 'image_url')
  // login_logs.id eies av Prisma (TEXT NOT NULL uten DB-default). ALTER ... SET
  // DEFAULT gen_random_uuid() har ikke faktisk effekt i prod (verifisert via
  // \d login_logs); INSERT genererer nå id i kode via crypto.randomUUID().
  await pool.query(`ALTER TABLE notifications ALTER COLUMN id SET DEFAULT gen_random_uuid()`)
  console.log('  ✓ notifications.id default ensured')

  // Fix id defaults on tables that may have UUID type but need text-compatible defaults
  await pool.query(`ALTER TABLE notifications ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`)
  await pool.query(`ALTER TABLE posts ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`)
  await pool.query(`ALTER TABLE projects ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`)
  await pool.query(`ALTER TABLE subscriptions ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`)
  await pool.query(`ALTER TABLE oauth_tokens ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`)
  await pool.query(`ALTER TABLE team_members ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`)
  await pool.query(`ALTER TABLE seo_profiles ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`)
  console.log('  id defaults fixed OK')
  // Verifiser at SET DEFAULT-ALTER-ne faktisk persisted (Prisma-eide tabeller
  // kan ha overstyrt schemaet). ⚠️ WARNING logges kun ved avvik.
  for (const t of ['notifications', 'posts', 'projects', 'subscriptions', 'oauth_tokens', 'team_members', 'seo_profiles']) {
    await verifyColumn(t, 'id', { hasDefault: true })
  }

  // Ensure all columns exist on smartplan_businesses
  await pool.query(`ALTER TABLE smartplan_businesses ADD COLUMN IF NOT EXISTS summary TEXT`)
  await pool.query(`ALTER TABLE smartplan_businesses ADD COLUMN IF NOT EXISTS raw_data TEXT`)
  await pool.query(`ALTER TABLE smartplan_businesses ADD COLUMN IF NOT EXISTS industry TEXT`)
  await pool.query(`ALTER TABLE smartplan_businesses ADD COLUMN IF NOT EXISTS target_audience TEXT`)
  await pool.query(`ALTER TABLE smartplan_businesses ADD COLUMN IF NOT EXISTS tone TEXT`)
  await pool.query(`ALTER TABLE smartplan_businesses ADD COLUMN IF NOT EXISTS goals TEXT`)
  await pool.query(`ALTER TABLE smartplan_businesses ADD COLUMN IF NOT EXISTS description TEXT`)
  console.log('  smartplan_businesses OK')
  for (const c of ['summary', 'raw_data', 'industry', 'target_audience', 'tone', 'goals', 'description']) {
    await verifyColumn('smartplan_businesses', c)
  }

  // posts.smartplan_business_id fjernet (mai 2026): smartplan-koblinger lagres
  // nå via posts.business_id (Prisma-eid FK). Kolonnen ble aldri opprettet i
  // prod (ALTER feilet stille mot Prisma-eid posts-tabell), og koden bruker
  // ikke lenger smartplan_business_id.

  // Verify smartplan_businesses exists before proceeding
  const { rows: tableCheck } = await pool.query(
    `SELECT to_regclass('public.smartplan_businesses') AS tbl`
  )
  if (!tableCheck[0]?.tbl) {
    throw new Error('smartplan_businesses table was not created — aborting startup')
  }
  console.log('  smartplan_businesses verified ✓')

  // ─── One-time data migration: smartplan_businesses → businesses ──────────
  // Konsoliderer Yeeyoo's gamle backend-eide smartplan_businesses-tabell inn
  // i Prisma's businesses (sannheten). Idempotent via ON CONFLICT — re-kjøring
  // er trygt. to_regclass-guarden gjør blokken til no-op når legacy-tabellen
  // ikke eksisterer (f.eks. fresh DBs) eller når den er droppet i cleanup-PR.
  // Skipper rader uten url siden Prisma's businesses.url er NOT NULL.
  const { rows: legacyExists } = await pool.query(
    `SELECT to_regclass('public.smartplan_businesses') AS tbl`
  )
  if (legacyExists[0]?.tbl) {
    const migration = await pool.query(`
      INSERT INTO businesses (id, user_id, url, name, industry, summary, raw_data, analysis, created_at, updated_at)
      SELECT id, user_id, url, name, industry, summary, raw_data,
             CASE WHEN analysis IS NOT NULL THEN analysis::text ELSE NULL END,
             created_at, NOW()
      FROM smartplan_businesses
      WHERE url IS NOT NULL
      ON CONFLICT (id) DO NOTHING
    `)
    if (migration.rowCount > 0) {
      console.log(`  Migrated ${migration.rowCount} smartplan_businesses → businesses`)
    }
  }

  // Bootstrap admin user
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'heljarprebensen@gmail.com'
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

  // Seed invite codes if table is empty
  const { rows: codeCount } = await pool.query('SELECT COUNT(*) as count FROM invite_codes')
  if (parseInt(codeCount[0].count) === 0) {
    const codes = []
    for (let i = 1; i <= 20; i++) codes.push(`YEEYOO-BETA${String(i).padStart(2, '0')}`)
    for (let i = 1; i <= 5; i++) codes.push(`YEEYOO-VIP${String(i).padStart(2, '0')}`)
    for (const code of codes) {
      await pool.query('INSERT INTO invite_codes (code) VALUES ($1) ON CONFLICT (code) DO NOTHING', [code])
    }
    console.log(`🎟️ Seeded ${codes.length} invite codes`)
  }

  console.log('✅ DB ready')
}
