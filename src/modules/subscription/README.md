# Subscription module

## Status — LIVE (SI-001 closed)

SI-001 (the MedicationRequest schema gap) is **closed** — Promotion Ledger P-011 landed `medication_requests` at migration 025 (2026-05-11); operator (Evans) confirmed 2026-07-08 that P-011 closure authorizes this build. The Subscription slice is now implemented end-to-end:

- **DB layer** — migrations `075` (RBAC roles) → `076` (entities + grants + the migration 060 deferred-FK closure) → `077` (app-role bridge). Two tables: `subscriptions` (CDM §4.7) and append-only `subscription_events` (CDM §4.8).
- **State machine** — `internal/state-machine.ts`: the State Machines v1.1 §15 table (16 transitions across 10 states) as a pure transition table + guards.
- **Service** — `internal/service.ts`: `createSubscriptionDraft` + the generic `executeSubscriptionTransition` executor (locked read → pure guard → transition-specific guard → durable UPDATE with from-state + optimistic-`version` re-check → §4.8 event → same-tx §15 audit) + the three read paths.
- **HTTP surface** — the 7 OpenAPI v0.2 §20 endpoints under `/v0/subscriptions`.
- **Audit** — `audit.ts`: §15 emission-per-transition (Category A for switch approval + the SAFETY_HOLD family; Category C otherwise).

`GET /v0/subscriptions/ready` returns **200**.

## HTTP surface (OpenAPI v0.2 §20)

| Method | Path | Transition / read | Actors |
|---|---|---|---|
| GET | `/v0/subscriptions` | list (§20.1) | patient (own) / tenant_admin (tenant-wide) |
| GET | `/v0/subscriptions/:id` | get (§20.2) | patient (own) / tenant_admin |
| POST | `/v0/subscriptions/:id/pause` | `pause_request` (§20.3) | patient / tenant_operator |
| POST | `/v0/subscriptions/:id/resume` | `resume` (§20.4) | patient / tenant_operator |
| POST | `/v0/subscriptions/:id/switch` | `switch_request` (§20.5) → 202 | patient / tenant_operator |
| POST | `/v0/subscriptions/:id/cancel` | `cancel_request` (§20.6) | patient / tenant_operator |
| GET | `/v0/subscriptions/:id/events` | event history (§20.7) | patient (own) / tenant_admin |

All POSTs require the `Idempotency-Key` header (IDEMPOTENCY v5.1, tenant-scoped). Error envelopes are tenant-blind (I-025). JWT role → subscription actor: `patient` → `patient`; `tenant_admin` → `tenant_operator`. Reads self-scope for patients and go tenant-wide for `tenant_admin`.

## NOT exposed over HTTP at v0.2 (by design — do not build ad hoc)

- **`POST /subscriptions` (DRAFT create)** is ratified under the OpenAPI v0.2 **Payments** module (checkout orchestration), not this slice. The stable in-process target is the exported `createSubscriptionDraft` service function (called by the Payments module per the ADR-001 boundary).
- **Clinician transitions** (`clinician_approval`, `clinician_decline`, `switch_approve`, `switch_decline`, `clinician_release`, `clinician_terminate`) and **system transitions** (`period_end`, `complete`, auto-`resume`, `pause_expires`, `end_period`, `payment_failed_terminal`, `safety_signal_critical`) — reached via the exported `executeSubscriptionTransition` service function (scheduler / domain-event subscriber wiring). OpenAPI v0.2 §20 ratifies no clinician/system endpoint.

## Recorded spec issues (§12 SI candidates)

1. **GLOSSARY TENSION — `prescription_id` column.** CDM §4.7 ratifies the column name `prescription_id`; GLOSSARY v5.2 forbids the `prescription` alias (canonical: `medication_request`). Per source-of-truth hierarchy, CDM's inlined DDL is authoritative for schema, so the **column** is kept verbatim (`prescription_id`, FK → `medication_requests`). **App-layer + wire naming use the canonical `medication_request_id`** (see `toSubscriptionView`). Renaming the column would silently fork ratified DDL — flagged, not done.
2. **CDM §4.8 event_type enum gap.** State Machines v1.1 §15 mandates emissions `subscription.fulfilled` (FULFILLING→ACTIVE), `subscription.switch_declined` (SWITCHING→ACTIVE decline), `subscription.terminated_clinical` (SAFETY_HOLD→CANCELLED), and a `period_end` marker — but CDM §4.8's ratified 13-value enum has no corresponding values. Those transitions carry `eventType: null` and record their trail via **AUDIT records only** (fail-closed: no unratified enum value is invented). When the enum is amended, set the `eventType` on those four transition-table rows.
3. **AUDIT_EVENTS `subscription.*` action IDs.** AUDIT_EVENTS v5.x enumerates no canonical `subscription.*` action IDs. `audit.ts` uses the sanctioned single-cast placeholder pattern (identity/forms-intake/consent/async-consult precedent). Replace the placeholder strings with canonical names when ratified.

## Named follow-ups (deferred, not blockers)

- **Real payment adapter.** `payment_method_id` is an opaque handle; the posture is `mock_local_dev` (Track-5 gap).
- **Switch review case.** `POST /switch` returns 202 SWITCHING and records the requested `new_product_id` in the `switching_initiated` event; no `review_case_id` is minted (the clinical review case is a cross-module concern with no ratified entity in this slice). The clinician `switch_approve` performs the product rebind.
- **Renewal-time interaction re-check** on `period_end` (cross-module event wiring).
- **Refill subscription-consistency trigger** (migration 060 deferred; lands with the refill write path — SI-007).
- **Event-history filtering/pagination** (`from`/`to`/`event_type`/cursor on §20.7). v1.0 returns the full ordered log with a forward-stable `pagination` envelope (`has_more=false`).

## Tests

- `internal/state-machine.test.ts` — pure unit coverage of the §15 table + guards (exhaustive actor-permission matrix, pause-window boundary, cadence intervals).
- `tests/integration/subscription-http.test.ts` — live-PG HTTP suite: pause/resume/cancel/switch happy paths, pause-window 400, invalid-state 409, tenant isolation + self-scope 404 (I-023/I-025), clinician-write 403, reads, and idempotency-replay.
- `tests/integration/subscription-plugin-wiring.test.ts` — DB-free wiring smoke (probes READY).

## Spec references

- CDM v1.2 §4.7 (Subscription) / §4.8 (SubscriptionEvent) / §3.12 (inventory)
- State Machines v1.1 §15 (Subscription State Machine)
- OpenAPI v0.2 §20 (endpoint contracts)
- RBAC v1.1 (no subscription-specific roles ratified — minimal role set per migration 075 header)
- Pharmacy + Refill Slice PRD v2.1 §8 (subscription semantics; direct-INSERT write path, no SECDEF wrappers)
- Promotion Ledger P-011 (SI-001 closure)
- I-003 / I-023 / I-025 / I-027; IDEMPOTENCY v5.1
