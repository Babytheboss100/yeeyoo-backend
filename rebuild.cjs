/**
 * rebuild.cjs — gjenoppbygg yeeyoo_db-skjemaet fra repoets migrasjonsfiler.
 * Kjør i yeeyoo-backend sitt Render Shell:  node rebuild.cjs
 *
 * Kloner ingenting — leser migrations/*.sql som ALLEREDE ligger i repoet,
 * og kjører hver fil mot DATABASE_URL. Alle filene er idempotente
 * (CREATE TABLE/INDEX IF NOT EXISTS, FK i DO $$ ... EXCEPTION ... $$),
 * så scriptet er trygt å kjøre flere ganger.
 *
 * backend sin initDB() kjører kjernetabellene ved boot; denne henter inn
 * HOLO-tabellene (radar_feeds, *_accounts, inbox, moodboards, osv.) som
 * bare finnes i SQL-filene, pluss de tre users-kolonnene for sikkerhets skyld.
 *
 * CommonJS (.cjs) med vilje så den kjører selv om package.json er ESM.
 * Hver fil sendes som ÉN query (ikke splittet på ';') — flere SQL-filer
 * inneholder dollar-quotede DO $$-blokker med semikolon inni.
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// De tre kolonnene initDB normalt legger til — tas med eksplisitt som backstop.
const EXTRA_ALTERS = [
  ['users.last_project_id', 'ALTER TABLE users ADD COLUMN IF NOT EXISTS last_project_id TEXT'],
  ['users.streak_count',    'ALTER TABLE users ADD COLUMN IF NOT EXISTS streak_count INTEGER DEFAULT 0'],
  ['users.last_post_at',    'ALTER TABLE users ADD COLUMN IF NOT EXISTS last_post_at TIMESTAMPTZ'],
];

(async () => {
  console.log('===== YEEYOO DB-REBUILD =====');

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // matcher prod-poolen i src/db.js
  });

  try {
    await client.connect();
  } catch (e) {
    console.error('❌ Klarte ikke koble til DB:', e.message);
    process.exit(1);
  }

  // Bekreft hvilken DB vi faktisk skriver til (samme sjekk som diag.cjs).
  try {
    const { rows } = await client.query(
      'SELECT current_database() AS db, inet_server_addr() AS server_ip'
    );
    console.log(`→ Skriver til DB: ${rows[0].db}  (server ${rows[0].server_ip})`);
  } catch (e) {
    console.log('→ (kunne ikke lese current_database():', e.message, ')');
  }

  // Finn migrasjonsfilene.
  let files;
  try {
    files = fs.readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.toLowerCase().endsWith('.sql'))
      .sort(); // deterministisk rekkefølge (lik dato-prefiks → alfabetisk)
  } catch (e) {
    console.error(`❌ Fant ikke migrations-mappen (${MIGRATIONS_DIR}):`, e.message);
    await client.end();
    process.exit(1);
  }

  if (files.length === 0) {
    console.error(`❌ Ingen .sql-filer i ${MIGRATIONS_DIR}`);
    await client.end();
    process.exit(1);
  }

  console.log(`\nFant ${files.length} migrasjonsfiler. Kjører i rekkefølge:\n`);

  const failed = [];
  let ok = 0;

  // 1) Kjør hver .sql-fil som én batch.
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await client.query(sql);
      console.log(`  ✓ ${file}`);
      ok++;
    } catch (e) {
      console.log(`  ✗ ${file}  → ${e.message}`);
      failed.push({ file, error: e.message });
    }
  }

  // 2) De tre eksplisitte ALTER-ene (idempotente).
  console.log('\nEksplisitte users-kolonner:');
  for (const [label, sql] of EXTRA_ALTERS) {
    try {
      await client.query(sql);
      console.log(`  ✓ ${label}`);
      ok++;
    } catch (e) {
      console.log(`  ✗ ${label}  → ${e.message}`);
      failed.push({ file: label, error: e.message });
    }
  }

  // 3) Sammendrag.
  console.log('\n===== SAMMENDRAG =====');
  console.log(`OK:    ${ok}`);
  console.log(`Feil:  ${failed.length}`);
  if (failed.length) {
    console.log('\nFeilende:');
    for (const f of failed) console.log(`  - ${f.file}: ${f.error}`);
  }
  console.log('\n===== FERDIG =====');

  await client.end();
  process.exit(failed.length ? 1 : 0);
})();
