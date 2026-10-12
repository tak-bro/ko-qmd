# Database Migrations Playbook

## Introduction

Changing a production database schema without downtime is one of the hardest tasks in backend engineering. This playbook describes how we plan, write, test, and roll out database schema migrations safely.

## Principles of Safe Schema Changes

Every database schema migration must be backward compatible with the currently deployed application version. The golden rule: never deploy code and schema changes that depend on each other in a single step.

A database schema migration rollback plan is required for every change. Reversible migrations use `up` and `down` scripts; irreversible ones (like dropping a column) require a documented forward-fix instead.

## The Expand-Contract Migration Pattern

For zero downtime rewrites, we use the expand-contract migration pattern:
1. Expand: add the new column or table alongside the old one (e.g. add `user_email_citext` next to `user_email`).
2. Migrate: dual-write to both locations and backfill historical rows in batches.
3. Contract: switch all reads to the new location, then drop the old column in a later release.

This pattern spreads a single logical change across three deployable steps so old and new code can run side by side.

## Backfill Scripts

Large data rewrites use a backfill script that is idempotent and batched. Each batch updates at most 1000 rows per deployment window and records its progress in a `backfill_progress` table, so a failed run can resume safely.

Example backfill script deployment checklist:
- Run the idempotent batch against a staging snapshot first.
- Throttle to off-peak hours to avoid replica lag.
- Monitor replication delay during the batch deployment.

## Migration Tooling

We manage migrations with versioned SQL files (`migrations/00123_add_orders_index.sql`). Each file has a checksum recorded in the `schema_migrations` table so applied migrations are never re-run.

Naming conventions:
- `add_` prefix for new columns, tables, or indexes.
- `drop_` prefix for removals (requires two-release approval).
- `alter_` prefix for type changes and constraint updates.

## Testing Migrations

Every migration is tested against a production-sized snapshot in CI:
- Apply the migration forward, run the test suite, then roll back.
- Measure lock duration; anything holding an `ACCESS EXCLUSIVE` lock for more than 2 seconds needs a concurrent-index approach.
- For Postgres, prefer `CREATE INDEX CONCURRENTLY` to avoid blocking writes.

## Rollback and Recovery

If a migration fails mid-deploy, the rollback procedure is:
1. Halt the deploy pipeline and freeze further migrations.
2. Run the tested `down` script or forward-fix, never hand-edited SQL.
3. Verify row counts and application health checks before reopening deploys.

Point-in-time recovery (PITR) snapshots are taken before every major migration as a last resort.
