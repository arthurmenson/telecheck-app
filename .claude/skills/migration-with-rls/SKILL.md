---
name: migration-with-rls
description: Author a tenant-scoped table migration with the correct schema (tenant_id NOT NULL FK to tenants), Row-Level Security policy (ENABLE + FORCE + tenant_isolation), and rollback companion. Use whenever you create or alter a table that holds tenant-scoped data — which is essentially every clinical, scheduling, pharmacy, billing, or AI table per CDM v1.2.
when_to_invoke: Creating or altering any DB migration. (Edits to migrations/** are gated by Claude Code permissions — engineers will be asked before edits proceed.)
tools_used: Read, Edit, Write, Grep, Glob
---

## When to use this skill

Any migration under `migrations/` that:
- creates a new table holding PHI or any tenant-scoped business data (per CDM v1.2)
- alters an existing tenant-scoped table (add column, add index, change constraint)
- creates an index on a tenant-scoped table (must include `tenant_id` as a leading or trailing column per RLS performance pattern)
- creates a foreign key on a tenant-scoped table (must be tenant-coherent)

**Do NOT touch the `audit_records` table.** Audit is append-only by design (I-003). Schema changes to audit go through Engineering Lead + Platform Privacy Officer + Engineering ADR.

## Read first

Set `${SPEC}` = `${TELECHECK_SPEC_PATH:-../telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE}`.

1. `${SPEC}/Telecheck_Canonical_Data_Model_v1_2.md` for the entity schema (canonical — engineering implements per CDM, does NOT author new schema; flag via §12 SI/DSI escalation if CDM is missing your entity)
2. `${SPEC}/Telecheck_ADR_Set_v1_0.md` ADR-023 (multi-tenancy Model A) and ADR-028 (single physical region, single DB, single schema; tenant isolation by logical means — see also I-028)
3. `${SPEC}/Telecheck_Contracts_Pack_v5_00_INVARIANTS.md` — I-003, I-023, I-027, I-028
4. `${SPEC}/Telecheck_Tenant_Threading_Addendum_v1_0.md` for slice-specific tenant-threading rules

## Workflow

1. **Confirm CDM v1.2 is the source.** Find your entity in CDM §4. Use the field names, types, constraints CDM specifies. If CDM disagrees with the slice PRD, CDM wins per source-of-truth hierarchy.
2. **Name the migration sequentially.** `migrations/NNNN_<verb>_<entity>.sql` — e.g., `migrations/0042_create_research_export.sql`.
3. **Author the up migration.** Required scaffolding for any tenant-scoped table:

   ```sql
   CREATE TABLE <entity> (
     id           TEXT PRIMARY KEY,        -- ULID/UUID per CDM convention
     tenant_id    TEXT NOT NULL REFERENCES tenants(id),
     -- ... entity-specific columns per CDM v1.2 ...
     created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
   );

   ALTER TABLE <entity> ENABLE ROW LEVEL SECURITY;
   ALTER TABLE <entity> FORCE ROW LEVEL SECURITY;

   CREATE POLICY tenant_isolation ON <entity>
     USING (tenant_id = current_setting('app.tenant_id', true))
     WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

   CREATE INDEX <entity>_tenant_id_idx ON <entity> (tenant_id);
   -- additional indexes should include tenant_id either as leading column
   -- (for tenant-scoped queries) or trailing column (for global maintenance queries
   -- run via break-glass) per RLS performance pattern.
   ```

   `current_setting('app.tenant_id', true)` is set per-request by `withTenantContext()`; `true` is the missing_ok flag (returns NULL if not set, which means the policy denies access — fail-closed).

4. **FORCE RLS.** `ENABLE` alone exempts the table owner. `FORCE` does not. Always both.
5. **Author the down migration.** `migrations/NNNN_<verb>_<entity>.down.sql` — drop in reverse order: index → policy → table. Production migrations are forward-only by Engineering Lead policy, but the down companion exists for local dev resets and review-time clarity.
6. **Foreign keys must be tenant-coherent.** A FK from `<entity>.<other_id>` to `<other_entity>.id` is fine — RLS on `<other_entity>` ensures the referenced row is in the same tenant. Do NOT add `<entity>.tenant_id` constraints that try to assert FK + tenant match — RLS handles it. (If the referenced table is a platform-global table like `tenants` itself, no RLS needed there.)
7. **Indexes** — every tenant-scoped table needs at minimum a `(tenant_id)` index. For composite queries (`tenant_id, status`, `tenant_id, created_at`), index lead with `tenant_id`.
8. **Run `npm run migrate:diff`** (when wired) to confirm Prisma's generated diff matches what you wrote. Discrepancy → fix the schema or the migration.
9. **Test.** Add a test in `tests/invariants/` that asserts: (a) inserting a row from tenant A and selecting under tenant B's context returns zero rows; (b) inserting with NULL `tenant_id` is rejected; (c) updating `tenant_id` (which should be immutable per pattern) is rejected.

## Hard rules

- **`tenant_id TEXT NOT NULL REFERENCES tenants(id)`** on every tenant-scoped table. No exceptions.
- **`ENABLE ROW LEVEL SECURITY`** AND **`FORCE ROW LEVEL SECURITY`**. Both. Always.
- **`tenant_isolation` policy** with both `USING` and `WITH CHECK` clauses. The `WITH CHECK` clause prevents a tenant from inserting rows attributed to another tenant.
- **Never modify `audit_records` schema.** I-003 platform-floor.
- **Single physical region, single database, single schema** per ADR-028 + I-028. No per-tenant schemas, no per-tenant databases.
- **`tenant.country_of_care` is immutable post-creation** per I-026. Any migration touching `tenants` that allows `country_of_care` updates must be rejected.
- **The migration file path is gated** by `.claude/settings.json` `permissions.ask` — engineers will be asked to confirm each Edit/Write under `migrations/`.

## Common mistakes

- **`ENABLE` without `FORCE`.** Table owner bypasses RLS. Multi-tenant data leak waiting to happen.
- **Adding `WITH CHECK` only.** Reads then succeed cross-tenant. Need both `USING` and `WITH CHECK`.
- **Tenant ID as `INT` or `UUID`.** Operating-tenant identifier is `TEXT` (`Telecheck-{country}` per Master PRD v1.10 §17 + Glossary v5.2). Code, schema, audit all use TEXT identifiers.
- **Indexing without `tenant_id`.** Queries always filter by tenant; indexes that don't lead with `tenant_id` are unused.
- **Adding a FK constraint to enforce tenant match across tables.** RLS handles it. Adding a redundant CHECK or trigger is more code to maintain and easier to subtly break.
- **Renaming `tenant_id` to `org_id` or `customer_id`.** Forbidden alias per Glossary v5.2. Use `tenant_id`.

## Reporting

- **Migration file:** path + sequence number
- **Entity:** entity name, CDM v1.2 §X.Y citation
- **RLS scaffolding:** confirm ENABLE + FORCE + policy USING + WITH CHECK
- **Indexes added:** list
- **Down migration:** path
- **Test:** path to RLS isolation test
- **Spec issues found:** any divergence between slice PRD and CDM (flag via §12, do not silently fork)
