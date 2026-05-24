// Engangs-migrering: krypter eksisterende klartekst-tokens i DB.
// Kjør i Render Shell: node scripts/encrypt-tokens.js
//
// Idempotent: allerede krypterte rader (enc:v1:…) hoppes over. Trygt å kjøre
// flere ganger, og før plattform-tabellene finnes (manglende tabell = hopp).

import { pool } from '../src/db.js'
import { encryptToken, isEncrypted } from '../src/lib/tokenCrypto.js'

const TARGETS = [
  { table: 'whatsapp_business_accounts', col: 'system_user_token' },
  { table: 'meta_accounts', col: 'access_token' },
  { table: 'linkedin_accounts', col: 'access_token' },
  { table: 'x_accounts', col: 'access_token' },
  { table: 'x_accounts', col: 'refresh_token' },
  { table: 'tiktok_accounts', col: 'access_token' },
  { table: 'tiktok_accounts', col: 'refresh_token' },
  { table: 'pinterest_accounts', col: 'access_token' },
  { table: 'pinterest_accounts', col: 'refresh_token' },
]

async function run() {
  if (!process.env.META_TOKEN_ENCRYPTION_KEY) {
    console.error('META_TOKEN_ENCRYPTION_KEY mangler — avbryter')
    process.exit(1)
  }
  let total = 0
  for (const { table, col } of TARGETS) {
    try {
      const { rows } = await pool.query(`SELECT id, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL`)
      let n = 0
      for (const row of rows) {
        if (isEncrypted(row.v)) continue
        await pool.query(`UPDATE ${table} SET ${col} = $1 WHERE id = $2`, [encryptToken(row.v), row.id])
        n++
        total++
      }
      console.log(`✓ ${table}.${col}: kryptert ${n}`)
    } catch (e) {
      if (/does not exist/i.test(e.message)) console.log(`– ${table} finnes ikke enda, hopper`)
      else console.error(`✗ ${table}.${col}:`, e.message)
    }
  }
  console.log(`Ferdig. ${total} token(s) kryptert.`)
  await pool.end()
}

run()
