/**
 * diag.cjs — engangs-diagnostikk for Render Shell.
 * Kjør i yeeyoo-backend sitt Render Shell:  node diag.cjs
 *
 * Bekrefter (a) hvilken database prod-backenden FAKTISK er koblet til,
 * (b) om design365-raden finnes i invite_whitelist, og (c) om 24.mai-
 * migrasjonene faktisk er kjørt mot denne DB-en.
 *
 * CommonJS med vilje (.cjs) så den kjører selv om package.json er ESM.
 * Hver spørring har egen try/catch — en manglende tabell stopper ikke resten.
 */
const { Client } = require('pg');

// ── Maskert host-info fra DATABASE_URL (passord skjult) ──────────────
function maskedDbUrl() {
  try {
    const u = new URL(process.env.DATABASE_URL || '');
    const pw = u.password ? '***' : '(ingen)';
    return {
      host: u.hostname,
      port: u.port || '(default)',
      database: u.pathname.replace(/^\//, ''),
      user: u.username || '(ingen)',
      password: pw,
      sammendrag: `${u.protocol}//${u.username}:${pw}@${u.hostname}:${u.port}${u.pathname}`,
    };
  } catch (e) {
    return { feil: `Kunne ikke parse DATABASE_URL: ${e.message}` };
  }
}

async function q(client, label, sql) {
  try {
    const res = await client.query(sql);
    console.log(`\n── ${label} ──`);
    console.table(res.rows);
    return res;
  } catch (e) {
    console.log(`\n── ${label} ──`);
    console.log(`  ⚠️  FEIL: ${e.message}`);
    return null;
  }
}

(async () => {
  console.log('===== YEEYOO DB-DIAGNOSTIKK =====');
  console.log('NODE_ENV:', process.env.NODE_ENV);
  console.log('\n── DATABASE_URL (maskert) ──');
  console.log(maskedDbUrl());

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // matcher prod-poolen i src/db.js
  });

  try {
    await client.connect();
  } catch (e) {
    console.error('\n❌ Klarte ikke koble til DB:', e.message);
    process.exit(1);
  }

  // 1) Hvilken DB + server-IP er vi faktisk på?
  await q(client, '1. current_database() + inet_server_addr()',
    'SELECT current_database(), inet_server_addr() AS server_ip, inet_server_port() AS server_port');

  // 2) Finnes design365-raden?
  await q(client, "2. invite_whitelist WHERE email ILIKE '%design365%'",
    "SELECT * FROM invite_whitelist WHERE email ILIKE '%design365%'");

  // 3) Hvor mange rader totalt i invite_whitelist?
  await q(client, '3. count(*) invite_whitelist',
    'SELECT count(*)::int AS antall FROM invite_whitelist');

  // 4) Er 24.mai-kolonnene på plass i users?
  await q(client, "4. users-kolonner (last_project_id, streak_count)",
    "SELECT column_name FROM information_schema.columns " +
    "WHERE table_name = 'users' AND column_name IN ('last_project_id','streak_count')");

  // 5) Finnes radar_feeds-tabellen?
  await q(client, "5. to_regclass('radar_feeds')",
    "SELECT to_regclass('public.radar_feeds') AS radar_feeds");

  await client.end();
  console.log('\n===== FERDIG =====');
})();
