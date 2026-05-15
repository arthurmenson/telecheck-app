# F-4 deploy runbook — migrations 029 + 030 + audit-emitter rollout

This document captures the operational sequencing required to deploy the F-4 (platform_admin audit attribution) closure safely without aborting in-flight audit emissions.

## Background

F-4 closes the cross-tenant platform_admin audit-attribution gap. Pre-F-4, `audit_records.actor_tenant_id` did not exist; the emitter envelope carried the field in-memory but the INSERT didn't project it. Migration 029 adds the column + new hash function + new emitter expectations. Migration 030 adds the DB-level CHECK constraint that enforces non-blank actor_tenant_id for non-system human/admin actor types.

## The schema-skew window

The default deploy sequence is:

1. Apply migration 029 (DB schema change)
2. Deploy app code with the new emitter (writes actor_tenant_id)
3. Apply migration 030 (CHECK constraint enforcement)

During the gap between (1) and (2), the schema has the new column, but old app code still emits audits without it — the column is nullable so old emitters continue to work (write NULL). Once (2) completes, new emitters populate it. Once (3) runs, the CHECK enforces non-blank for human actor types going forward.

## Hazard window — DO NOT deploy app code before migration 029

The new app emitter's INSERT references `actor_tenant_id` unconditionally (per Codex F-4 R11 HIGH analysis). If the app is deployed BEFORE migration 029 lands, every audit emission fails with "column actor_tenant_id does not exist" — and because audit emission is same-transaction, this aborts user-visible admin/clinical actions.

**Enforcement:** the CI release pipeline MUST gate app-code deploy on migration 029 having landed first. Without an explicit migration → app sequencing gate (e.g., a pre-deploy schema check that exits non-zero unless `audit_records.actor_tenant_id` exists), this is a deploy-order race that ops needs to enforce by convention.

If app is rolled back AFTER migration 029, that's safe (old emitter writes NULL into the nullable column).

If migration 029 is rolled back AFTER app is deployed, the new app emitter breaks. Roll back app FIRST, then migration.

## Direct-INSERT call sites (must update before migration 030)

Migration 030's CHECK constraint covers `actor_records_actor_tenant_id_required_for_human_actors` for new rows. Any direct INSERT into audit_records that bypasses emitAudit must populate actor_tenant_id for non-system actor types.

Inventory of direct INSERT paths (per Codex F-4 R11 MEDIUM):
- `tests/integration/audit-chain-walker.test.ts` — direct INSERT in walker fixtures. UPDATED at R7 to populate hash_schema_version=2; actor_type='system' in these fixtures means the row is exempt from the 030 CHECK constraint.
- `tests/invariants/i003-audit-append-only.test.ts` — may have direct INSERTs; needs audit before 030 lands.
- `tests/integration/tenant-isolation-rls.test.ts` — same.

Before applying migration 030, ops MUST run a grep across the test suite + app source for `INSERT INTO audit_records` and confirm every site either:
- uses actor_type='system' or 'ai_workload', OR
- populates actor_tenant_id with a non-blank value.

## Pre-030 verification query

Before applying migration 030, run against production / staging:

```sql
SELECT COUNT(*) AS recent_nullattr_count
  FROM audit_records
 WHERE actor_type NOT IN ('system', 'ai_workload')
   AND (actor_tenant_id IS NULL OR btrim(actor_tenant_id) = '')
   AND recorded_at > NOW() - INTERVAL '1 hour';
```

Expected result: 0 rows. If non-zero, the new emitter is not yet deployed everywhere — STOP and triage before continuing.

## VALIDATE CONSTRAINT (separate maintenance op)

Migration 030's CHECK is NOT VALID. Legacy pre-029 rows are exempt; new rows must pass. A separate maintenance window can run:

```sql
ALTER TABLE audit_records
  VALIDATE CONSTRAINT audit_records_actor_tenant_id_required_for_human_actors;
```

This requires every existing row in the table to satisfy the constraint — which means a one-time backfill of legacy human-actor rows that have NULL actor_tenant_id. The backfill plan + execution is its own runbook (out of scope for this PR).

## Break-glass operational continuity

`set_break_glass_context` signature changed in 029. Migration 029 preserves the 4-arg signature as a TOMBSTONE that raises a clear `feature_not_supported` error with HINT directing operators to the 5-arg signature.

External runbooks / DBA scripts that still invoke the 4-arg variant will get actionable feedback rather than "function does not exist." This is critical during incident response when break-glass access is needed.

Once all operational clients have migrated to the 5-arg signature, a future migration can DROP the 4-arg tombstone.

## Rollback sequencing

- Roll back **app code** first (if deployed)
- Roll back **migration 030** (drops the CHECK constraint)
- Roll back **migration 029** (drops column + restores pre-029 hash function + 4-arg break-glass)

After rollback, schema is contract-identical to pre-029.
