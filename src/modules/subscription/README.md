# Subscription module

Implements the Subscription slice per **CDM v1.2 §4.7 (Subscription) + §4.8
(SubscriptionEvent)**, **State Machines v1.1 §15 (Subscription State Machine)**,
and **OpenAPI v0.2 §20 (Subscriptions module)**. Multi-tenant, RLS-enforced,
audit-emitting.

**SI-001 is CLOSED** (Promotion Ledger P-011, 2026-05-11 — migration 025 landed
`medication_requests`, the §4.7 `prescription_id` FK target; operator Evans
confirmed 2026-07-08 that P-011 closure authorizes this build). The v0.1
BLOCKED-aware skeleton has been replaced with the real DB + service + state
machine + HTTP surface.

## What ships

### DB layer (migrations 075–077)
- `075_subscription_rbac_roles.sql` — the 4 slice roles (`subscription_patient_manager`,
  `subscription_clinician_reviewer`, `subscription_system_scheduler`,
  `subscription_staff_reader`); NOLOGIN + non-BYPASSRLS.
- `076_subscription_entities.sql` — `subscriptions` + `subscription_events`
  (CDM §4.7/§4.8), RLS ENABLE+FORCE + `tenant_isolation` policy, tenant-scoped
  composite FKs (accounts / product_catalog / medication_requests), append-only
  triggers on `subscription_events`, table grants, and closure of the migration
  060 deferred `refills.subscription_id` FK.
- `077_subscription_app_role_bridge.sql` — bridges `telecheck_app_role`
  NOINHERIT membership into the 4 roles + SI-010 actor-context helper EXECUTE
  grants (051/061/063 Option-B pattern).

### Service + state machine (`internal/`)
- `state-machine.ts` — the §15 transition table (16 transitions / 10 states) as
  a pure table + guards (`checkTransition`, `isValidPauseWindow`,
  `cadenceInterval`, `MAX_PAUSE_DAYS`, `TERMINAL_STATUSES`).
- `service.ts` — `createSubscriptionDraft`, `executeSubscriptionTransition`,
  `listSubscriptions`, `getSubscription`, `listSubscriptionEvents`. Canonical
  composition: the CALLER owns `withTransaction`/`withTenantContext`; each
  service function owns the innermost `withDbRole` and emits the §15 audit
  **after** `withDbRole` returns (I-003 discipline — audits are never emitted
  inside the elevated block; guard failures RETURN outcome objects so the caller
  commits the tx WITH the rejection audit).
- `audit.ts` — module audit emitters (Cat A for switch approval + the SAFETY_HOLD
  family; Cat C otherwise). Uses the sanctioned placeholder-action cast (SI-002
  umbrella) because AUDIT_EVENTS does not yet enumerate `subscription.*` action
  IDs — a single cast site to replace when the contract ratifies them.

### HTTP surface (`internal/handlers/`, `routes.ts`) — OpenAPI v0.2 §20
Base path **`/v0/subscriptions`** (plural, per §20). All 7 ratified endpoints
are live:

| Method | Path | §    | Actor |
| ------ | ---- | ---- | ----- |
| GET  | `/v0/subscriptions`                 | 20.1 | patient (self) / tenant operator (tenant-wide) |
| GET  | `/v0/subscriptions/:id`             | 20.2 | patient (self) / tenant operator |
| POST | `/v0/subscriptions/:id/pause`       | 20.3 | patient / tenant operator |
| POST | `/v0/subscriptions/:id/resume`      | 20.4 | patient / tenant operator |
| POST | `/v0/subscriptions/:id/switch`      | 20.5 | patient / tenant operator (202) |
| POST | `/v0/subscriptions/:id/cancel`      | 20.6 | patient / tenant operator |
| GET  | `/v0/subscriptions/:id/events`      | 20.7 | patient (self) / tenant operator |

- **Composition:** POST handlers wrap `withIdempotentExecution → withTenantContext
  → executeSubscriptionTransition` (the service owns the innermost `withDbRole` +
  same-tx §15 audit). Reads wrap `withTransaction → withTenantContext → service`.
  `42501 → tenant-blind 403` (I-025).
- **Actor mapping:** JWT `patient → 'patient'`; `tenant_admin → 'tenant_operator'`
  (audit `actor_type=operator`). `clinician`/`platform_admin`/`ai_service` have no
  ratified §20 write endpoint → **403**.
- **Tenant-blind:** wire views strip `tenant_id` + the opaque `payment_method_id`;
  the DB column `prescription_id` is projected as the canonical
  `medication_request_id` (GLOSSARY hard rule).
- `/health` → 200 (liveness); `/ready` → 200 (SI-001 closed; ratified surface
  mounted).

## What is deferred (spec-gated; fail-closed — not built ad hoc)

- **POST `/subscriptions` (DRAFT create).** Ratified under the OpenAPI v0.2
  **Payments** module (checkout orchestration), not this slice. The stable
  in-process target is the exported `createSubscriptionDraft` service function
  (Payments calls it rather than reaching into subscription tables — ADR-001
  boundary). No HTTP endpoint here.
- **Clinician transitions** (`clinician_approval`/`clinician_decline`/
  `switch_approve`/`switch_decline`/`clinician_release`/`clinician_terminate`)
  and **system transitions** (`period_end`/`complete`/auto-`resume`/
  `pause_expires`/`end_period`/`payment_failed_terminal`/`safety_signal_critical`).
  Reached via `executeSubscriptionTransition` (scheduler / domain-event
  subscriber wiring). OpenAPI v0.2 §20 ratifies no clinician/system endpoint.
- **Real payment adapter.** `payment_method_id` is an opaque handle;
  `payment_provider_posture: mock_local_dev` is the staging posture. The real
  adapter is the standing Track-5 gap.
- **Refill-cadence wiring** (subscription `period_end` → pharmacy refill creation;
  renewal-time interaction-engine re-check). Cross-module event wiring — a named
  follow-up; the migration 060 `refills.subscription_id` FK is closed in 076.
- **Switch clinical review case id.** The §20.5 `switch` response documents a
  clinical review case id; there is no ratified review-case entity in this slice,
  so the requested `new_product_id` is recorded in the `switching_initiated`
  event (queryable via `/events`) and no case id is minted — named follow-up.
- **Events endpoint filtering/pagination.** `/events` returns the full ordered
  log with a forward-stable `{ cursor: null, has_more: false }` envelope;
  server-side from/to/event_type filtering + cursor pagination is a named
  follow-up.

## Spec gaps (recorded; §12 Spec Issue candidates)

- **CDM §4.8 event_type enum** has no value for the §15 emissions
  `subscription.fulfilled` (complete), `subscription.switch_declined`
  (switch_decline), `subscription.terminated_clinical` (clinician_terminate), or
  any `period_end` marker. Those transitions record their trail via **audit only**
  until the enum is amended (the migration 076 CHECK is CDM-verbatim, 13 values —
  no unratified enum value is invented; fail-closed).
- **AUDIT_EVENTS** does not enumerate `subscription.*` action IDs — the module
  emits via the sanctioned placeholder-action cast (SI-002 umbrella); replace the
  placeholder strings with canonical names when the contract ratifies them.
- **RBAC Permissions Matrix** names no subscription-specific roles; migration 075
  creates the minimal role set implied by the §15 actor classes + the §20.1 staff
  read path (055-precedent minimal-roles pattern). Rename via a follow-up
  migration if a future RBAC bump ratifies canonical names.
- **GLOSSARY tension:** CDM §4.7 ratifies the column name `prescription_id` while
  GLOSSARY forbids the `prescription` alias. Per the source-of-truth hierarchy,
  CDM's inlined SQL is authoritative for schema — the column is kept verbatim; the
  app/wire layer uses the canonical `medication_request_id`.

## Tests

- `internal/state-machine.test.ts` — pure §15 transition-table + guard coverage.
- `internal/handlers/handlers.test.ts` — pure-unit handler coverage (validation
  400s, actor gating 401/403, outcome → HTTP mapping 200/202/404/409/400/422).
- `tests/integration/subscription-http.test.ts` — **live-PostgreSQL** end-to-end:
  pause/resume/switch/cancel happy paths + guard rejections (pause > 90d → 400,
  invalid-from-state → 409 + I-003 rejection audit), tenant-blind self-scope +
  cross-tenant 404, actor gating, reads (patient self + tenant_admin staff),
  idempotency replay, and the `createSubscriptionDraft` + `clinician_approval`
  service path. Requires the 4 subscription slice roles granted to
  `telecheck_test_app` (`tests/helpers/grant-slice-roles.ts`).
- `tests/integration/subscription-plugin-wiring.test.ts` — plugin smoke test
  (health/ready 200 at the plural base path).
- `tests/contracts/rls-policy-coverage-lockdown.test.ts` — inventory extended with
  `subscriptions` + `subscription_events`.

## Spec references

- CDM v1.2 §4.7 / §4.8 / §3.12 (Ecom & Subscription Management inventory)
- State Machines v1.1 §15 (Subscription State Machine) + §16 (cross-machine)
- OpenAPI v0.2 §20 (Subscriptions module)
- Pharmacy + Refill Slice PRD v2.1 §8 (subscription semantics)
- ADR-001 (modular monolith), ADR-023 (multi-tenancy Model A)
- I-003 / I-023 / I-025 / I-027; IDEMPOTENCY v5.1
- Promotion Ledger P-011 (SI-001 closure)
- migrations/075–077
