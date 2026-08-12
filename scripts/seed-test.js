import pg from 'pg'

if (process.env.NODE_ENV !== 'test' || !process.env.DATABASE_URL) throw new Error('Refusing to seed outside an explicit test environment')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false, max: 1 })
const users = [
  ['00000000-0000-4000-8000-000000000001', 'Tenant Alpha', 'alpha@yeeyoo.invalid'],
  ['00000000-0000-4000-8000-000000000002', 'Tenant Beta', 'beta@yeeyoo.invalid']
]
try {
  await pool.query('BEGIN')
  for (const [id, name, email] of users) await pool.query('INSERT INTO users(id,name,email,email_verified) VALUES($1,$2,$3,TRUE) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email', [id, name, email])
  await pool.query(`INSERT INTO projects(id,user_id,name,slug) VALUES
    ('10000000-0000-4000-8000-000000000001',$1,'Alpha Project','alpha'),
    ('20000000-0000-4000-8000-000000000002',$2,'Beta Project','beta')
    ON CONFLICT(id) DO UPDATE SET user_id=EXCLUDED.user_id,name=EXCLUDED.name,slug=EXCLUDED.slug`, [users[0][0], users[1][0]])
  await pool.query('COMMIT')
} catch (error) { await pool.query('ROLLBACK'); throw error } finally { await pool.end() }
