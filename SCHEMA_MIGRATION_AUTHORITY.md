# Schema and migration authority review

## Current mutation mechanisms

1. `src/db.js:initDB()` performs startup `CREATE TABLE`, `ALTER TABLE`, constraint drops, defaults, legacy data copy, admin bootstrap and invite-code seeding.
2. `migrate.js` is a separate one-off script that creates `smartplan_businesses` and adds the obsolete `posts.smartplan_business_id` column.
3. Dated SQL files under `migrations/` define provider, marketing, auth, media, Inbox, Radar and Inspo tables, but the repository has no migration ledger/runner.
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

## Verification status

Static review is complete. No database URL was used and no production system was contacted. Disposable PostgreSQL execution remains required before release; absence of a local isolated PostgreSQL service is a verification blocker, not a reason to run against a shared database.
