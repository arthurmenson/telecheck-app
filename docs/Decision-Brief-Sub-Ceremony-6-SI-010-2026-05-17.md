# Sub-Ceremony 6 Decision Brief — SI-010 Session Actor Context DB Binding

**Date:** 2026-05-17
**Ratifier:** Evans (Telecheck workstream lead)
**Reviewer (adversarial):** Codex (per-PR adversarial review after ratification-intent commit)
**Target Promotion Ledger entry:** P-023 (per +1 cascade from SC5)
**Source spec doc:** `telecheck-app/docs/SI-010-Session-Actor-Context-DB-Binding.md` (v0.6 — R1→R5 closed during pre-ratification cycle 2026-05-15)
**Cluster:** Standalone critical-path infrastructure (no cluster batching; sequenced AFTER SC1–SC5 placeholder + Async-Consult ratifications)

---

## Why this needs ratification

SI-010 is the **DB-side trust-anchor infrastructure** for server-derived actor identity in SECURITY DEFINER procedures. It is the **gating prerequisite** for FIVE separate stored procedures across three already-ratified SIs:

- SI-005 `record_consult_clinician_decision()` + `rotate_consult_clinician_decision_kms()` — P-021 ratified SC3
- SI-008 `record_workflow_pointer_swap()` — P-018 ratified SC2
- SI-009 `record_consult_escalation_target_swap()` — P-019 ratified SC2

Without SI-010 ratified + implemented, the SC3 / SC2 procedures cannot move from spec → implementation (caller-supplied identity = privilege escalation surface per Codex SI-009 R5 HIGH finding 2026-05-15).

SI-010 also **closes deferred Phase 2 F-3** (JWT session-liveness check) by folding the liveness check into the authContextPlugin path with fail-closed `throw UnauthenticatedError()` ordering.

---

## Eight ratifier sub-decisions

### Sub-decision 1 — Trust-anchor architecture: PERMANENT `_session_actor_context` table + GRANT-locked `bind_actor_context()` SECURITY DEFINER function

**Recommendation:** ✅ ACCEPT the R4+R5 closure design.

The pre-ratification cycle closed two competing designs:
- **Original (R2 HIGH-2):** TEMPORARY table per request — REJECTED. Any SQL the app executes during a request runs on the same backend and can `INSERT INTO _session_actor_context (...)` to spoof identity.
- **R4 HIGH closure (canonical):** PERMANENT table with `REVOKE ALL FROM telecheck_app_role`; the ONLY write path is `bind_actor_context()` SECURITY DEFINER function whose EXECUTE is GRANTed only to `bind_actor_context_role`. The GRANT model is the trust anchor.

**Implication accepted:** the application's primary DB role has zero direct access to `_session_actor_context`. authContextPlugin connects via a separate pool (or `SET ROLE`) to invoke the binding statement, then reverts to `telecheck_app_role` for the request handler.

### Sub-decision 2 — Privileged binding role separation: `bind_actor_context_role` distinct from `telecheck_app_role`

**Recommendation:** ✅ ACCEPT separate-role architecture; defer connection-pool topology choice (separate pool vs. `SET ROLE` toggle) to authContextPlugin implementation PR.

**Operational impact:** Identity slice migration adds the new role. DevOps SOPs need a note that the role's password / IAM binding must NOT be shared with `telecheck_app_role` and must NOT be granted to anyone other than the authContextPlugin's binding-statement code path.

### Sub-decision 3 — Helper functions read DIRECTLY from the table, NOT from `SET LOCAL` GUCs

**Recommendation:** ✅ ACCEPT (R3 HIGH closure 2026-05-15).

Helpers (`current_actor_account_id()` / `_tenant_id()` / `_role()` / `_admin_home_tenant_id()`) query `_session_actor_context` keyed by `(pg_backend_pid(), txid_current(), app.request_nonce)`. The ONLY GUC the helpers consume is `app.request_nonce` (used as the row-lookup key). All other `SET LOCAL app.*` values are kept for the `current_tenant_id()` pattern + future tooling but the helpers IGNORE them.

**Trust invariant:** even if an attacker sets `app.actor_account_id = 'spoofed'`, the helpers return the value from the table row, which was written only by `bind_actor_context()` invoked through the privileged role.

### Sub-decision 4 — Session-liveness check + fail-closed ordering (closes Phase 2 F-3)

**Recommendation:** ✅ ACCEPT the R3 HIGH-2 canonical ordering.

Canonical request-time flow in authContextPlugin `onRequest` hook:

1. Existing JWT verify + tenantContext resolution
2. **Session-liveness check** (SELECT `revoked_at` / `expires_at` from `sessions`)
3. **FAIL CLOSED** on revoked / missing / expired: `throw UnauthenticatedError()` → Fastify error-envelope plugin maps to **tenant-blind 401 per I-025** + rolls back the request transaction
4. On liveness pass: call `bind_actor_context(...)` via the privileged role
5. `SET LOCAL app.request_nonce = ...` (the only GUC the helpers consume)
6. `RESET ROLE` back to `telecheck_app_role`; pre-auth endpoints skip steps 2–5

**Folds deferred Phase 2 F-3** (JWT session-liveness) into the binding path. Closes that follow-on.

### Sub-decision 5 — Cleanup mechanism: tx-end cleanup trigger + background-job sweeper + 5-minute `expires_at` TTL

**Recommendation:** ✅ ACCEPT defense-in-depth combination.

Three independent reasons a row must die:
- **Tx-end cleanup trigger** (CONSTRAINT TRIGGER on per-tx sentinel row, deferred until commit/rollback): primary cleanup path
- **Background-job sweeper** (DELETE WHERE expires_at < NOW(), runs every 60s): defends against orphans from process crashes / unclean tx termination
- **Read-time `expires_at > NOW()` predicate** in helpers + `assert_request_nonce_bound()`: defense-in-depth even if cleanup is delayed

**TTL default:** 5 minutes (`p_ttl_seconds DEFAULT 300`). Sufficient for any normal request transaction; expires before pooled-connection reuse meaningfully matters.

### Sub-decision 6 — Audit emission for the binding lifecycle

**Recommendation:** ✅ ACCEPT THREE new AUDIT_EVENTS additions (Cat B auth-proof events; routed via Identity slice; standard tenant_id / account_id / session_id / nonce envelope):

| ID | Category | When emitted |
| --- | :---: | --- |
| `identity.actor_context_bound` | B | After successful `bind_actor_context()` call (every authenticated request) |
| `identity.session_liveness_check_failed` | B | On revoked / missing / expired session at Step 2 (paired with `UnauthenticatedError` throw) |
| `identity.actor_context_unbound_rejected` | B | When a procedure that depends on `assert_request_nonce_bound()` raises `actor_context_unbound` or `request_nonce_unbound_or_expired` |

**Surface count impact:** +3 net-new AUDIT_EVENTS action IDs at P-023. AUDIT_EVENTS minor bump (+1 from then-current; default 6th-landing destination per interpretation rule).

**Interpretation-rule note for ledger entry:** SC6 IS an AUDIT_EVENTS-touching ceremony (unlike SC4/SC5 which were CDM-exempt only — SC6 is not CDM-exempt **and** does touch AUDIT_EVENTS). Total AUDIT_EVENTS max-bumps cap interpretation extends from "5 bumps" to "potentially 6 bumps" pending future SC outcomes. Default 6th-landing destination of `AUDIT_EVENTS` is **v5.8** under the standard ordering 1→2→3→4→5→6.

### Sub-decision 7 — Five mandatory regression tests gate SI-010 IMPL-readiness

**Recommendation:** ✅ ACCEPT all five as merge-blocking for the SI-010 implementation PR (Identity slice migration + plugin wiring PR; not blocking for the ratification-intent PR-A1⁗′ this turn):

1. **GRANT enforcement test:** assert `telecheck_app_role` has zero INSERT/UPDATE/DELETE/SELECT on `_session_actor_context` + zero EXECUTE on `bind_actor_context()`.
2. **Caller-spoof test (adversarial; R4 regression):** with `telecheck_app_role`, attempt direct INSERT / EXECUTE / GUC-fabrication — all MUST fail `permission denied` OR a dependent SECURITY DEFINER procedure MUST fail `actor_context_unbound`.
3. **Pooled-connection bleed test (per SI-009 R6):** request B on the same backend connection as request A reads B's context (not A's). Validates UPSERT semantics + `txid_current()` discriminator.
4. **Expired-context test:** bind, sleep past expiry, invoke procedure → `request_nonce_unbound_or_expired` rejection. Validates defense-in-depth `expires_at > NOW()` predicate.
5. **Migration-deploy test:** asserts post-migration state: table exists as permanent + `bind_actor_context_role` exists + `telecheck_app_role` has zero privileges + only `bind_actor_context_role` has EXECUTE on `bind_actor_context()`.

### Sub-decision 8 — Four open-question resolutions

**8a. Transaction boundary** (authContextPlugin's binding INSERT vs. route handler's business tx): RECOMMEND wrapping the entire request in a Fastify-Postgres-typed rolling tx (the `request.db` already-resolved pattern). `SET LOCAL` + the bound row both persist through to the route handler. Advisory-locks alternative is rejected (adds non-obvious complexity; locks held across HTTP latency = pool contention).

**8b. `SET LOCAL` value-type coercion** (TEXT only; UUID / TIMESTAMPTZ need explicit casts): ACCEPT the boilerplate. Helpers cast at read-time; this is a one-time documentation cost in the helper definitions, no caller burden.

**8c. Pre-auth endpoint behavior** (GET `/health`, OTP-start, etc.): RECOMMEND **SKIP ENTIRELY** (no binding row, no GUC, no liveness check). Procedures fail closed via `current_setting('app.request_nonce', /*missing_ok=*/false)` raising at the first read. Cleaner than a sentinel "unauthenticated" row that adds an exception-path to every helper.

**8d. Multi-statement transaction across `await`-suspended request handlers** (unusual but possible — a single tx spanning multiple HTTP handlers): RECOMMEND **DOCUMENT-ONLY** with explicit warning in the Identity slice spec. `SET LOCAL` and the bound row persist for the duration of the tx; if the second handler runs as a different actor, the implementer must explicitly call `bind_actor_context()` again (UPSERT will replace). Not a code path we expect at v1.0.

---

## What lands at PR-A1⁗′ (this sub-ceremony's ratification-intent commit)

**Promotion Ledger:**
- **NEW P-023** — SI-010 Session Actor Context DB Binding ratification-intent (trust-anchor architecture per all 8 sub-decisions above; closes Phase 2 F-3; unblocks SI-005 / SI-008 / SI-009 stored procedures; surface-count cite for 3 NEW AUDIT_EVENTS additions + AUDIT_EVENTS minor bump default 6th-landing v5.8)
- **Interpretation-rule extension:** from 5 sub-ceremonies / 8 entries to 6 sub-ceremonies / 9 entries; 6th-landing destinations (v2.16 → v2.17 Registry; AUDIT_EVENTS v5.7 → v5.8 default); AUDIT_EVENTS max-bumps cap extends to 6; SC6 NOT CDM-exempt (it IS a CDM-touching ceremony? — **NO actually it isn't; SI-010 is Identity-slice infrastructure with no entity additions to CDM**, so SC6 IS CDM-exempt). Updated interpretation: CDM max-bumps total across all 6 SCs = **3, unchanged** (SC4/SC5/SC6 all CDM-exempt for different reasons: SC4/SC5 AUDIT_EVENTS-only scope; SC6 Identity-slice procedure-only scope with no entity additions); SC6 IS DOMAIN_EVENTS-non-touching (no new domain events; only AUDIT_EVENTS Cat B events) — preserves DOMAIN_EVENTS no-version-bump pattern formalized at P-015.

**Registry:** v2.11 (UNCHANGED per lockstep invariant; bumps only at PR-A2/A3 canonical-content port commit, not at PR-A1⁗′ ratification-intent commit). Last-updated bumped + §3 row 64 extended to "6 SCs / 9 entries" + §8 changelog new top row dated 2026-05-17 (sub-ceremony 6).

**P-NUM cascade post-SC6:**

| SI | P-NUM | Status |
| --- | :---: | --- |
| SI-007 (SC1) | P-013 | ✅ |
| SI-012 (SC1) | P-012 | ✅ |
| SI-002 (SC4) | P-014 | ✅ |
| SI-003 (SC5) | P-015 | ✅ |
| SI-004 (SC5) | P-016 | ✅ |
| SI-008 (SC2) | P-018 | ✅ |
| SI-009 original (SC2) | P-019 | ✅ |
| SI-009.1 successor | P-020 | 🕐 awaiting next Codex pre-ratification gate |
| SI-005 (SC3) | P-021 | ✅ |
| **SI-010 (SC6)** | **P-023** | 🕐 **this brief's target** |
| SI-011 umbrella (SC7) | P-024 | 🕐 upcoming |
| SI-013 (SC8) | P-025 | 🕐 upcoming |
| SI-012 / SI-014 (SC9) | P-026 / P-027 | 🕐 upcoming (SI-014 parked until ADR-030) |

(P-022 reserved for SI-009.1 if its Codex pre-ratification gate completes before P-023 lands; otherwise SI-009.1 cascades to P-022 post-SC6 with downstream re-cascade.)

---

## Ratification

To accept all 8 sub-decisions as recommended: reply **"ratify"**.

To accept with modifications: name the sub-decision number + the alternative (e.g., "ratify, but 8c make pre-auth bind a sentinel row").

To defer: name the sub-decision number + the unresolved question.

---

— Claude (Opus 4.7, 1M context), 2026-05-17 Sub-Ceremony 6 Decision Brief delivery
