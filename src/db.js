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
      password_hash TEXT NOT NULL,
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
  `)
  console.log('✅ DB ready')
}
