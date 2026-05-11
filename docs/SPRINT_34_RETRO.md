# Sprint 34 — Retrospective

**Sprint:** 34
**Closed:** 2026-05-08
**Final commit:** `04e88e3` (Merge PR #51 — async-consult HTTP integration tests) followed by docs r5 landings at PRs #52 (`0020136`), #53 (`d96b2f7`), #54 (`dc06541`), #55 (`16d149d`), #56 (`4b5aa47`), #57 (`3d86cb5`).
**Sprint goal (recap):** Close the SI-006 cycle cleanly — cleanup-sweep (PR #48) + audit-dedupe SI (PR #49) + async-consult HTTP coverage (PR #51) + docs codification (matrix r5, PROJECT_CONVENTIONS r5, SI-006 v0.3 closure section, per-slice status amendments).
**Goal achieved:** ✅

---

## What went well

- **PR-F2 r4 deferred HIGH closed in PR #49.** `8257c8d` (SI-006 audit-dedupe SI — close crash-window duplicate Category A audits) + `d486e46` (audit-dedupe r2 — bodyHash + TTL alignment) landed the cross-cutting `audit_dedupe_markers` table (`migrations/022_audit_dedupe_markers.sql`) + `claimAuditDedupeSlot` helper + bodyHash discrimination + per-endpoint TTL alignment. The 6-tuple dedupe identity `(tenant_id, idempotency_key, endpoint, actor_id, bodyHash, auditAction)` joined by ASCII unit separator (0x1F) and SHA-256 hashed gives precise dedupe across legitimate post-cache-expiry retries with different content.
- **PR #48 cleanup-sweep landed at r1 APPROVE.** `a02f101` (SI-006 cleanup-sweep — delete `markIdempotencyManagedByHandler`) removed the no-op + 31 call sites + extended Group F lockdown to pin identifier absence. The lockdown's `stripComments(src)` helper from §5.11 made the broad-but-precise regex possible.
- **PR #51 async-consult HTTP integration tests landed 552 lines across 6 groups / 13 cases.** `ea025dd` initial + 4 Codex rounds (`78336bc` r2 / `439a593` r3 / `9d854b0` r4) closing 4 MEDIUMs — including a CI-revealed real-DB handler bug at r4 where `InvalidTransitionError` + `UnsupportedTransitionError` were leaking as tenant-blind-violating 500s. Handler `mapServiceError` extended to map both → tenant-blind 409. `expectNoTenantLeak(response)` shared helper applied to ALL response surfaces (success + every error envelope).
- **§3 state-machine coverage extended.** Async-consult lifecycle (initiate / submit / abandon / resume / patient-responds) now has HTTP-surface coverage on top of the prior service-layer + cross-tenant-isolation tests.
- **PROJECT_CONVENTIONS r5 promoted clean.** `4e5d186` (PR #54) codified §3.7 reserve-then-execute, §3.8 return-cached-vs-throw, §3.9 independent-tx Cat A audit + dedupe markers, §5.11 comment-stripped source-grep, §5.12 asymptotic-convergence expectation. The promotion was different content than the Sprint 30 drafts/ proposal — validating the propose-vs-promote separation.
- **BUILD_VS_SPEC_TRACEABILITY_MATRIX r5 promoted clean.** `e672b54` (PR #52) documents the full Sprint 33-34 SI-006 cycle: 18 substantive Codex closures across 11 PR iterations; SI-006 status flipped Open → Resolved; async-consult HTTP gap closed; cumulative ~65+ Codex closures.
- **SI-006 v0.3 implementation closure section** `a9b2db0` (PR #53) added the closure section at the bottom of the SI doc with three runtime additions surfaced by the Codex review series (per-endpoint TTL overrides; reservation-lock vs cached-response TTL split; cross-cutting audit_dedupe_markers).
- **Per-slice status doc amendments** `241d8a6` (PR #55) + r2 hotfixes `a98acbc` (PR #56) + `c2f0f95` (PR #57) brought CONSENT / IDENTITY / FORMS_INTAKE status docs into alignment with Sprint 33-34 implementation state. Two correction patches addressed handler-name accuracy issues.
- **PR #50 dependency-review advisory landed** `3d12c3e` to unblock CI while repo-level Dependency Graph enablement is pending Evans-side admin action.
- **Cumulative ~65+ Codex closures** at Sprint 34 close (47 documented through Sprint 17 r4 matrix + 18 across Sprint 33-34 per matrix r5).

## What didn't go well

- **PR #51 r4 was CI-revealed, not Codex-revealed.** The `InvalidTransitionError` / `UnsupportedTransitionError` → 500 leak wasn't caught by Codex review (which ran against the source); it surfaced when CI ran the tests against a real Postgres + Fastify lifecycle. Per §5.12 mitigation, per-PR Codex review is necessary-but-not-sufficient — real-DB CI is the final gate that catches handler-lifecycle interactions Codex's static analysis can't see.
- **Two correction patches needed on per-slice status doc amendments.** PR #56 (`a98acbc` — fix IDENTITY_SLICE_STATUS Sprint 33-34 amendment accuracy) and PR #57 (`c2f0f95` — fix FORMS_INTAKE + IDENTITY status amendment handler-name accuracy) addressed handler-name and detail inaccuracies in the initial amendments. Documentation drift caught by close-reading, not by automated checks. Adds weight to authoring discipline on status-doc amendments.
- **Documented limitations recorded in SI-006 v0.3.** Three explicit out-of-scope items: (1) marker-claimed-emit-fails leaves audit missing (single-tx atomicity gap); (2) pre-existing crash-window for non-idempotency-protected Category A audits (general crash-recovery is out of scope); (3) async-consult HTTP test coverage gaps for state transitions requiring 48h-aging or terminal forms_submission seeding (gated on SI-001). These are honest closures, not regressions, but each one is a future-cycle attention item.
- **Repo-admin pending — Dependency Graph enablement.** PR #50 set the workflow to advisory mode; the gate cannot be re-armed until Evans flips the repo setting. Out-of-autonomous-scope.

## Process changes adopted

- **PROJECT_CONVENTIONS r5 promoted as canonical** (PR #54). The full SI-006 closure pattern catalog (§3.7 / §3.8 / §3.9 / §5.11 / §5.12) is now the authoring reference for future cross-cutting concurrency work.
- **Per-PR Codex review cadence + real-DB CI as final gate.** §5.12 mitigation explicitly: per-PR Codex review on each substantive iteration, not just final-PR. CI handler-lifecycle errors are the remaining gate after Codex closes. The combination caught all 18 substantive findings + 1 CI-revealed.
- **Documented-limitation discipline.** When a closure is intentionally bounded, the SI doc records the bound explicitly (§Documented limitations in SI-006 v0.3). Future cycles inherit the boundary as a known starting point rather than treating it as a missed gap.
- **`SCRUM_OPERATING_MODEL.md` amendment** later in the autonomous turn (`6faaea4` PR #76) bumped the status header from "Sprint 1 in progress" to "Sprint 34 closed 2026-05-08" — formal acknowledgement that the operating model's stable-status pointer had been ~33 sprints stale.

## Codex review findings closed

| PR | Finding | Severity | Round | Closure commit |
|---|---|---|---|---|
| #48 | cleanup-sweep `markIdempotencyManagedByHandler` deletion | (APPROVE) | r1 | `a02f101` |
| #49 | crash-window duplicate Category A audits (PR-F2 r4 deferred HIGH) | HIGH | r1 | `8257c8d` |
| #49 | audit-dedupe bodyHash + per-endpoint TTL alignment | HIGH | r2 | `d486e46` |
| #51 | async-consult HTTP coverage initial | (initial) | r1 | `ea025dd` |
| #51 | assertion-strength + helper-coverage hardening | MEDIUM | r2 | `78336bc` |
| #51 | helper-level tenant-leak assert + event_type pin | MEDIUM | r3 | `439a593` |
| #51 | CI-revealed `InvalidTransitionError` 500 leak + handler `mapServiceError` extension | MEDIUM (CI-revealed) | r4 | `9d854b0` |

Sprint 34 substantive closures: 1 HIGH + 5 MEDIUM (6 findings across 3 substantive PRs / 7 fix-forward rounds; the CI-revealed finding logged as MEDIUM per its lifecycle-interaction class).

Cumulative Sprint 33-34 closures per matrix r5: **18 substantive Codex findings closed across 11 PR iterations** (11 HIGH + 7 MEDIUM by severity; 13 substantive + 5 audit / lockdown / hardening by class).

## Carry-forward to next sprint

- **Repo-admin pending** — Evans-side enable Dependency Graph in `arthurmenson/telecheck-app` Settings → Code security → Dependency graph. Once flipped, the `continue-on-error: true` line in `dependency-review.yml` (PR #50) should be removed to re-arm the gate.
- **Spec corpus follow-on** — IDEMPOTENCY contract v5.1 → v5.2 bump in `telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE/Telecheck_Contracts_Pack_v5_00_IDEMPOTENCY.md` noting the canonical implementation pattern is now reserve-then-execute. Out of this app repo's scope.
- **SI-001 / SI-002 / SI-003 / SI-004 / SI-005** remain open at the spec-corpus governance layer. SI-004 / SI-005 closed during async-consult slice authoring (Sprint 9-10); SI-001 / SI-002 / SI-003 still pending P-011 / P-012 / P-013.
- **TLC-051 (Sprint 28-34 retro chain backfill)** — sprint plans and retros for Sprint 28-34 are gaps in the docs tree; the Sprint 35 anchor story TLC-051 will close this gap.
- **Sprint 35 candidates** — TLC-052+ from PRODUCT_BACKLOG.md depending on what unblocks (SI-001 closure → Pharmacy + Subscription; Med Interaction PRD ratification → Med Interaction slice; otherwise additional test-coverage gaps if any remain).

## Sprint reference / cross-links

- `SI-006-Idempotency-Reserve-Then-Execute-Redesign.md` v0.3 — implementation closure section (PR #53)
- `BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` r5 (PR #52) — Sprint 33-34 cumulative state documented
- `PROJECT_CONVENTIONS.md` r5 (PR #54) — §3.7 / §3.8 / §3.9 / §5.11 / §5.12 codified
- Per-slice status doc Sprint 33-34 amendments (PR #55 + corrections #56 / #57)
- `AUTONOMOUS_TURN_SUMMARY_2026-05-08.md` — the full autonomous-turn summary covering PRs #59-#81 (post-Sprint-34 README hygiene + test-gap closures, all CI-friendly maintenance work)
- `SPRINT_33_RETRO.md` carry-forward (cleanup-sweep + audit-dedupe SI + async-consult HTTP tests + docs r5 codification) — all closed here
- `SPRINT_35_PLAN.md` (next; TLC-051 retro chain backfill is the anchor story)
