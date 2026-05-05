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
├── IDENTITY_SLICE_STATUS_2026-05-05.md        # Slice 2 (Identity + JWT) handoff
├── CONSENT_SLICE_STATUS_2026-05-05.md         # Slice 3 (Consent + Delegation) handoff
├── SI-001-MedicationRequest-Schema-Gap.md     # Open Spec Issue blocking Slice 4
├── build-sequence.md                          # (filled in by Plan agent) concrete sprint-to-task mapping
├── onboarding.md                              # (added when first slice begins) local dev setup
└── adr-local/                                 # (optional) repo-local ADRs covering pure-implementation
                                               # decisions that don't rise to platform-architecture level
```

## Implementation status (post-Consent-slice landing)

| Slice (per EHBG §10b)            | Status                     | Pointer                                                         |
| -------------------------------- | -------------------------- | --------------------------------------------------------------- |
| Slice 1 — Forms-Intake v2.1      | ✅ Implementation-complete | (status doc not authored — see git log + tests/forms-intake-\*) |
| Slice 2 — Identity & Auth + JWT  | ✅ Implementation-complete | `IDENTITY_SLICE_STATUS_2026-05-05.md`                           |
| Slice 3 — Consent + Delegation   | ✅ Implementation-complete | `CONSENT_SLICE_STATUS_2026-05-05.md`                            |
| Slice 4 — Pharmacy + Refill v2.1 | ⛔ Blocked on **SI-001**   | `SI-001-MedicationRequest-Schema-Gap.md`                        |
| Slices 5-17                      | Not started                | per EHBG §10b sprint plan                                       |

**Cross-cutting hardening landed alongside Slice 3:** cross-tenant isolation tests for consent + delegation services (I-023 / I-024 / I-025); I-025 tenant-blindness regression for HTTP error envelopes; full HTTP coverage of all 12 routes mounted under `/v0/consent`; service-layer direct integration tests for both consent-service and delegation-service.

## When in doubt

Read `CLAUDE.md` at the repo root. It is the engineering-Claude entry point.
