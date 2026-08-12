import pg from 'pg'

if (process.env.NODE_ENV !== 'test' || !process.env.YEEYOO_TEST_DATABASE_URL) throw new Error('Refusing to seed without NODE_ENV=test and an explicit YEEYOO_TEST_DATABASE_URL')
const pool = new pg.Pool({ connectionString: process.env.YEEYOO_TEST_DATABASE_URL, ssl: false, max: 1 })
const users = [
  ['00000000-0000-4000-8000-000000000001', 'Tenant Alpha', 'alpha@yeeyoo.invalid'],
  ['00000000-0000-4000-8000-000000000002', 'Tenant Beta', 'beta@yeeyoo.invalid']
]
try {
  await pool.query('BEGIN')
  for (const [id, name, email] of users) await pool.query('INSERT INTO users(id,name,email,email_verified) VALUES($1,$2,$3,TRUE) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email', [id, name, email])
  await pool.query(`INSERT INTO projects(id,user_id,name,slug) VALUES
    ('10000000-0000-4000-8000-000000000001',$1,'Alpha Project A1','alpha-a1'),
    ('10000000-0000-4000-8000-000000000002',$1,'Alpha Project A2','alpha-a2'),
    ('20000000-0000-4000-8000-000000000001',$2,'Beta Project B1','beta-b1')
    ON CONFLICT(id) DO UPDATE SET user_id=EXCLUDED.user_id,name=EXCLUDED.name,slug=EXCLUDED.slug`, [users[0][0], users[1][0]])
  await pool.query('COMMIT')
} catch (error) { await pool.query('ROLLBACK'); throw error } finally { await pool.end() }
