# Pharmacy + Refill Slice — Implementation Status

**Date:** 2026-05-05 (Sprint 33-34 amendment 2026-05-08)
**Status:** ⛔ **BLOCKED — Skeleton only at v0.1** (unchanged through Sprint 33-34)
**Final commit:** Sprint 1 / TLC-001 landing commit
**Sprint 33-34 amendment final commit:** no code change — pharmacy module remained at v0.1 skeleton through the SI-006 reserve-then-execute cycle (Pharmacy is in the BLOCKED-aware skeleton group; SI-006 closure work targeted only the implementation-complete slices: forms-intake / identity / consent / async-consult / tenant-config).
**Blocker:** [SI-001 MedicationRequest schema gap](./SI-001-MedicationRequest-Schema-Gap.md) (still OPEN at the spec corpus governance layer; Promotion Ledger entry P-011 pending)
**CI status:** ✅ Green (skeleton only — `/health` returns BLOCKED state; `pharmacy-plugin-wiring.test.ts` continues to pass)

---

## Sprint 33-34 amendment (2026-05-08)

The Pharmacy + Refill slice is in the **BLOCKED-aware skeleton group** alongside Subscription (also blocked on SI-001) and Med Interaction Engine (blocked on slice PRD ratification). Sprint 33-34 SI-006 closure work targeted only the implementation-complete slices, so pharmacy was untouched at the source level.

What did NOT change in Sprint 33-34:
- Module structure (`src/modules/pharmacy/{plugin,routes,internal/types}.ts`) remains as authored at Sprint 1 / TLC-001
- `routes.ts` continues to mount `/health` returning `{ status: 'ok', module: 'pharmacy', state: 'BLOCKED' }` and slice-specific endpoints returning `{ status: 503 }`
- `pharmacy-plugin-wiring.test.ts` plugin smoke test continues to pass
- No schema migrations authored (still BLOCKED on SI-001 — CDM v1.2 §3.5 lists Pharmacy entities #18-#22 in inventory but provides NO §4 field-level expansion)

What benefited indirectly from Sprint 33-34:
- The cross-cutting `audit_dedupe_markers` table (`migrations/022_audit_dedupe_markers.sql` from Sprint 34 PR #49) is available for any future Category A audit emitter — pharmacy will use this primitive when the slice unblocks.
- The reserve-then-execute idempotency pattern codified in PROJECT_CONVENTIONS r5 §3.7-§3.9 + the `withIdempotency` + `withIdempotentExecution` helpers in `src/lib/` are ready-to-use for state-changing handlers — pharmacy will follow this pattern from day 1 of slice implementation.
- The Group F source-grep lockdown in `tests/integration/idempotency-helper.test.ts` extends automatically when pharmacy handlers land (no per-slice lockdown wiring needed).

**On-resume sequencing when SI-001 closes:** the EHBG §10b sprint plan still holds — schema authoring against ratified CDM §4 expansion → repos with composite UNIQUE + composite FK pattern (PROJECT_CONVENTIONS r5 §1.1) → service layer + state-machine guards (per State Machines v1.1 §6 if/when promoted to active state) → HTTP handlers using the reserve-then-execute pattern → audit + domain emitters → cross-tenant isolation tests + idempotency replay regression. Estimated 40-50 commits depending on Codex per-PR adversarial review iteration depth.

### Spec references for the amendment

- `docs/SI-006-Idempotency-Reserve-Then-Execute-Redesign.md` v0.3 "Implementation Closure" (the redesign that pharmacy will inherit when it unblocks)
- `docs/PROJECT_CONVENTIONS.md` r5 §3.7 / §3.8 / §3.9 + §1.1 + §5.11 + §5.12 (the patterns pharmacy slice work will follow)
- `docs/BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` r5 (cross-slice cumulative state)

---

## Summary

Pharmacy + Refill slice (Slice 4 of 17 per EHBG §10b sprint plan) is at **v0.1 skeleton** state. The module directory and Fastify plugin wiring are in place so:

1. Module boundary (ADR-001 modular monolith) is established now — no future ambiguity about where Pharmacy code lives
2. App-level registration is stable — `pharmacyPlugin` registered in `src/app.ts`
3. Branded ID types are available for downstream slices that hold typed FK references (`MedicationRequestId`, `RefillId`, `DispensingId`, `ShipmentId`, `ProductCatalogId`)
4. Operator monitoring sees an explicit BLOCKED state on `GET /v0/pharmacy/health` — the module does NOT pretend to be production-ready

**Schema authoring is paused on SI-001.** CDM v1.2 §3.5 lists Pharmacy entities #18-#22 in the inventory but provides NO §4 field-level expansion. Per EHBG §7, engineering does not author canonical schema. The full implementation lands when SI-001 closes (Promotion Ledger entry P-011 in the spec corpus).

---

## What's at v0.1

```
src/modules/pharmacy/
├── README.md                    # ⛔ BLOCKED ON SI-001 banner + resume path
├── index.ts                     # Public-interface re-exports (branded IDs + plugin)
├── plugin.ts                    # Fastify plugin (registers /v0/pharmacy)
├── routes.ts                    # Only /health mounted; explicit BLOCKED state
└── internal/
    └── types.ts                 # Branded IDs only — NO row-shape interfaces
```

| Surface               | State                                                             |
| --------------------- | ----------------------------------------------------------------- |
| Module directory      | ✅ Created                                                        |
| Fastify plugin        | ✅ Wired in `src/app.ts`                                          |
| `/health` endpoint    | ✅ Returns `{status, module, blocked: 'SI-001', blocked_message}` |
| Migrations            | ⛔ BLOCKED                                                        |
| Row-shape interfaces  | ⛔ BLOCKED                                                        |
| Repositories          | ⛔ BLOCKED                                                        |
| Services              | ⛔ BLOCKED                                                        |
| HTTP handlers         | ⛔ BLOCKED                                                        |
| Audit emitters        | ⛔ BLOCKED                                                        |
| Domain-event emitters | ⛔ BLOCKED                                                        |
| Tests                 | ✅ Plugin-wiring smoke (1 case); rest BLOCKED                     |

---

## Test coverage at v0.1

| Test file                      | Cases | Layer                                |
| ------------------------------ | ----- | ------------------------------------ |
| pharmacy-plugin-wiring.test.ts | 1     | HTTP smoke (BLOCKED state assertion) |
| **Total Pharmacy v0.1**        | **1** | —                                    |

When SI-001 closes, schema + repo + service + HTTP + cross-tenant + audit-chain + idempotency + domain-events test layers all need to land — estimated 30-40 new test cases per Slice 1-3 precedent.

---

## Resume path when SI-001 closes

1. **Pull spec corpus.** Verify CDM v1.2 §4.16 MedicationRequest is now expanded AND State Machines v1.1 §19 + AUDIT_EVENTS v5.2 + DOMAIN_EVENTS v5.2 carry the canonical entries.
2. **Author migration 020+** for medication_requests + refills + dispensing + shipments + product_catalog tables per the canonical CDM §4.
3. **Add row-shape interfaces** in `internal/types.ts`.
4. **Build out** repos → services → HTTP handlers, mirroring Slice 3 (Consent) patterns:
   - Same-tx audit emission via `txCallback`
   - PHI-safe view pattern (`tenant_id` strip per §17 + C3)
   - Idempotency on every state-changing endpoint (IDEMPOTENCY v5.1)
   - RLS layer-1 + app-layer tenant filter (I-023)
   - Cross-tenant isolation regression test
   - I-003 audit-chain regression for new audit events
   - Domain-event emission alongside audit + outbox-landing tests
5. **Update this status doc** with the v1.0 surface details, removing BLOCKED markers as each layer lands.
6. **Promote to "implementation-complete"** state mirroring Slices 1-3.

Estimated 30-40 commits to reach Pharmacy slice implementation-complete after SI-001 closes.

---

## Architecture decisions at skeleton-time

- **Branded IDs ship at v0.1** — they are identifier hygiene, not schema. Downstream slices (Subscription will reference `MedicationRequestId` via FK) can compile clean before SI-001 closes.
- **No row-shape interfaces** — those ARE schema. Authoring them now would violate EHBG §7 + risk drift if SI-001 closure adjusts the field set.
- **`/health` returns BLOCKED** — not 200/`{status: ok}` — so monitoring + dashboards distinguish "module up" from "module ready for production". The BLOCKED message carries the SI doc reference for operator triage.
- **No real route surface** — `/v0/pharmacy/prescriptions`, `/v0/pharmacy/refills`, etc. return Fastify's default 404. Premature wiring would surface a half-built module to test infrastructure that may then mask defects when real handlers land.

---

## Spec references

- [Pharmacy + Refill Slice PRD v2.1](../../telecheckONE/Telecheck%20Master%20Bundle%20FINAL%20US%20REGION%20BASELINE/Telecheck_Pharmacy_Refill_Slice_PRD_v2_1.md) — target spec
- CDM v1.2 §3.5 — entity inventory (entities #18-#22)
- EHBG §10b Sprint 4 (weeks 9-10) — original sprint target
- EHBG §7 — engineering implements per CDM, does not author
- ADR-001 — modular monolith (boundary + public-interface discipline)
- [SI-001 MedicationRequest schema gap](./SI-001-MedicationRequest-Schema-Gap.md) — the blocker
