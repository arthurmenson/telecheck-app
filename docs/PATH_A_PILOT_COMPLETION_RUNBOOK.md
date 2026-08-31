# Path A — Pilot Completion Runbook (RATIFIED, Pass-2 gates baked in)

**Filed:** 2026-08-30 (original)
**Revised:** 2026-08-30 (post-ratification; supersedes original)
**Status:** RATIFIED — Path α per Evans 2026-08-30 chat message *"go with your recommendation and continue working nonstop"*
**Ratifier decision record:** `Engineering-Review-Request-Path-A-Compliance-Reframe-2026-08-30.md`
**Owner:** Evans (workstream lead) + Claude (autonomous execution under standing directive)
**Adversarial reviewer:** Codex per-PR
**Target:** Pilot 1 (synthetic-only workflow rehearsal on Hetzner staging) → Pilot 2 (real-PHI Ghana chronic-care on compliant substrate)

---

## Why this document was rewritten

The original filing (commit `e86719f`) framed Path A as a 10-real-Ghana-patient pilot on the Hetzner staging VPS. Codex R1 correctly identified this as NO-SHIP:
- Hetzner staging is synthetic-data-only per `STAGING_RUNBOOK.md`; loading real PHI violates the substrate's own posture
- SI-014 crisis detection has zero Twi coverage per ADR-030; per-patient I-019 invariant does not scale down with cohort size
- Rollback plan was not real recovery (audit append-only; no PITR)
- PII-leak mitigation was not incident response

Codex Pass-2 concurred with Option A over B/C directionally but flagged three additional gates:
1. "Zero compliance exposure" is overstated → **materially reduced**; needs enforceable synthetic-only technical gates
2. Pilot 2 prerequisites omit cross-border + full subprocessor authorization (US HIPAA BAA ≠ Ghana DPA authorization)
3. Pilot 1 needs measurable exit criteria + coverage matrix; must be framed as **workflow rehearsal not clinical validation**

This revision bakes all three gates in.

---

## Two-pilot structure

### Pilot 1 — Synthetic-only closed beta (workflow rehearsal)

**Purpose:** validate the clinical workflow end-to-end with synthetic identities + scripted scenarios + adversarial edge cases, on the existing Hetzner staging substrate. **NOT clinical validation.**

**Participants:** ~10 volunteer testers (Heros team, friendly clinicians, contracted UX researchers) who sign the synthetic-participant consent form (`PILOT_1_SYNTHETIC_PARTICIPANT_CONSENT.md`) and agree to use synthetic identities + approved scenarios only.

**What it validates:**
- End-to-end workflow shape (patient signup → intake → AI Mode 1 → consult submit → clinician claim → decision → medication_request lifecycle)
- Cross-tenant isolation under real (synthetic) traffic
- Audit chain integrity under real volume
- Ghana clinician console UX on real console with synthetic cases
- Crisis-detection heuristic behavior against contrived English distress prompts
- AI Mode 1 cost baseline per synthetic patient
- Bug surface in staging without patient risk

**What it does NOT validate:**
- Real patient outcomes
- Real regulatory prescribing path
- Real payment
- Real 10DLC deliverability
- Ghana Twi crisis detection (deferred to Pilot 2 gate)
- Ghana-population representative use patterns

**Exit criteria to advance to Pilot 2:** `PILOT_1_COVERAGE_MATRIX.md` §Exit Gate

### Pilot 2 — Real-PHI Ghana chronic-care

**Purpose:** first revenue on real regulatory footing with real patients receiving real care.

**Gated on:** every checkbox in `PILOT_1_TO_PILOT_2_GATING_CHECKLIST.md` marked ✅

Not scoped in this runbook. Executed under a separate Pilot-2 runbook to be filed at Pilot 1 exit gate.

---

## Pilot 1 substrate — enforceable synthetic-only gates

Pass-2 finding 1: "zero compliance exposure" is overstated. Consent alone does not sanitize the data path — volunteers can leak real PHI/PII into free text, AI-vendor payloads, logs, backups. Pilot 1 requires enforceable **technical** + **operational** gates before any participant onboards.

### Technical gates (implementation required; owned by Claude)

**Status legend:** ⬜ = spec'd but not yet implemented + deployed + adversarial-tested. ✅ = implemented + deployed + adversarial-tested + rehearsed. **Documentation completion does NOT flip ⬜ → ✅.** Only shipped, tested, deployed implementation does, and each transition must cite the implementation PR + adversarial-test evidence.

Per `PII_SCREENING_AND_LOG_REDACTION_SPEC.md`:

- ⬜ Input screener on all patient-facing free-text endpoints — regex + local NER PII detection (NEVER external LLM); block-or-warn on real-name / real-phone / real-address / real-SSN / real-DoB / real-medical-record-number patterns. **Evidence required:** implementation PR + adversarial-test suite result + deployment verification.
- ⬜ Output screener on all clinician-facing rendered content — same categories. **Evidence required:** implementation PR + adversarial-test.
- ⬜ Log redaction of any PII pattern that reaches pino (extends `LOG_REDACT_PATHS`). **Evidence required:** implementation PR + regression-test.
- ⬜ AI-vendor payload sanitization — regex-only local pass before every outbound AI provider call. **Evidence required:** implementation PR + test proving no candidate text egresses.
- ⬜ Backup redaction — any Postgres dump pre-scrubs patterns before hitting durable storage. **Evidence required:** implementation PR + verified test dump.
- ⬜ Environment purge/reset procedure — `scripts/pilot-1-env-purge.sh` — wipes DB + Redis + Caddy access logs + `/home/deploy/incident-logs/` (with active-RCA opt-out); idempotent; rehearsed. **Evidence required:** script + rehearsal log recording <120s runtime + verified clean baseline post-purge.

### Operational gates (owned jointly)

- ⬜ Synthetic-identity discipline — kit generated + distributed to participants:
  - Participant handles: `pilot1-participant-01` … `pilot1-participant-10` (no real names)
  - Synthetic DoB from a controlled range (all 1990-01-01; discriminator is participant number)
  - Synthetic phone: reserved Telnyx test numbers only (never a participant's real number)
  - Synthetic address: `[SYNTHETIC ADDR] 1 Test Way, Test City TC 00000`
  - **Evidence required:** kit-generator script + Evans-confirmed distribution
- ⬜ Explicit prohibition + training against real personal/clinical data — one-pager training document delivered with consent form. **Evidence required:** document + Evans confirmation delivered.
- ⬜ Named incident owner: Evans (with Claude as on-call responder). **Evidence required:** Evans's explicit acknowledgment in chat/commit.
- ⬜ Rehearsed stop criterion per `PILOT_1_INCIDENT_RESPONSE_MINI_RUNBOOK.md` §Stop — **rehearsed at least once end-to-end before Day-0**. **Evidence required:** rehearsal log entry.
- ⬜ Least-privilege access: pilot participants get patient-role only; no admin console access. **Evidence required:** RBAC verification test.
- ⬜ Tenant-isolation live tests: `scripts/staging-e2e-smoke.sh --tenant Telecheck-Ghana` cross-tenant negative assertion run before every Pilot 1 session. **Evidence required:** rehearsal log entry + green smoke.

### Pilot 1 startup authorization checklist (blocks Day-0)

Pilot 1 Day-0 dry run is NOT authorized until:

- [ ] Every ⬜ above flipped to ✅ with cited implementation PR + adversarial-test evidence
- [ ] Codex adversarial review completed on each implementation PR with APPROVE verdict
- [ ] Full incident-response STOP-and-purge drill executed once end-to-end with recorded runtime + friction findings
- [ ] Evans's explicit chat-message go-ahead confirming (a) participant roster signed + kit-distributed, (b) VPS reachability verified, (c) startup authorization

Documentation-only completion of this runbook (i.e., merging this PR) does NOT authorize Day-0. It authorizes STARTING the Sprint 1 implementation work.

### Compliance posture (rewritten per Pass-2)

**"Materially reduced compliance exposure — not zero."** Consent + synthetic-identity discipline + enforceable technical screening + rehearsed incident response together reduce exposure to a range where the residual risk is (a) a participant deliberately violating consent by injecting real data (mitigated by input screening + participant training + immediate purge on detection), or (b) a subtle screening bypass (mitigated by defense-in-depth + audit-chain reconstruction of any incident).

Pilot 1 remains inappropriate for real patient PHI regardless. That is what Pilot 2 substrate exists to solve.

---

## Operator-owned blockers (Evans only)

Ordered by criticality. Numbered O-N to preserve traceability from prior runbook drafts.

### O-1 — Pilot 1 participant recruitment ⛔ CRITICAL

Recruit ~10 volunteers to sign the synthetic-participant consent form. Ideal mix:
- 3–4 Heros team members
- 2–3 friendly clinicians (Ghana-licensed preferred for realistic clinician workflow; US-licensed acceptable)
- 2–3 contracted UX researchers or friendly patient-persona testers

**Evans deliverables to Claude:**
- List of 10 participants (real names for records; handles for use in system)
- Consent form signatures (kept off-repo per consent template `PILOT_1_SYNTHETIC_PARTICIPANT_CONSENT.md` §Storage)
- Ghana clinician identity for the clinical-review side of the workflow

### O-2 — Track 5 kickoff signal ⛔ REQUIRED FOR PILOT 2

Track 5 (Pilot 2 substrate: AWS + BAA + KMS + backups + SIEM + IR runbook + Ghana counsel prep) is the long-lead work. Starting now = Pilot 2 substrate exists when Pilot 1 exits.

**Evans decisions to unblock Track 5:**
- AWS root-account + IAM setup path (Evans owns; Claude cannot create AWS accounts)
- Ghana counsel engagement — who? (existing Heros Health Ghana counsel? new engagement? via which firm?)
- Region selection (us-east-1 was assumed in ADR-026; Pass-2 flagged this should follow counsel review, not precede it)
- Budget approval for AWS baseline (~$500–$2,000/mo per prior estimate)

### O-3 — Telnyx 10DLC (deferred to Pilot 2)

Under Path α, Pilot 1 does NOT need real SMS — synthetic identities use reserved Telnyx test numbers or email-only auth. 10DLC becomes Pilot 2 gate. Checklist at `TELNYX_10DLC_ACTIVATION_CHECKLIST.md` remains valid but non-blocking for Pilot 1.

### O-4 — DNS (deferred to Pilot 2)

Pilot 1 stays on sslip.io wildcard. `ghana.heroshealth.com` DNS cutover becomes Pilot 2 gate.

### O-5 — VPS reachability confirmation 🟡 SESSION-1 CHECK

I could not reach `87.99.159.214.sslip.io/*` from my machine 2026-08-30 (curl timeout). Evans confirms VPS reachability from a browser or their own curl before Pilot 1 Day-0 dry run. If VPS is down, reprovision from `infra/staging/STAGING_RUNBOOK.md` (~20 min).

---

## Claude execution slate (autonomous under standing directive)

**Immediate work (this PR):**
- ✅ Runbook revised with Pass-2 gates baked in (this file)
- ✅ Pilot-1 → Pilot-2 gating checklist authored
- ✅ Synthetic-participant consent form authored
- ✅ Pilot 1 coverage matrix + adversarial scenarios authored
- ✅ Pilot 1 IR mini-runbook authored
- ✅ PII-screening + log-redaction spec authored

**Sprint 1 — Pilot 1 substrate implementation** *(next autonomous cycles)*

1.1 — PII-screening implementation (per spec) — backend engineer subagent
1.2 — Log-redaction extension (per spec) — backend engineer subagent
1.3 — Env-purge script implementation — DevOps subagent
1.4 — Synthetic-identity kit generator (deterministic seed script variant)
1.5 — Coverage-matrix adversarial-scenario harness (integration test additions)
1.6 — Codex Phase-D corpus-wide 42702 sweep resume (paused-work continuation)

Each ships as separate PR through Codex convergence → APPROVE → merge → addendum + cockpit bump.

**Sprint 2 — Track 5 (Pilot 2 substrate) kickoff** *(parallel with Sprint 1)*

Starts on Evans's O-2 signal (AWS account + counsel engagement):
2.1 — AWS Terraform skeleton (VPC + IAM + KMS + Secrets Manager scaffold)
2.2 — Ghana counsel prep document (cross-border transfer basis + subprocessor authorization matrix + DPIA scoping questions)
2.3 — HIPAA BAA vendor inventory (AWS, Anthropic, Resend, Telnyx — status + procurement path per each)
2.4 — SIEM shipping design (pino → SIEM candidate options)
2.5 — IR runbook full draft (extends the Pilot 1 mini-runbook to real-PHI incident response)

**Sprint 3 — Ratifier queue burn-down** *(parallel with Sprints 1+2, ratifier-quorum-gated)*

3.1 — Enumerate + prioritize 25 queued SIs by Pilot-1-vs-Pilot-2 blocking status
3.2 — Draft dual-recommendation briefs for SI-013 (Ghana crisis helplines), SI-014 (Twi crisis coverage — Pilot 2 gate), SI-007, SI-012, SI-016
3.3 — Ratifier ceremonies as quorum availability permits

**Sprint 4 — Pilot 1 dry run + execution** *(gated on Sprints 1 + O-1)*

4.1 — Pilot 1 Day-0 dry run: full E2E with one synthetic participant across every coverage-matrix scenario
4.2 — Pilot 1 Day-1 through Day-N: real synthetic participants; daily audit-chain check; weekly coverage-matrix advancement
4.3 — Pilot 1 exit-gate assessment: coverage matrix completion + defect log + Pilot-2-readiness recommendation

---

## Hard sequencing rules (unchanged from Master Completion Plan)

1. **Nothing goes to real patients until Pilot 2 gate is green.** Pilot 1 is synthetic-only, period.
2. **Codex APPROVE mandatory per PR.**
3. **Every ratification requires quorum (Evans + Engineering Lead + CDM owner).** Claude prepares dual-recommendation briefs; Claude does not ratify.
4. **Audit invariants (I-003, I-019, I-023, I-025, I-027) are platform-floor.**
5. **Rollback path documented before every mutation.** For Pilot 1: env-purge script IS the rollback; audit chain reconstruction IS the forensic path.
6. **Cross-tenant isolation verified on every pilot-touching PR.**
7. **Every merged PR gets an Addendum + cockpit revision bump.**

## Failure modes + mitigations (revised per Pass-2)

| Failure | Mitigation |
|---|---|
| Participant injects real PHI into free-text | Input screener blocks + immediate participant notification + purge affected records + audit-chain event; if persistent pattern, participant removal + consent violation ceremony |
| Screening bypass (novel PII pattern) | Defense-in-depth: log-redaction + backup-scrub catch escapes; incident-response mini-runbook triggers on detection |
| VPS reachability lost | Reprovision from `STAGING_RUNBOOK.md`; pilot pauses (no PHI loss because Pilot 1 has none) |
| Codex Phase-D sweep surfaces CRITICAL on architectural judgment | STOP + escalate per hard-floor item 6 |
| Track 5 stalls on AWS/counsel availability | Pilot 1 continues; Pilot 2 gate simply lengthens; no Pilot 1 impact |
| Ratifier quorum unavailable for Pilot 2 SIs | Pilot 2 gates lengthen; Pilot 1 stability data accumulates in the interim (positive) |
| Cross-tenant isolation regression detected mid-Pilot-1 | Immediate participant pause + isolation-restoration ceremony; participant data quarantined (synthetic, low-risk) |
| Pilot 1 coverage matrix stalls under-representative | Add adversarial scenarios; extend Pilot 1; do NOT advance to Pilot 2 on incomplete matrix |

## Cadence

Standing autonomous-work directive (CLAUDE.md 2026-05-16+) applies. Auto-proceed rule active. Reporting to Evans at natural checkpoints: Sprint boundaries, blocker-clear moments, operator-input-needed moments, Pilot 1 exit-gate assessment.

## Status pointer

- **Ratifier decision:** Path α ratified 2026-08-30 (Evans chat message).
- **Cockpit revision:** to be bumped 463 on merge of this PR.
- **Next action after merge:** Sprint 1.1 (PII-screening implementation) + Sprint 2.1 (AWS Terraform skeleton) begin in parallel on the O-2 signal.

## Companion docs

- `Engineering-Review-Request-Path-A-Compliance-Reframe-2026-08-30.md` — the ratifier decision record + full R1/Pass-2 findings
- `PILOT_1_TO_PILOT_2_GATING_CHECKLIST.md` — the Pilot-2 exit-gate matrix
- `PILOT_1_SYNTHETIC_PARTICIPANT_CONSENT.md` — consent template
- `PILOT_1_COVERAGE_MATRIX.md` — scripted + adversarial scenarios + exit gate
- `PILOT_1_INCIDENT_RESPONSE_MINI_RUNBOOK.md` — named owner + rehearsed stop
- `PII_SCREENING_AND_LOG_REDACTION_SPEC.md` — technical gate spec
- `TELNYX_10DLC_ACTIVATION_CHECKLIST.md` — deferred Pilot 2 checklist
- `infra/staging/STAGING_RUNBOOK.md` — VPS provisioning + recurring ops
- `Telecheck_Master_Completion_Plan_v1_0.md` (spec bundle) — parent plan; this runbook operationalizes Phase D under Path α reframe
