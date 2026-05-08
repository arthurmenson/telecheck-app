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
├── README.md                                              # this file
├── 000_extensions.sql                                     # uuid-ossp, pgcrypto, pg_trgm
├── 001_tenants.sql                                        # tenants table; per-tenant KMS key references
├── 002_audit_chain.sql                                    # immutable audit_records with hash chain
├── 003_rls_helpers.sql                                    # session variable setters, RLS helper functions
├── 004_domain_events_outbox.sql                           # outbox pattern for DOMAIN_EVENTS v5.2
├── 005_idempotency_keys.sql                               # tenant-scoped idempotency table
├── 006_forms_intake.sql                                   # forms-intake slice schema
├── 007_audit_records_platform_check_backfill.sql          # audit_records platform-scope check backfill
├── 008_forms_submission_in_progress_uniqueness.sql        # one in-progress submission per (tenant, deployment, patient)
├── 009_forms_snapshot_one_per_submission.sql              # one snapshot row per submission
├── 010_program_id_widen_to_text.sql                       # program_id column type widen
├── 011_actor_columns_widen_to_text.sql                    # actor_id column type widen
├── 012_accounts.sql                                       # identity slice — accounts table + uq_account_tenant_phone
├── 013_sessions.sql                                       # identity slice — sessions table
├── 014_otp.sql                                            # identity slice — OTP challenges + lockouts
├── 015_auth_devices.sql                                   # identity slice — auth_device table
├── 016_consent.sql                                        # consent slice — consents + consent_versions
├── 017_delegations.sql                                    # consent slice — delegations + delegation_scopes
├── 018_tenant_config.sql                                  # tenant-config — adapter_configs + ccr_configs
├── 019_adapter_configs_tenant_users.sql                   # tenant-config — tenant_users + adapter_configs FK
├── 020_async_consult.sql                                  # async-consult slice — consults + consult_events
├── 021_async_consult_tenant_boundary_constraints.sql      # async-consult — composite UNIQUE + FK fix-forward (Codex async-consult-r2 HIGH closure)
├── 022_audit_dedupe_markers.sql                           # Sprint 34 SI-006 audit-dedupe — cross-cutting Category A dedupe table
└── rollback/
    ├── 000_rollback.sql
    ├── 001_rollback.sql
    ├── ...
    └── 022_rollback.sql                                   # matched-pair coverage for every forward migration
```

## Status

**Foundation + slice schemas landed across Sprints 1-34.** 23 forward migrations (000-022) and 23 matched rollback companions. Notable post-bootstrap migrations:

- **006:** forms-intake slice schema (the largest single migration; covers forms_template + forms_template_version + forms_deployment + forms_variant + forms_submission + resume_state)
- **012-015:** identity slice (accounts, sessions, OTP, auth_devices)
- **016-017:** consent + delegation
- **018-019:** tenant-config (admin-write paths still 503-stubbed pending Admin Backend slice v1.1 ratification)
- **020-021:** async-consult slice schema + Codex-driven fix-forward for cross-tenant boundary constraints
- **022:** Sprint 34 PR #49 — `audit_dedupe_markers` (cross-cutting Category A audit-dedupe primitive); closes the Sprint 33 PR-F2 r4 deferred HIGH on crash-window duplicate audits

The `database-integration-expert` agent owned the bootstrap migrations 000-005; subsequent migrations were authored as part of slice-implementation sprints with Codex per-PR adversarial review.

## Spec references

- `Telecheck_Canonical_Data_Model_v1_2.md` — entity schemas (DO NOT diverge; flag SI/DSI escalation if needed)
- `Telecheck_Contracts_Pack_v5_00_INVARIANTS.md` — I-003 audit append-only, I-023 tenant isolation three-layer, I-027 audit envelope tenant context
- `Telecheck_ADR_Set_v1_0.md` Addendum 020–025 — multi-tenancy + country config foundational decisions
- `Telecheck_Contracts_Pack_v5_00_AUDIT_EVENTS.md` — audit envelope schema (v5.2)
- `Telecheck_Contracts_Pack_v5_00_DOMAIN_EVENTS.md` — domain event envelope schema (v5.2)
- `Telecheck_Contracts_Pack_v5_00_IDEMPOTENCY.md` — idempotency key handling (v5.1)
