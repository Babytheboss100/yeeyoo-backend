import pg from 'pg'
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

try {
  console.log('Running migration...')
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
      analysis JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  console.log('✅ smartplan_businesses table created')

  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE posts ADD COLUMN smartplan_business_id TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
  `)
  console.log('✅ posts.smartplan_business_id column added')

  await pool.end()
  console.log('Done.')
  process.exit(0)
} catch (e) {
  console.error('Migration failed:', e.stack)
  process.exit(1)
}
