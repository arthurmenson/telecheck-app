# Pharmacy + Refill Slice — Implementation Status

**Date:** 2026-05-05
**Status:** ⛔ **BLOCKED — Skeleton only at v0.1**
**Final commit:** Sprint 1 / TLC-001 landing commit
**Blocker:** [SI-001 MedicationRequest schema gap](./SI-001-MedicationRequest-Schema-Gap.md)
**CI status:** ✅ Green (skeleton only — `/health` returns BLOCKED state)

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
