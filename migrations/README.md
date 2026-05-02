# `migrations/` — sequentially numbered SQL migrations

## Discipline

- **Sequentially numbered** (`000_extensions.sql`, `001_tenants.sql`, ...). Skip-numbers forbidden.
- **Reviewed by Engineering Lead** before merge.
- **RLS policies are mandatory** on every PHI-touching table. The `post-edit-tenant-scoped-table` hook (per EHBG §13) validates that any new tenant-scoped table has an RLS policy attached before allowing commit.
- **Audit table is append-only.** Migrations affecting `audit_records` MUST NOT introduce DELETE / UPDATE paths. Pre-write audit-table-protection hook (per EHBG §13) blocks such migrations.
- **Every migration has a rollback companion** at `migrations/rollback/<N>_rollback.sql`. Rollback is reviewed alongside the migration.
- **Schema changes are additive where possible.** Destructive changes (DROP, ALTER COLUMN narrowing) require Engineering Lead + Product Lead sign-off.

## Layout

```
migrations/
├── README.md                  # this file
├── 000_extensions.sql         # uuid-ossp, pgcrypto, pg_trgm
├── 001_tenants.sql            # tenants table; per-tenant KMS key references
├── 002_audit_chain.sql        # immutable audit_records with hash chain
├── 003_rls_helpers.sql        # session variable setters, RLS helper functions
├── 004_domain_events_outbox.sql  # outbox pattern for DOMAIN_EVENTS v5.2
├── 005_idempotency_keys.sql   # tenant-scoped idempotency table
└── rollback/
    ├── 000_rollback.sql
    ├── 001_rollback.sql
    └── ...
```

## Status

**Empty at bootstrap.** The `database-integration-expert` agent in the foundation layer commit drops in migrations 000–005 establishing the foundational schema, RLS policies, hash chain, and outbox pattern.

## Spec references

- `Telecheck_Canonical_Data_Model_v1_2.md` — entity schemas (DO NOT diverge; flag SI/DSI escalation if needed)
- `Telecheck_Contracts_Pack_v5_00_INVARIANTS.md` — I-003 audit append-only, I-023 tenant isolation three-layer, I-027 audit envelope tenant context
- `Telecheck_ADR_Set_v1_0.md` Addendum 020–025 — multi-tenancy + country config foundational decisions
- `Telecheck_Contracts_Pack_v5_00_AUDIT_EVENTS.md` — audit envelope schema (v5.2)
- `Telecheck_Contracts_Pack_v5_00_DOMAIN_EVENTS.md` — domain event envelope schema (v5.2)
- `Telecheck_Contracts_Pack_v5_00_IDEMPOTENCY.md` — idempotency key handling (v5.1)
