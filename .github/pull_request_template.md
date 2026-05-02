<!--
Telecheck PR template.

Fill in every section that applies. Delete sections that don't (e.g., a docs-only PR can
delete Migration discipline + Audit emission). Reviewers will reject a PR that ignores the
relevant sections without explanation.

Spec corpus: arthurmenson/telecheckONE — pin which version you read.
-->

## Summary

<!-- 1–3 sentences on what changes and why. Reviewer should be able to decide whether to read further from this paragraph alone. -->

## Spec references

<!-- Cite the exact spec artifacts you read while building this. Without this, the reviewer can't tell if you read the right slice. -->

- Slice PRD:
- ADR(s):
- Invariants touched (I-XXX):
- OpenAPI endpoints touched:
- State machines touched:

## Tests added

<!-- Per CLAUDE.md workflow step 8: happy path + tenant-isolation + state-machine guards + applicable invariant tests. -->

- [ ] Unit tests (`*.test.ts` alongside source)
- [ ] Integration tests (cross-module, real Postgres)
- [ ] Coverage adequate for changed code

## Tenant-isolation case

<!-- Required for any PR touching PHI tables or tenant-scoped state. Per tests/README.md: create resource as Tenant A, attempt access as Tenant B, assert tenant-blind error envelope per I-025. -->

- [ ] Cross-tenant access denial test added (Tenant A creates → Tenant B denied with tenant-blind error per I-025)
- [ ] N/A — explain why:

## Audit emission

<!-- Per Contracts Pack v5.2 AUDIT_EVENTS. Audit table is append-only (I-003). Tenant_id always present (I-027). -->

- [ ] Actions emitting audit events:
- [ ] Sentinel handling for null/unknown/reserved values verified
- [ ] `ai_workload_type` + `autonomy_level` populated where applicable (per I-012 envelope-population rule)
- [ ] Append-only preserved (no UPDATE/DELETE on audit_records)
- [ ] N/A — explain why:

## State machine guards

<!-- Per State Machines v1.1. Critical: I-029 6-condition gate (research.export_completed) and I-012 reject-unless three-clause rule (prescription/refill/medication-order execution). -->

- [ ] Transitions honored (no states reached without guard checks)
- [ ] I-029 gate verified (if research export touched)
- [ ] I-012 reject-unless verified (if prescribing path touched)
- [ ] Rejection emits the expected `<action_class>.execution_rejected` audit event
- [ ] N/A — explain why:

## Migration discipline

<!-- Per migrations/README.md. RLS mandatory on every PHI-touching table. Rollback companion required. -->

- [ ] Migration sequentially numbered (no skip-numbers)
- [ ] RLS policy attached to every new tenant-scoped PHI table
- [ ] Rollback companion at `migrations/rollback/<N>_rollback.sql`
- [ ] No DELETE/UPDATE paths added to `audit_records`
- [ ] Engineering Lead reviewed
- [ ] N/A — explain why:

## Breaking changes

<!-- API surface, schema, audit envelope, domain event envelope — anything that downstream consumers (other modules, future code, ops tooling) might bind to. -->

- [ ] None
- [ ] Listed below with migration path:

## Rollback plan

<!-- How do we get back to green if this is bad in production? -->

---

## Reviewer checklist

<!-- Reviewer ticks these explicitly during review; do not pre-tick as the author. -->

- [ ] Spec corpus version pinned (matches CLAUDE.md "Canonical versions")
- [ ] No forbidden glossary aliases (`prescription` for `medication_request`, `chatbot` for `Mode 1/2`, `customer` for `tenant` — per Contracts Pack v5.2 GLOSSARY)
- [ ] No bare-`Heros` strings used as tenant or operator identifiers (per Master PRD v1.10 §17 + Glossary v5.2 C3 brand structure — operating tenants are `Telecheck-{country}`; consumer DBA sourced from `tenant.consumer_dba`)
- [ ] No invariants relaxed (especially I-003 audit append-only, I-019 crisis detection, I-023 tenant isolation, I-025 error envelope, I-027 audit envelope tenant context, I-029 research export gate)
- [ ] Audit append-only preserved (no UPDATE/DELETE paths on `audit_records`)
- [ ] Cross-module data access goes through module public interface (`src/modules/<name>/index.ts`), not direct DB queries (per ADR-001 modular monolith)
- [ ] `country_of_care` / CCR keys not hardcoded (per I-009)
