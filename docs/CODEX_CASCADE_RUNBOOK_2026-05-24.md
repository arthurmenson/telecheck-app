# Codex Cascade Runbook — telecheck-app [CODEX-PENDING] queue reconciliation

**Authored:** 2026-05-24 (remote-cron autonomous firing, continuity verification)
**Purpose:** Make the May-26 Codex usage-limit-reset mass review + merge cascade *executable* against the current, verified state of `origin/main` and the 20-PR `[CODEX-PENDING]` queue.
**Supersedes the open question in:** cockpit Addendum 100 ("reconcile origin/main — option 1/2/3").

---

## 1. Continuity status — RESOLVED since Addendum 100

Addendum 100 (2026-05-24, earlier remote-cron firing) reported `origin/main` **stranded at migration 045 (`baca008`)**, with the 51-commit Codex-APPROVED foundation chain preserved off a detached HEAD as `origin/recovery/detached-work-through-051` (`f6c5160`), and recommended three reconciliation options for Evans.

**That reconciliation has since landed.** Verified this firing against the **live** remote (`git ls-remote origin refs/heads/main`), not the stale local tracking ref:

| Ref | Value | Meaning |
|---|---|---|
| live `origin/main` (telecheck-app) | **`f6c5160`** | = Addendum-100 Option 2 (full detached-chain adoption); fast-forward of main onto the recovery-chain tip |
| live `origin/main` (telecheckONE) | `5a17e7c` | = cockpit Addendum 104; current |

> **Trap that misled the briefing and the first half of this firing:** local `origin/main` *tracking* refs were stale (`baca008` for telecheck-app, `6adaae5` / "Addendum 71" for telecheckONE). A fresh `git fetch origin main` corrects them. **Always verify with `git ls-remote`, not `git rev-parse origin/main`, when continuity is in question.**

`origin/main` (`f6c5160`) now contains: migrations **046–051** (Med-Interaction DB layer + foundation-051 app-role acquisition), the Wave-1 first-read handlers (`get-signal.ts`, `get-crisis-event.ts`, `get-crisis-operational-health.ts`), and the Mode 1 `chat.ts` handler.

**Discipline note for the ratifier:** the FF to `f6c5160` adopted Addendum-100's **Tier-2 "ambiguous-APPROVE"** Wave-1 read handlers onto main without an unambiguous clean Codex APPROVE on record (Addendum 83 noted "Codex usage limit hit mid-cycle"). This is now a fait accompli on main (presumed Evans ratifier action, consistent with the Addendum-103 forms-intake merge cascade). It is **not** reversed here — advancing/rewinding main is an Evans-gated, hard-to-reverse shared-state action. Flagged for awareness; recommend a confirming Codex pass on the three read handlers during the May-26 cascade.

`origin/recovery/detached-work-through-051` (`f6c5160`) is now identical to main and has served its preservation purpose. Safe to delete **after** Evans confirms — not deleted here (deletion is operator-gated).

---

## 2. Per-PR cascade-readiness matrix (verified `git merge-base` / `git rev-list` vs `origin/main` = `f6c5160`)

"behind" = commits on main not on the PR branch (rebase distance). "ahead" = 1 for every branch (single-commit PRs).

| PR | Branch (abbrev) | behind | Status | Cascade action |
|---|---|---:|---|---|
| **#192** | med-interaction-pr3-readpath-mv-048 | 37 | **SUPERSEDED** | Adds `migrations/048_med_interaction_read_path.sql`; main already has migration 048 under a different name (`048_med_interaction_view_mv_access_function.sql`) + the 047 delta. **Recommend CLOSE-as-superseded.** |
| **#195** | med-interaction-pr7-signal-read | 13 | **SUPERSEDED** | Adds `signals.ts` + `signal-read-repo.ts`; main already ships a *different* implementation of the same endpoint (`get-signal.ts` / `get-signal.test.ts`). Addendum-100's flagged PR7 duplicate. **Recommend CLOSE-as-superseded.** |
| **#196** | med-interaction-pr8-post-evaluations | 2 | **SUPERSEDED** | `post-evaluation.ts` + 119-line `audit.ts`. Fully subsumed by **#208** (`create-evaluation.ts` + 304-line `audit.ts`, based on current main). Documented duplicate pair. **Recommend CLOSE-as-superseded by #208.** |
| #193 | ai-service-pr7-health-ready-wired-state-accuracy | 51 | NET-NEW, **needs rebase** | `/health`+`/ready` wired-state introspection fix. Rebase onto `f6c5160`, then Codex. |
| #194 | infra-migration-chain-ci-gate | 18 | NET-NEW, **needs rebase** | clean-room 000→head migration-chain CI gate. Rebase onto `f6c5160`, then Codex. |
| #197 | migration-chain-apply-bom-strip-and-app-role-provision | 0 | READY | Based on current main. Codex → merge. |
| #198 | i023-rls-lockdown-reconcile-crisis-admin-med-interaction | 0 | READY | tenant-scoped table count 25→39. Codex → merge. |
| #199 | crisis-sprint2-pr3-post-crisis-acknowledge | 0 | READY | (head `531e6ac` = the commit Addendum 100 called the acknowledge "local" — it IS this PR; not a separate dup.) Codex → merge. |
| #200 | plugin-wiring-reconcile-admin-crisis-post-firsthandler | 0 | READY | Codex → merge. |
| #201 | crisis-sprint2-pr2-post-crisis-event (initiate) | 0 | READY | Codex → merge. |
| #202 | crisis-sprint2-pr4-respond-resolve | 0 | READY | Codex → merge. |
| #203 | crisis-sprint2-pr5-get-patient-summary | 0 | READY | Codex → merge. |
| #204 | crisis-sprint2-pr6-sweep | 0 | READY | Codex → merge. |
| #205 | admin-sprint2-pr2-post-forms-template-submit | 0 | READY | Codex → merge. |
| #206 | admin-sprint2-pr3-post-forms-template-decision | 0 | READY | Codex → merge. |
| #207 | admin-sprint2-pr4-dashboard-reads | 0 | READY | Codex → merge. |
| #208 | med-interaction-pr8-write-handlers | 0 | READY | create-evaluation + emit-signal + activate-signal + 304-line audit.ts. Canonical over #196. Codex → merge. |
| #209 | med-interaction-pr9-remaining-write-handlers | 0 | READY | 4 remaining write handlers (supersede/override/...). Codex → merge. |
| #210 | ai-service-mode2-case-prep-handler | 0 | READY | POST /v0/ai/case-prep (Mode 2). Codex → merge. |
| #211 | infra-migration-bom-guard | 0 | READY | UTF-8 BOM guard + strip (047–050 + rollback). Codex → merge. |

(Dependabot PRs #90/#91/#188/#189/#190 and stale sprint-close docs PRs #31/#32/#37 + SI-doc PRs #137/#138/#139 are outside the pilot-scope handler cascade.)

---

## 3. Recommended May-26 cascade execution order

1. **Close the 3 superseded PRs first** (#192, #195, #196) — Evans's call (shared-state). Removes false dependencies and duplicate-attempt noise before Codex runs. Branches are preserved on origin regardless.
2. **Infra/CI gates** (rebase #194 onto main first): #211 BOM guard → #197 migration-chain apply → #194 migration-chain CI gate → #198 RLS lockdown reconcile. These harden the base the handler PRs assume.
3. **Med-Interaction write path:** #208 (3 write handlers) → #209 (4 remaining). #208 introduces `src/lib/audit.ts`; merge before any other PR that imports it.
4. **Crisis Sprint 2:** #201 initiate → #199 acknowledge → #202 respond/resolve → #203 patient-summary → #204 sweep. (#200 plugin-wiring reconcile alongside.)
5. **Admin Sprint 2:** #205 submit → #206 decision → #207 dashboard reads.
6. **AI Service:** #193 (rebase first) health/ready fix; #210 Mode 2 case-prep.

Each merge: Codex APPROVE (mandatory) → squash-merge → cockpit Addendum + `telecheckONE/progress.json` bump (per the standing addendum-trail discipline).

---

## 4. Environment reality (why this is a runbook, not a merge log)

- **Codex is unavailable in the remote-cron environment** (no `OPENAI_API_KEY`, no `codex` binary). No queue PR can be merged here — merge requires Codex APPROVE per the discipline floor. The cascade runs when the usage limit resets (May 26) in an env where Codex is reachable, or under Evans's explicit per-PR ratifier authority.
- **Async-Consult** (the next net-new slice after the queue drains) remains **ratification-blocked**: SI-004 (Async-Consult audit events) and SI-005 (Consult/ConsultEvent schema gap) are annotated SUPERSEDED-FOR-RATIFICATION, pending the spec-corpus ratifier ceremony (Evans + Engineering Lead + CDM owner). Spec-ratification-leads-implementation-by-≥1-sprint floor forbids starting its DB layer. **STOP condition** — do not author.
