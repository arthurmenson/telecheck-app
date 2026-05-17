# Pharmacy + Refill Slice — Implementation Status

**Date:** 2026-05-05 (Sprint 33-34 amendment 2026-05-08; **post-SI-001-ratification amendment 2026-05-17 — see top section**)
**Status (2026-05-17):** **SUBSTANTIAL** — MedicationRequest/prescribe surface IMPLEMENTED post-SI-001 ratification (P-011 2026-05-12); refill + dispensing + shipment surfaces remain SKELETON pending SI-007 ratification (v0.19 DRAFT, target P-013)
**Final commit (prescribe surface):** Sprint 35 / SI-001 scaffold-rebuild landing per Promotion Ledger entry P-011; 12 HTTP routes mounted per `src/modules/pharmacy/routes.ts` (2 probes + 10 prescribe-business routes; Codex R1 M1 closure 2026-05-17 corrected an earlier mis-count of 11 + a wrong endpoint name)
**Blocker (refill/dispense/shipment only):** [SI-007 Refill + Dispensing + Shipment schema gap](./SI-007-Refill-Dispensing-Shipment-Schema-Gap.md) — v0.19 DRAFT, target Promotion Ledger entry P-013, awaiting Q2 2026 Ratifier Ceremony
**CI status:** ✅ Green (prescribe-surface tests + State Machines v1.2 §19 transitions all passing)

---

## 2026-05-17 post-SI-001-ratification amendment (PR #173 per-slice STATUS refresh)

**Trigger:** PR #172 Sibling-Doc Cross-Validation Audit 2026-05-17 §2.1 surfaced this STATUS doc as 12 days stale — claimed SI-001 OPEN + skeleton-only at v0.1, but P-011 RATIFIED SI-001 2026-05-12 + the MedicationRequest/prescribe surface implementation landed shortly after. This amendment refreshes the doc against current implementation reality without losing the 2026-05-08 Sprint 33-34 amendment context below (preserved per the established Sprint-amendment layering pattern).

### What changed since the 2026-05-08 amendment

**SI-001 RATIFIED via Promotion Ledger entry P-011** on 2026-05-12 (spec corpus commit `879cd57` in `arthurmenson/telecheckONE`; 11 rounds of pre-ratification Codex convergence + 11 rounds of post-merge convergence; ~42 substantive findings closed inline; first ratification attempt 2026-05-11 reverted via withdraw-ratification cycle then re-ratified same-day).

**Pharmacy MedicationRequest/prescribe surface IMPLEMENTED** via the Sprint 35 scaffold rebuild on `feat/slice-4-pharmacy-scaffold-rebuild-p011` branch (PR #95 / PR #108 successor; 12 additional rounds of pre-PR Codex convergence + 15 scaffold-side findings closed). Module reclassified from SKELETON to SUBSTANTIAL per Implementation State Audit 2026-05-17 §1.

### Per-surface state

| Surface                                 | Implementation state (2026-05-17)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Blocker                                                                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **MedicationRequest/prescribe surface** | **IMPLEMENTED — 12 HTTP routes per `src/modules/pharmacy/routes.ts`** (2 probes + 10 prescribe-business routes; Codex R1 M1 closure 2026-05-17 corrected an earlier mis-count of 11 + a wrong endpoint name for the clinician-discontinue path): probes — GET `/health` + GET `/ready`; reads — GET `/prescriptions/:id` + GET `/patients/:patientId/prescriptions`; mutations — POST `/prescriptions` (create draft) + POST `/prescriptions/:id/submit` + POST `/prescriptions/:id/discontinue` (patient-origin discontinue) + POST `/prescriptions/:id/clinician-discontinue` (clinician-origin discontinue; distinct endpoint per the actor-origin disambiguation pattern) + POST `/prescriptions/:id/approve` (clinician) + POST `/prescriptions/:id/decline` + POST `/prescriptions/:id/supersede` + POST `/prescriptions/:id/modify`. State Machines v1.2 §19 (8 active states + 13 transitions; 2 I-012-gated routes into `active`: `clinician_approve` + `protocol_authorized_prescribing`; both emit canonical `medication_request.approved.v1` with discriminating `approval_pathway` field). Migration `025_medication_requests.sql` landed (Path 1 — no `interaction_override_id`; 14 CHECK constraints + 6 composite FKs + 5 indexes + 2 partial UNIQUE indexes; canonical `mrx_<ULID>` pattern enforced at DB layer; supersession-chain integrity invariants). AUDIT_EVENTS v5.3 amendments in place (7 net-new Category A action IDs: `medication_request.{drafted, submitted_for_review, interaction_evaluation_completed, discontinued, superseded, expired}` + `prescribing.protocol_authorization_granted`; §I-012 closure-rule prose amendment). DOMAIN_EVENTS v5.2 in-place amendments (4 net-new tenant-scoped event types: `medication_request.{discontinued, superseded, expired, interaction_safety_hold_triggered}`). | NONE — surface advanceable for Sprint 36+ refinement work                                                                          |
| **Refill surface**                      | SKELETON only — no migrations, no row-shape interfaces, no handlers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | **SI-007 ratification** (v0.19 DRAFT, target P-013, awaiting Q2 2026 Ratifier Ceremony) per Pharmacy + Refill Slice PRD v2.1 §4.17 |
| **Dispensing surface**                  | SKELETON only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **SI-007 ratification** per Slice PRD v2.1 §4.18                                                                                   |
| **Shipment surface**                    | SKELETON only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **SI-007 ratification** per Slice PRD v2.1 §4.19                                                                                   |
| **Subscription (downstream FK target)** | Sibling Subscription slice unblocked in parallel post-SI-001 (FK target `medication_requests` table now exists)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | (Subscription slice itself is a separate skeleton; see Subscription module status)                                                 |

### Test coverage post-SI-001 ratification

The Sprint 35 pharmacy scaffold rebuild landed alongside SI-001 ratification with the full MedicationRequest test suite. State Machines v1.2 §19 transitions all tested. I-012 reject-unless three-clause rule enforced via discriminated-union TypeScript types + PendingTransitionContext bound-row attestations at the service layer. Cumulative Codex closures across Sprint 35 SI-001 ratification + scaffold rebuild: ~42 substantive findings (5 withdraw-ratification + 15 spec-corpus pre-ratification + 22 spec-corpus post-merge + 15 pharmacy-scaffold pre-PR + 1 deferred-to-write-path).

### Spec references for the 2026-05-17 amendment

- `docs/Sibling-Doc-Cross-Validation-Audit-2026-05-17.md` §2.1 (the audit that surfaced this STATUS doc as stale)
- `docs/Implementation-State-Audit-2026-05-17.md` §1 (pharmacy module reclassification SKELETON → SUBSTANTIAL based on `src/modules/pharmacy/routes.ts` grep)
- `docs/Per-Track-SI-Navigation-2026-05-17.md` §1 Track 1 (Pharmacy + Refill row split between implemented-prescribe vs SI-007-blocked-refill/dispense/shipment)
- Promotion Ledger entry P-011 (SI-001 ratification record; spec corpus)
- `docs/SI-007-Refill-Dispensing-Shipment-Schema-Gap.md` v0.19 DRAFT (the remaining-surface blocker)

### What this amendment intentionally PRESERVES

The 2026-05-08 Sprint 33-34 amendment + the original 2026-05-05 Summary + What's-at-v0.1 + Test-coverage + Resume-path + Architecture-decisions sections below are PRESERVED VERBATIM as historical record. Per the established Sprint-amendment layering pattern in this repo (mirrors CONSENT/FORMS_INTAKE/IDENTITY/TENANT_CONFIG STATUS docs), each amendment layers ON TOP of the previous state rather than overwriting it. Read top-to-bottom for chronological history; read top section only for current state.

The "Status" / "Final commit" / "Blocker" header fields at line 3-9 are the EXCEPTION to the preservation rule — those reflect current state per the doc-control convention used by the other STATUS docs in this repo. The body sections below describe the v0.1 skeleton history and are preserved as-is.

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
