# Path A — Ghana Pilot Completion Runbook

**Filed:** 2026-08-30
**Status:** ACTIVE — Path A authorized to completion per Evans 2026-08-30
**Owner:** Evans (workstream lead) + Claude (autonomous execution under standing directive)
**Adversarial reviewer:** Codex (per-PR; sweep resumed under this runbook)
**Target:** Ghana pilot soft launch — 10 real chronic-care patients on Telecheck-Ghana tenant

---

## Purpose

This runbook is the single source of truth for driving the Ghana pilot to first revenue under Path A (the recommended path from the 2026-08-30 completion assessment). It supersedes ad-hoc sprint planning between now and pilot go-live.

**Explicitly out of scope:** Phase E (US regulatory + pharmacy portal) and Phase F (multi-tenant production on AWS). Those are separate workstreams that begin after pilot is stable OR in parallel if Evans wants to widen scope.

---

## Current pilot readiness

Per the 2026-08-30 assessment + cockpit rev 462 + Addenda through 357:

| Layer | State | Notes |
|---|---|---|
| Backend slices (7/7 pilot-required) | ✅ Green | Mode 1 chat, Med-Interaction, Crisis Response, Subscription, Admin Backend, Mode-1-volume dashboard, Email+PIN auth all live-verified |
| Both operating tenants | ✅ Live | Cross-tenant isolation verified end-to-end (Addendum 345) |
| Staging infra (Hetzner CX22) | 🟡 Reachability unverified 2026-08-30 | Curl to `87.99.159.214.sslip.io/*` timed out from Windows dev machine — VPS reachability needs Evans-side confirmation before pilot |
| Email delivery (Resend) | ✅ Live | Real passcode emails delivering (Addendum 353) |
| SMS delivery (Telnyx) | ⛔ Blocked | Code deployed + key staged; **inert on 10DLC** |
| Admin console (SI-025 Phase 2) | ✅ Live | Platform admin can provision AI credentials |
| Patient app on real API | ✅ Live | Email+PIN signup verified end-to-end (Addenda 340, 350) |
| Migration chain | 🟡 Gap at slot 072 | 070, 071, 073…079 — slot 072 empty; verify no dangling reference before pilot |
| Codex Phase-D sweep | ▶ RESUMED under this runbook | Was paused 2026-07-08; resumed on Evans's 2026-08-30 "go" |

**Rollup:** Pilot is ~90% code-complete, ~80% infra-complete. Gap-closing work is the scope of this runbook.

---

## Operator-owned blockers (Evans only)

These items **must** clear before pilot patients can be onboarded. Ordered by criticality.

### O-1 — Telnyx 10DLC brand + campaign registration ⛔ CRITICAL

**Blocker for:** real patient phone-OTP delivery on any US-sourced traffic. Ghana patients receiving on non-US carriers are less blocked but the sender number `+13468450373` is a US-registered number, so 10DLC completion protects deliverability broadly.

**Steps:** follow `telecheck-app/docs/TELNYX_10DLC_ACTIVATION_CHECKLIST.md` verbatim.

**Rough effort:** ~30 min portal work + ~1–3 business days TCR approval (healthcare 2FA is a fastest-approved category).

**Cost:** ~$4 brand + ~$40 optional vetting (recommended for healthcare) + ~$10/mo campaign + carrier per-campaign fees.

**Evans deliverables to Claude when complete:**
- Brand ID
- Campaign ID
- Messaging profile ID to use for OTP (reuse `heros-console-messaging` or new dedicated)
- Confirmation the sender number `+13468450373` is attached to the approved campaign

**Claude flip on receipt (~2 min):** set `SMS_PROVIDER=telnyx` + `TELNYX_MESSAGING_PROFILE_ID=<...>` in `infra/staging/.env`, recreate app, live-verify a real OTP text to a destination number Evans provides. Rollback remains `SMS_PROVIDER=noop`.

### O-2 — First pilot cohort logistics 🟡 REQUIRED

**Blocker for:** actually seeing patients. Claude cannot recruit patients or credential clinicians.

**Evans decisions needed:**
1. **Ghana clinician-on-call identity** — who is the licensed prescriber for the first cohort? What are their Ghana Medical & Dental Council credentials? Physical practice location (jurisdictional anchor for prescribing per CCR)?
2. **Recruitment channel** — where do the first 10 patients come from? (Existing GLP-1 waitlist from Heros Health Ghana marketing? Clinician referrals? Recruit fresh?)
3. **Medication scope** — pilot to chronic-care anchor per Ghana ADR. Confirm: GLP-1 only, or broader chronic-care (hypertension, diabetes management, cholesterol)?
4. **Consent flow** — is the standard consent template acceptable for pilot, or does Ghana MDC/DPA require anything specific?
5. **First cohort seed data** — for each of 10 patients: name, phone (E.164), email, DoB, condition, initial medication. Once Evans provides this, Claude seeds via `scripts/seed-staging-accounts.sql` extension.

### O-3 — Payment processor decision 🟡 CHOICE

**Blocker for:** revenue capture. Two acceptable paths:

**Option A (recommended for pilot):** Bill offline for the first cohort. Charge via existing Heros Health Ghana payment rail; Telecheck just handles clinical care. Pilot proves out clinical workflow before wiring payment integration.

**Option B:** Wire MTN MoMo now. Adds ~2 sprints (merchant account, callback wiring, subscription slice CCR routing, testing). Would delay pilot go-live.

**Claude default if no Evans input:** Option A — bill offline, unblock pilot fast, wire MTN MoMo post-launch when volume justifies.

### O-4 — Production DNS decision 🟡 CHOICE

**Blocker for:** how "real" pilot looks to patients.

**Option A (recommended for pilot):** Keep the sslip.io wildcard for the 10-patient pilot. Patients receive links to `ghana.87.99.159.214.sslip.io`. Ugly URL but zero DNS surface to manage. Cheap.

**Option B:** Cut `ghana.heroshealth.com` over now. Requires: DNS A record → `87.99.159.214`, Caddy config update to add new site block, cert re-issue, `TENANT_HOST_OVERRIDES` update in `.env`. ~1 hour work; adds one thing to break.

**Claude default if no Evans input:** Option A for the first 10 patients, cut over to `ghana.heroshealth.com` at cohort 2 (20–50 patients) once we've observed pilot-1 without domain-cutover risk in the mix.

### O-5 — Migration slot 072 gap ✅ RESOLVED (no action needed)

**Verified 2026-08-30:** the 072 gap is **intentional + documented**. Migration 074's header comment reads verbatim: *"This migration takes slot 074, the next free number above the merged 073 — 072 was never used."* Migration 073 cross-references the deliberate skip. The chain checker (`scripts/check-migration-chain.sh`) iterates existing `NNN_*.sql` files and does not enforce contiguous numbering; a skipped slot is not a chain defect.

Root cause of the confusion: a 52-day-old memory (`project_phase_d_sweep_paused.md`) suggested uncommitted partial work sat as migration 072. Working tree is clean; that work either dropped or landed via a different vehicle. Memory updated 2026-08-30.

**No PR needed. Chain integrity is honest as-is.**

---

## Claude execution slate (in order, autonomous under standing directive)

Each item is a discrete PR. Each PR goes through Codex adversarial review to APPROVE, gets an addendum + cockpit bump on merge.

### Sprint 1 — Pilot readiness pass (this cycle)

**1.1 — Migration-072-gap resolution** ✅ CLOSED 2026-08-30
- Verified intentional skip; documented in migrations 073/074 headers; chain checker unaffected. No PR needed.

**1.2 — Codex Phase-D sweep resume** *(this session)*
- Re-invoke corpus-wide 42702 RETURNS-TABLE OUT-param scan (memory notes this was the R1 charter)
- Any surviving findings → separate PRs, one per class
- Explicit target: converge to zero HIGH/CRITICAL

**1.3 — Staging reachability + health verification** *(gated on Evans confirming VPS is up)*
- On Evans's go, curl `/ready` on both tenant hosts, run `scripts/staging-e2e-smoke.sh` for both `Telecheck-US` and `Telecheck-Ghana`
- Verify: audit chain intact, both tenants isolation-verified, no drift since Addendum 357
- If red: triage + fix; if green: mark pilot-infrastructure GREEN

**1.4 — Ghana pilot seed template** *(this cycle)*
- Extend `scripts/seed-staging-accounts.sql` with a `--pilot-cohort` parameterized template
- 10-patient slot structure; fills in from a CSV Evans provides
- Ghana clinician provisioning stub pending O-2 answers

### Sprint 2 — Ratification burst (parallel with Sprint 1; ratifier-availability-gated)

**2.1 — SI queue triage + priority ranking**
- Enumerate all 25 queued SIs by pilot-blocking status
- Pilot-blocking: SI-013 (CCR crisis helpline keys — Ghana needs), SI-014 (crisis detection classifier — I-019 live path)
- Not pilot-blocking (defer to post-launch): SI-006, SI-007, SI-012, SI-016 and others
- Draft dual-recommendation (Claude + Codex Pass-1 + Pass-2) briefs for each pilot-blocking SI

**2.2 — SI-013 ratification cycle**
- Draft canonical CCR key set for Ghana crisis helplines (Ghana Suicide Prevention 2333 / other Ghana MOH-published lines)
- Codex Pass-1 + Pass-2 → surface to Evans → ratifier decision → Promotion Ledger entry
- Implementation PR follows ratification

**2.3 — SI-014 ratification cycle** *(if pilot-blocking; otherwise defer)*
- Determine whether Mode 1 crisis-signal detection is heuristic-adequate for pilot volume (10 patients)
- If yes: defer classifier build; document ADR
- If no: draft classifier scoping brief; ratifier decides scope

### Sprint 3 — 10DLC-ready + operator-cutover (gated on O-1)

**3.1 — SMS provider flip verification** *(on Evans's Telnyx completion)*
- Flip `SMS_PROVIDER=telnyx`; restart app; verify one OTP end-to-end to Evans-provided destination
- Roll back to `noop` if any smoke failure
- Addendum + cockpit bump

**3.2 — Ghana pilot seed load** *(on Evans's cohort roster)*
- Run seed script against staging with Evans's 10-patient CSV
- Verify each patient can email-PIN in and phone-OTP in
- Verify Ghana clinician can log into console + see queue

**3.3 — Pilot Day-0 dry run**
- Full E2E: patient signs up → intake → AI Mode 1 chat → consult submit → Ghana clinician claims → decision → medication_request created → patient sees decision
- Both under phone-OTP and email-PIN paths
- Audit chain verification post-run

### Sprint 4 — Pilot Day-1 → Day-30 monitoring cadence

**4.1 — Daily health check**
- Cron or manual: audit chain integrity, `/ready` both tenants, error-rate baseline, AI cost per patient
- Findings → Addendum

**4.2 — Weekly cohort review**
- Together with Evans: patient volume, clinician load, defect log, hardening opportunities

**4.3 — Cohort-2 gate**
- Explicit go-decision after 30 days of pilot-1 stability
- Cohort-2 (20–50 patients) triggers: `ghana.heroshealth.com` DNS cutover (O-4 Option B), pharmacy portal decision, MTN MoMo wiring decision

---

## Hard sequencing rules (do not violate)

1. **Nothing goes to real patients until Sprint 3 dry run is green.** Even if 10DLC clears early. The pilot Day-0 dry run is non-negotiable.
2. **Codex APPROVE mandatory per PR.** No exceptions.
3. **Every ratification requires Evans + Engineering Lead + CDM owner quorum.** Claude prepares dual-recommendation briefs; Claude does NOT ratify.
4. **Audit invariants (I-003, I-019, I-023, I-025, I-027) are platform-floor.** No relaxation.
5. **Rollback path documented before every mutation.** SMS flip, DNS cutover, seed load — each has an explicit rollback command.
6. **Cross-tenant isolation verified on every pilot-touching PR.** Never regressed silently.
7. **Every merged PR gets an Addendum + cockpit revision bump.** Addendum-trail is the continuity mechanism.

---

## Cadence

**Under standing autonomous-work directive (CLAUDE.md 2026-05-16+):**
- Claude works continuously through per-PR Codex cycle without per-action confirmation
- Auto-proceed rule applies: Claude recommendation + Codex Pass-2 synthesis converge → Claude executes
- STOP conditions: any of hard-floor items 1–6 in CLAUDE.md, any operator-gated blocker above, any Codex CRITICAL finding on architectural judgment

**Update format per merged PR:**
- Addendum N+1 in `Telecheck_v1_10_PRD_Update/AI_Service_Rollout_24h_Status_2026-05-14.md`
- `progress.json` revision bump
- Git commit with Codex APPROVE artifact reference in body

**Reporting to Evans:**
- Batched at natural breakpoints (Sprint boundaries, blocker-clear moments, operator-input needed)
- Not per-PR (would be noise given the standing authorization)

---

## Failure modes + mitigations

| Failure | Mitigation |
|---|---|
| Staging VPS unreachable | Evans confirms + restarts; if VPS lost, reprovision from `infra/staging/STAGING_RUNBOOK.md` in ~20 min |
| Codex Phase-D sweep surfaces CRITICAL on architectural judgment | STOP + escalate to ratifier per hard-floor item 6 |
| Telnyx 10DLC rejected | Fallback: recruit pilot patients on non-US phone numbers where 10DLC doesn't apply, OR use email+PIN auth path exclusively for pilot-1 (already live) |
| Ghana clinician provisioning delayed | Pilot Day-0 slides right; Claude cannot substitute |
| Ratifier quorum unavailable | SI-013 defer if not pilot-blocking; document decision |
| Patient PII leak during pilot | Audit chain trace + tenant-blindness check per I-023/I-025; kill switch = `SMS_PROVIDER=noop` + take app offline; ceremony post-incident |
| First real patient reports harmful AI Mode 1 response | I-019 crisis floor triggers; escalate manually; document; pause Mode 1 if pattern |

---

## Status pointer

- **This runbook is canonical for Path A execution 2026-08-30 onward.**
- **Cockpit revision:** to be bumped 463 on first merged PR under this runbook.
- **Latest merged PR under Path A:** none yet — this doc itself is the first Path A merge.
- **Next action:** Claude executes Sprint 1.1 (migration-072-gap resolution).

## Companion docs

- `TELNYX_10DLC_ACTIVATION_CHECKLIST.md` — Evans's O-1 checklist
- `STAGING_RUNBOOK.md` (in `infra/staging/`) — VPS provisioning + recurring ops
- `Telecheck_Master_Completion_Plan_v1_0.md` (in spec bundle) — parent plan; this runbook operationalizes Phase D
- `AI_Service_Rollout_24h_Status_2026-05-14.md` — Addendum trail (running log)
- `progress.json` (repo root) — cockpit state
