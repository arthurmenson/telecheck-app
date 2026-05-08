# `docs/` — pointer to spec corpus + repo-local engineering notes

## Spec corpus is canonical

The authoritative specification corpus is **NOT in this repo**. It lives at the sibling repo `arthurmenson/telecheckONE` under:

```
../telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE/
```

That bundle is the source of truth for:

- **What** the product is (Master Platform PRD v1.10)
- **Which version of any artifact** is canonical (Artifact Registry v2.10)
- **Architecture decisions** (ADR Set v1.0 + Addenda 016–019, 020–025, 026, 027, 028, 029)
- **Endpoint contracts** (OpenAPI v0.2 — 187 endpoints, 22 modules)
- **Entity schemas** (Canonical Data Model v1.2 — 48 active + 7 reserved-future)
- **State machines** (State Machines v1.1 — 18 active + 4 reserved-future transitions)
- **Cross-cutting runtime contracts** (Contracts Pack v5.2)
- **Per-feature specs** (17 slice PRDs)
- **Design authority** (Design Implementation Contract v1.1 Canonical for development; Patient mock v7 binding visual reference)

When code in this repo and the spec corpus disagree, **the spec corpus wins**. Open a Spec Issue (per `Telecheck_Engineering_Handoff_Build_Guide_v1_3.md` §12 SI/DSI escalation) and either:

1. Update the spec to match the code (if the spec is stale) — done in the spec repo
2. Update the code to match the spec (if the code is wrong) — done here

Never silently fork the two.

## Source-of-truth hierarchy (top wins on conflict)

Per `Telecheck_Contracts_Pack_v5_00_SOURCE_OF_TRUTH.md` (preserved at v5.1):

1. **Platform Invariants** — 25 (I-001..I-031); non-negotiable
2. **Architecture Decision Records** — 28 ADRs
3. **Cross-cutting contracts** — Contracts Pack v5.2
4. **Master Platform PRD v1.10**
5. **Slice PRDs** — 17 active
6. **Engineering specs** — CDM v1.2, State Machines v1.1, OpenAPI v0.2, System Architecture v1.2
7. **Experience specs** — Design System v1.1, IA docs, DIC v1.1 Canonical
8. **Operations** — Ghana Launch Playbook v1.2, Operational Readiness Tracker v1.5

## Repo-local engineering notes

This `docs/` directory may host:

- **Architecture sketches** — only as scratch / proposal docs that funnel into ADRs
- **Build sequence map** — concrete sprint-to-task mapping (filled in by `general-purpose` agent)
- **Onboarding** — local dev setup, IDE config, runbooks specific to this code repo

Anything that becomes canonical guidance gets promoted **to the spec repo** via the Spec Issue process — not preserved here as a divergent source.

## Layout

```
docs/
├── README.md                                  # this file
├── SCRUM_OPERATING_MODEL.md                   # ⭐ Scrum framework: roles, cadence, DoD, ceremonies
├── PRODUCT_BACKLOG.md                         # ⭐ Prioritized story backlog (single source of truth)
├── SPRINT_1_PLAN.md                           # Sprint 1 plan (in progress)
├── AUTONOMOUS_TURN_SUMMARY_2026-05-05.md      # Cumulative summary of the multi-day autonomous turn
├── FORMS_INTAKE_SLICE_STATUS_2026-05-05.md    # Slice 1 (Forms-Intake + JWT-migration) handoff
├── IDENTITY_SLICE_STATUS_2026-05-05.md        # Slice 2 (Identity + JWT) handoff
├── CONSENT_SLICE_STATUS_2026-05-05.md         # Slice 3 (Consent + Delegation) handoff
├── TENANT_CONFIG_FOUNDATION_STATUS_2026-05-05.md  # Tenant-config foundation (CDM §4.2-§4.6)
├── SI-001-MedicationRequest-Schema-Gap.md     # Open Spec Issue blocking Slice 4
├── SI-002-AUDIT_EVENTS-Placeholder-Ratification.md  # Open SI — 31 placeholder action IDs
├── SI-003-DOMAIN_EVENTS-Placeholder-Ratification.md # Open SI — 28 placeholder event-type strings
├── build-sequence.md                          # (filled in by Plan agent) concrete sprint-to-task mapping
├── onboarding.md                              # (added when first slice begins) local dev setup
└── adr-local/                                 # (optional) repo-local ADRs covering pure-implementation
                                               # decisions that don't rise to platform-architecture level
```

## Implementation status (post-Sprint-34 SI-006 closure, 2026-05-08)

| Slice (per EHBG §10b)            | Status                     | Pointer                                         |
| -------------------------------- | -------------------------- | ----------------------------------------------- |
| Slice 1 — Forms-Intake v2.1      | ✅ Implementation-complete (Sprint 33-34 amendment landed) | `FORMS_INTAKE_SLICE_STATUS_2026-05-05.md` |
| Slice 2 — Identity & Auth + JWT  | ✅ Implementation-complete (Sprint 33-34 amendment landed) | `IDENTITY_SLICE_STATUS_2026-05-05.md`     |
| Slice 3 — Consent + Delegation   | ✅ Implementation-complete (Sprint 33-34 amendment landed) | `CONSENT_SLICE_STATUS_2026-05-05.md`      |
| Slice — Async Consult            | ✅ Implementation-complete | `BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` r5 §2 (full HTTP coverage added Sprint 34 PR #51) |
| Slice 4 — Pharmacy + Refill v2.1 | ⛔ Blocked on **SI-001**   | `SI-001-MedicationRequest-Schema-Gap.md`        |
| Slices 5-17 (other)              | Not started                | per EHBG §10b sprint plan                       |
| **Foundation: tenant-config**    | ✅ Implementation-complete (read paths); admin-write 503-stubbed pending Admin Backend v1.1 | `TENANT_CONFIG_FOUNDATION_STATUS_2026-05-05.md` |

**Sprint 33-34 SI-006 closure landed across 9 PRs (#43–#49 + #51).** Reserve-then-execute idempotency redesign is now the canonical pattern for state-changing handlers; legacy onSend cache-write hook removed under Group F source-grep lockdown. Cross-cutting `audit_dedupe_markers` (PR #49 + migration 022) closes the deferred crash-window duplicate-Category-A-audit HIGH. See:

- `SI-006-Idempotency-Reserve-Then-Execute-Redesign.md` v0.3 "Implementation Closure" section
- `BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` r5 (cumulative state)
- `PROJECT_CONVENTIONS.md` r5 §3.7 / §3.8 / §3.9 + §5.11 / §5.12 (codified patterns)

**Foundation note:** the tenant-config layer (CDM §4.2-§4.6) is NOT a slice from the EHBG sprint plan — it's foundational utility infrastructure that every CCR-driven downstream slice depends on. It was unblocked alongside Slice 3 because none of its entities reference `medication_requests`. Schema, repos, CCR resolver service, and a patient-app `GET /v0/tenant-config/me` bootstrap endpoint are live. AdapterConfig + TenantUser service layers are scaffolded at the schema level but their service/HTTP wiring belongs with Admin Backend slice v1.1 (encryption-at-rest + operator auth).

**Cross-cutting hardening landed alongside Slice 3:** cross-tenant isolation tests for consent + delegation services (I-023 / I-024 / I-025); I-025 tenant-blindness regression for HTTP error envelopes; full HTTP coverage of all 12 routes mounted under `/v0/consent`; service-layer direct integration tests for both consent-service and delegation-service; idempotency replay regression for consent endpoints; I-003 audit-chain regression for the 8 Slice 3 lifecycle events.

**Cross-cutting hardening landed Sprint 33-34:** IDEMPOTENCY v5.1 contract HTTP coverage added to identity (devices §4 / login §5 / registration §5 — PRs #60 / #61 / #62) + forms-intake templates (PR #63); audit-dedupe documented-limitation regression marker (PR #59); CI activates openapi-conformance test via spec-corpus clone (PR #64); README refreshes for src/lib + migrations + src/modules (PRs #65 / #66 / #67).

## When in doubt

Read `CLAUDE.md` at the repo root. It is the engineering-Claude entry point.
