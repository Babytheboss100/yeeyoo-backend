# Schema and migration authority review

## Current mutation mechanisms

1. `src/db.js:initDB()` performs startup `CREATE TABLE`, `ALTER TABLE`, constraint drops, defaults, legacy data copy, admin bootstrap and invite-code seeding.
2. `migrate.js` is a separate one-off script that creates `smartplan_businesses` and adds the obsolete `posts.smartplan_business_id` column.
3. Dated SQL files under `migrations/` now have an ordered, checksummed migration ledger/runner (`scripts/migrate.js`).
4. Historical comments refer to an external Prisma-owned schema, but no Prisma schema or migration history exists in this repository.

## Risks found

- Core IDs are declared as UUID while most relationship columns are TEXT. Startup compensates by dropping user foreign keys, leaving referential integrity unenforced.
- `initDB()` mutates schema on every process start and catches or suppresses some DDL failures. Application instances can race and a partially migrated database can still serve traffic.
- `migrate.js` contradicts current comments and can recreate an obsolete column.
- Project deletion behavior is inconsistent: provider/media project FKs generally use `ON DELETE SET NULL`, while several project relationships have no FK at all. Tenant-owned records may become unscoped or orphaned.
- `email_integrations` is unique by `(user_id, provider)`, so one user cannot bind different provider accounts per project.
- Tony/business/SEO/core posts tables are created at runtime rather than represented by a complete authoritative dated baseline. New AI jobs now have a dated migration, but historical AI/media tables remain fragmented.
- Several migration `DO` blocks deliberately swallow type/FK errors, so a successful script run does not prove the intended constraints exist.

## Proposed authority

Use ordered, immutable SQL migrations plus a database migration ledger as the only schema authority. Run them as an explicit release step against an isolated database first, inside a transaction where PostgreSQL permits. Application startup should validate the minimum schema version and fail closed; it should not create, alter, drop, migrate or seed schema/data.

Transition safely in three stages:

1. Snapshot the real non-production schema and add a reconciled baseline migration that preserves current data and records every table/index/constraint.
2. Normalize IDs in dedicated expand/backfill/validate/contract migrations. Add `NOT VALID` FKs first, repair orphans, then `VALIDATE CONSTRAINT`; never cast/drop in one release.
3. Move bootstrap/seeding to explicit idempotent administrative scripts, disable `migrate.js`, then remove runtime DDL only after disposable-PostgreSQL and staging verification prove parity.

## Phase 6 migration

`2026-08-12_inspo_project_scope.sql` is additive and idempotent. It adds project scope to saved Inspo while retaining legacy rows through a separate partial unique index. A project FK is intentionally deferred until the projects ID type is reconciled; route-level `requireProject` enforcement is active now.

## Phase 8 transition

`2026-05-23_core_baseline.sql` is the first additive empty-database baseline. It deliberately standardizes new core IDs as TEXT so existing TEXT relationships can receive real foreign keys without destructive casts. Existing databases retain their current types because every baseline operation is `IF NOT EXISTS`; UUID-to-TEXT normalization remains an explicit expand/backfill/validate/contract project.

`src/services/migrationRunner.js` serializes runners with a PostgreSQL advisory lock, applies immutable dated SQL files in filename order, records SHA-256 checksums in `schema_migrations`, and wraps every unapplied file in its own transaction. A changed already-applied migration fails closed. `migrate.js` is now only a compatibility delegate to that authority; it no longer recreates the obsolete `posts.smartplan_business_id` column.

Deterministic test-only cross-tenant data is in `scripts/seed-test.js`. It refuses execution unless `NODE_ENV=test`. Run an isolated disposable database with:

1. `npm run db:migrate`
2. `NODE_ENV=test npm run db:seed:test`
3. the backend/browser E2E harness

Never point these commands at production. The migration CLI additionally refuses a production environment without a deliberate acknowledgement.

## Verification status

Runner/ledger/idempotency behavior is unit-tested without a database. No database URL was used and no production system was contacted. Full SQL execution and browser E2E still require a disposable PostgreSQL runtime; absence of one is a verification blocker, not a reason to run against a shared database.
