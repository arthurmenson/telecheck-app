# Crisis-response — known followups (PR #201 ratifier waiver)

This file documents the explicit waiver scope under which **PR #201
(POST /v0/crisis-events)** was merged at SI-022 Sprint 2 PR 2 landing.
The two findings below are NOT regressions — they are correctness-completeness
gaps where the PR's improvements are a strict improvement over the pre-PR
state, but the canonical end-state requires platform-floor primitives that
are explicitly deferred per spec to a separately ratified follow-on slice.

## Waiver scope (Codex R2 HIGH findings 2026-05-24)

### Followup 1 — exactly-once-forever lifecycle audit uniqueness

**Current state shipped:** Replay-aware audit emission via
`audit_dedupe_markers` with the existing 30-day TTL (from migration 022).
Same-Idempotency-Key replays within the 30-day window deduplicate correctly;
late replays beyond 30 days through a NEW Idempotency-Key on the same
`server_signal_id` will re-emit the audit.

**Canonical end-state required:** "Exactly once per
`(tenant_id, resource_type, resource_id, action)` forever" — implementable as
either (a) non-expiring lifecycle-audit class on `audit_dedupe_markers` via a
class-kind column extension, or (b) a separate durable
uniqueness-guarantee table (e.g., `lifecycle_audit_claims`) tied to the
audit row via FK + unique index, not subject to the markers-cleanup job.

**Why not inline:** Either path is a canonical schema artifact addition —
spec-ratification-leads-implementation-by-≥1-sprint discipline floor
(CLAUDE.md hard-floor item 6) prohibits authoring inline.

**Production risk profile under waiver:** The realistic FLOOR-020 retry
window is well under 30 days for legitimate client retries; dedupe holds
correctly within that window. Long-tail re-emission past 30 days requires
a deliberate caller action (new Idempotency-Key on a stale resource) that
is itself a defect class downstream callers should not exhibit.

**Followup SI:** TBD (Phase A successor — owner + ratification date to be
assigned by Evans). Track via cockpit-Addendum reference back to this file
once the SI ID is allocated.

### Followup 2 — canonical crisis_initiator role model

**Current state shipped:** `requireCrisisInitiatorActorContext` gate on
`POST /v0/crisis-events` accepts only JWTs with `role='clinician'`. The
return-type contract documents `on_call_clinician` + `ai_mode1_service` as
future identity classes; the implementation maps to those classes is a
no-op-today stopgap. Mode 1 `ai_mode1_service` autonomous-initiation paths
(I-019 platform-floor case) will 403 at Layer B today and get
mis-attributed as clinician on any future ambiguous claim — this is
acceptable today because those paths are not yet firing in production
(Day-3+ wiring per AGENTS.md).

**Canonical end-state required:** Extend `AccessTokenRole` / `ActorRole`
JWT-claim enums to include `on_call_clinician` and `ai_mode1_service` (and
any other ratified initiator identities), or introduce a service-principal
mapping layer. Per the spec corpus, this is explicitly deferred to
**Phase A successor SI to SI-010 / SI-024.1** — a separately ratified
slice.

**Why not inline:** JWT-claim enum extension is a platform-floor primitive
amendment beyond SI-022's ratified scope. Authoring inline would extend
unratified architecture — the exact failure pattern documented in
CLAUDE.md's PR #10 worked example.

**Production risk profile under waiver:** Day-3+ until the Mode 1
ai_mode1_service service-account wiring lands. Clinician-only crisis
initiation is the production-active path today; the future-wired return
type means downstream consumers see the canonical shape from day one
(no further callsite churn when the canonical identities activate).

**Followup SI:** Phase A successor to SI-010 / SI-024.1 (already
identified in the spec corpus; owner + ratification date to be assigned
by Evans).

## /ready — flipped 503 → 200 at Sprint 4 close (2026-07-08)

Historical: per Codex Pass-2 synthesis safeguard at PR #201 time, the
crisis-response slice's `GET /v0/crisis-events/ready` returned **503
Service Unavailable** while the Sprint 2 cascade + Sprint 4 hardening
were open.

**Sprint 4 (feat/crisis-response-sprint4) closed the build-gated list**
— KMS envelope wire surface (pre-encrypted 8-field posture per
ADR-021/ADR-024), live-PG cross-tenant integration suite, patient-summary
route-mount fix, sweep pre-fetch 42703 fix — and flipped /ready to
**200 + machine-readable `spec_gated_gaps`** per the PR #254 readiness
contract ("ready" = traffic-acceptable for the implemented surface;
spec-gated gaps that fail closed do not hold the gate; pharmacy +
async-consult precedent).

Gap-by-gap flip rationale (every remaining gap is spec-gated AND fails
closed or fail-conservative):

| spec_gated_gaps entry | Followup | Failure direction |
|---|---|---|
| `lifecycle_audit_dedupe_ttl_long_tail_needs_schema_si` | Followup 1 above | Fail-CONSERVATIVE: a >30-day replay through a NEW Idempotency-Key re-emits the append-only Cat A audit row — over-emission, never suppression, never access. Not a deferred-PERMISSIVE item (the PR #262 counter-example class does not apply). |
| `crisis_initiator_identity_expansion_needs_phase_a_si` | Followup 2 above | Fails CLOSED: on_call_clinician / ai_mode1_service initiations 403 at Layer B until the Phase A successor SI lands. |
| `sweep_scheduler_jwt_identity_needs_phase_a_si` | Same Phase A successor | Fails CLOSED: sweep gate is the closest-available admin gate (tenant_admin/platform_admin) + deploy-time network ACL; patient/clinician tokens 403. |
| `app_side_kms_envelope_encryption_todo` | Standing platform-wide Track-5 TODO | Fails CLOSED: partial/malformed envelopes 400 at the boundary; absent envelope stores NULL columns (all-or-none CHECK). Same posture async-consult shipped /ready 200 with. |

## Ratifier decision provenance

| View | Position |
|---|---|
| Claude | Option C+B — ship partial + document known-followups |
| Codex Pass-1 | File ERR; if shipping, require waiver + /ready unavailable |
| Codex Pass-2 (synthesis) | **Option D — merge with explicit waiver + successor SI ownership + /ready 503** |
| Evans (ratifier) | Auto-proceeded per CLAUDE.md auto-proceed rule (Claude + Pass-2 agreed on Option D) |

Date: 2026-05-24. Cycle: telecheck-app cascade per Evans's
"merge them for me" extension (cockpit Addenda 110–111 + the cascade
runbook merged via PR #212).
