# Engineering Review Request — Path A Compliance Reframe

**Filed:** 2026-08-30
**Escalated by:** Claude (autonomous execution under Evans's 2026-08-30 "go" authorization + hard-floor item 6 STOP-and-escalate)
**Ratifier:** Evans
**Discipline anchor:** dual-recommendation process (CLAUDE.md 2026-05-20 codification)
**Triggering event:** Codex R1 adversarial review on `PATH_A_PILOT_COMPLETION_RUNBOOK.md` returned 1 CRITICAL + 3 HIGH architectural-judgment findings

---

## Context

Evans authorized "go with your current recommendation to completion" on 2026-08-30, referring to Path A (Ghana 10-patient chronic-care pilot on the Hetzner staging VPS). Claude filed `PATH_A_PILOT_COMPLETION_RUNBOOK.md` (commit `e86719f` on branch `docs/path-a-pilot-completion-runbook`) as the canonical execution document. Codex R1 adversarial review on that runbook surfaced fundamental compliance + safety gaps in the pilot framing. Under CLAUDE.md hard-floor item 6, architectural-judgment findings require STOP + ratifier escalation. This ERR is the escalation artifact.

## Codex R1 findings (verbatim summary)

### CRITICAL — Hetzner staging VPS is not PHI-capable infrastructure

Per `infra/staging/STAGING_RUNBOOK.md`, the VPS is deliberately positioned as *"a cheap, always-on, internet-reachable test environment"* for *"end-to-end testing, the mobile/console apps, and pilot rehearsal"* with *"synthetic data only"*. No HIPAA BAA with Hetzner, no Ghana DPA processor agreement, no encrypted off-host backups, no formal retention/deletion/access controls, no per-tenant managed encryption (staging uses env-key encryption; production KMS-per-tenant per ADR-024 is deferred). Loading real chronic-care patient PHI onto this substrate is a compliance violation regardless of cohort size.

**Codex recommendation:** make PHI-capable hosting a mandatory Day-0 gate before any roster import. Hetzner staging stays synthetic-only unless it is formally upgraded and re-authorized.

### HIGH — SI-014 crisis-detection multilingual gap

The runbook framed SI-014 as "defer if pilot-blocking; heuristic may be adequate for 10 patients." ADR-030 evidence establishes that the current regex detector has zero Twi coverage and can silently miss crisis content. The I-019 crisis-detection invariant is per-patient; cohort size does not scale it down. Sprint 3 requires patient-facing Mode 1 → foreseeable silent-miss path on clinically urgent content (self-harm ideation, medication overdose intent, acute mental-health crisis).

**Codex recommendation:** ratify + verify an ADR-030 A/B/C implementation with Twi coverage + fail-closed behavior + latency + audit tests, OR enforce ADR-030 Option D (block Mode 1 from patients). SI-013 helplines must also be implemented and verified before enabling that surface.

### HIGH — Rollback plan for seeded clinical state is not real recovery

The runbook declares "explicit rollback command for every mutation" but Sprint 3.2 (seed load) and Sprint 3.3 (Day-0 dry run) specify no backup, restore point, reconciliation, or rollback acceptance test. Audit records are append-only (I-003) — a bad seed cannot be rolled back by row deletion because consults and clinical records will already reference those identities. VPS reprovisioning (~20 min) restores infrastructure, not the database.

**Codex recommendation:** define + rehearse forward recovery before Day 0 — transactional + idempotent roster import, per-row reconciliation report, quarantine/deactivation instead of destructive deletion, encrypted off-host pre-mutation backups, tested point-in-time restore, explicit RPO/RTO, post-restore audit-chain verification.

### HIGH — PII-leak mitigation is not incident response

The runbook's failure-modes table says "kill switch = SMS_PROVIDER=noop + take app offline; ceremony post-incident." Codex correctly notes: that stops outbound SMS only. It does not revoke sessions, isolate the API/database, rotate exposed credentials or KMS keys, preserve immutable evidence, drive scope assessment, coordinate with data processors, or trigger Ghana DPA / HIPAA breach-notification deadlines. "Take app offline" has no named owner or executable command.

**Codex recommendation:** tested IR runbook + go-live gate covering API isolation, token/session revocation, credential + encryption-key rotation, immutable evidence capture, affected-record enumeration, clinical continuity plan, named incident/privacy owners, processor escalation, Ghana DPA / HIPAA breach-assessment + notification workflows.

## The core question for the ratifier

**How do we validate the clinical workflow with real feedback without violating compliance posture on a substrate that was explicitly built as synthetic-data-only?**

Three options below. Each has different trade-offs on time-to-signal, cost, compliance exposure, and clinical utility.

## Option A — Synthetic-only closed beta on staging *(Claude's recommendation)*

**Shape:** Recruit ~10 volunteer synthetic patients (Heros team members, friendly clinicians acting as patients) who explicitly consent to non-PHI treatment and do not receive real prescribing. Prove out the clinical workflow, load-test the audit chain, exercise crisis-detection floor, without triggering regulatory posture. Real-PHI Ghana pilot becomes "Pilot 2" gated on PHI-capable substrate landing.

**What Pilot 1 delivers:**
- Real end-to-end workflow validation (patient → intake → AI → clinician → decision → medication_request creation)
- Cross-tenant isolation stress under real (synthetic) traffic
- Audit chain integrity under real volume
- Ghana clinician UX validation on real console with real (synthetic) cases
- Crisis-detection floor exercised with contrived scenarios (does the tenant-blind heuristic actually fire on English distress content? What silently misses?)
- AI Mode 1 cost baseline per patient
- Bugs found in staging without patient risk

**What Pilot 1 does NOT deliver:**
- Real patient outcomes (no real symptom relief validated)
- Real prescribing regulatory path exercised
- Real payment flow
- Real 10DLC SMS deliverability

**What is required to start:**
- 10 volunteer participants signed onto a synthetic-only-consent form (~1 day to draft + sign)
- SI-014 heuristic-adequacy audit against English contrived crisis prompts (~2 sprints, no ratifier needed for synthetic-only scope)
- No AWS work, no Ghana DPA sign-off, no HIPAA BAA
- Existing Hetzner staging + existing seed pipeline

**What is required for Pilot 2 (real Ghana chronic-care):**
- Full Phase E/F prerequisites: AWS us-east-1 with BAA + KMS-per-tenant + encrypted off-host backups + tested PITR + SIEM + IR runbook + Ghana DPA processor sign-off + SI-013 Ghana helplines ratified + SI-014 Twi coverage ratified + real 10DLC + Ghana clinician credentialing verified

**Trade-offs:**
- **Pros:** Fastest to real workflow signal. Zero compliance exposure. Validates 80%+ of what real-PHI pilot would validate. Any bugs found are cheap. Pilot 2 becomes lower-risk because Pilot 1 exercised the workflow first.
- **Cons:** Does not prove real regulatory + prescribing path. Does not prove real payment. Delays first revenue by however long Pilot 2 substrate takes.
- **Deal-breaker check:** none obvious. Synthetic-only pilot is standard SaaS pre-launch discipline.

**Time to Pilot 1 go-live:** ~2 sprints (SI-014 heuristic audit + consent form + seed script + dry run).

**Time to Pilot 2 go-live:** +6–10 sprints (Phase E/F prerequisites listed above).

**Cost:** Pilot 1 = current staging cost (~$5/mo). Pilot 2 = AWS + BAA + KMS + backups + SIEM (~$500–2000/mo baseline).

## Option B — Compress Phase E/F prerequisites into Path A critical path

**Shape:** Widen scope so real-PHI Ghana pilot goes live on real production infra. Adds ~6–10 sprints before any pilot: AWS provisioning (with BAA + KMS + encrypted backups + SIEM), IR runbook + tabletop, SI-013 + SI-014 ratified + implemented with Twi coverage, Ghana DPA processor sign-off, Telnyx 10DLC, Ghana clinician credentialing.

**Trade-offs:**
- **Pros:** First patients are real; first revenue on real regulatory footing. No "Pilot 1 → Pilot 2" gap.
- **Cons:** ~6–10 sprint delay before ANY patient signal. All the Phase E/F work happens without a real workflow forcing function to prioritize which parts matter first. Higher risk of building things patients don't need.
- **Deal-breaker check:** Requires operator-side work that Claude cannot execute (AWS root account, BAA signing, DPA sign-off, clinician credentialing) with unknown cycle times. Timeline is dominated by non-engineering.

**Time to real pilot:** ~6–10 sprints.

**Cost:** Same eventual AWS baseline; upfront cost concentrated pre-revenue.

## Option C — Hybrid: staging for clinical UX; separate compliant channel for prescribing

**Shape:** Staging carries the workflow (chat, intake, consult submit, clinician review, decision documentation) with real patients but Telecheck records nothing that meets PHI classification — patient identifiers are anonymized handles, condition/medication details are captured as "clinical-workflow research data" not medical records. Real prescribing itself is routed to Ghana clinician's existing licensed prescribing pipeline (paper Rx, existing pharmacy relationships) out-of-band. Telecheck is decision-support only until compliant substrate lands.

**Trade-offs:**
- **Pros:** Real patients get real care. Real feedback on clinical utility. Faster than Option B (~3–4 sprints because staging already carries workflow).
- **Cons:** Architecturally awkward — the medication_request lifecycle doesn't actually happen inside Telecheck for real patients, so Telecheck's prescribing surface never gets exercised end-to-end. Anonymization discipline is fragile; one leak of true identity through free-text chat = full PHI exposure with same compliance implications as Option B pre-work. Requires very careful consent + patient-education + clinician-training layer. Ghana DPA guidance on "clinical workflow research data" vs. "medical records" is unclear and may need counsel.
- **Deal-breaker check:** if anonymization discipline breaks under real chat conditions (patients naturally share identifying details), the compliance posture collapses to Option B's obligations without Option B's infrastructure.

**Time to first patient:** ~3–4 sprints.

**Cost:** Similar to Option A; anonymization discipline is a real per-patient operational cost.

## Claude's recommendation: Option A

### Rationale

1. **Fastest to real signal.** ~2 sprints vs. ~6–10 for B or ~3–4 for C. Real-signal-per-week is the metric that matters at this stage.
2. **Zero compliance exposure.** Synthetic-only means no HIPAA / Ghana DPA / regulatory surface at all. Pilot 1 cannot leak PHI that doesn't exist.
3. **Validates the ~80% of pilot value that doesn't require real-PHI.** Workflow, isolation, audit, crisis heuristic behavior, AI cost, Ghana clinician UX — all exercisable with synthetic patients.
4. **Forces the right prioritization for Pilot 2.** Whatever bugs + gaps Pilot 1 finds are the real requirements for Pilot 2 substrate. Building AWS + KMS + backups + IR runbook + Twi coverage in a vacuum (Option B) has high risk of over/under-building the wrong pieces.
5. **Aligns with the spec's own posture.** The staging runbook itself declares synthetic-only. Path A as originally framed asked us to override that posture without ratification. Codex correctly caught that.
6. **Preserves optionality.** Nothing about Option A blocks Option B or C from starting in parallel. Track 5 (AWS build-out) can begin the moment Evans has an AWS account + BAA path.

### What flows from Option A immediately

1. **Rewrite `PATH_A_PILOT_COMPLETION_RUNBOOK.md`** to reflect synthetic-only Pilot 1 scope, with Pilot 2 (real-PHI) as an explicit successor gated on Phase E/F prerequisites.
2. **Draft "Pilot 1 → Pilot 2" gating criteria** as a separate artifact — the exact checklist Pilot 2 must satisfy before real patients.
3. **Draft synthetic-participant consent form** — one page, plain English, explicit "this is a workflow test, not medical care, no PHI will be collected."
4. **Sprint 1.2 (Codex Phase-D corpus-wide sweep) resumes** — cleanup on the code as-is is still valuable.
5. **Sprint 2 (ratification burst) refocuses on SI-014 heuristic-adequacy audit** — a separate scoping question: is the current English regex adequate to demonstrate the crisis-detection floor for synthetic Pilot 1, given contrived-scenario testing will exercise it? If not, ratify a minimum-viable extension.
6. **Track 5 (AWS + BAA + KMS + backups + SIEM + IR runbook) begins as a parallel workstream** — Pilot 2 substrate build.
7. **Track 6 ratification queue continues** — SI-013 (Ghana crisis helplines) becomes Pilot-2-blocking, not Pilot-1-blocking.

### What flows from Option A that Evans owns

- **Confirm the reframe** — Pilot 1 = synthetic-only closed beta; Pilot 2 = real-PHI Ghana chronic-care on compliant substrate.
- **Identify 10 volunteer participants** for Pilot 1 (Heros team, friendly clinicians, etc.).
- **AWS account provisioning path** — if Track 5 starts in parallel, when can Claude expect an AWS root account + IAM setup?
- **HIPAA BAA path with Hetzner** — one-off question: does Hetzner offer a BAA at all? If yes, that could shift Option A vs. B calculus. (Hetzner does NOT offer HIPAA BAA to my knowledge; AWS does; this needs verification.)
- **Ghana DPA processor agreement path** — who advises? Ghana Data Protection Commission is the counterparty; is there existing Heros Health Ghana counsel who has this relationship?

## Codex Pass-2 (contrast-and-synthesize) — completed 2026-08-30

**Verdict:** `needs-attention` — **CONDITIONAL CONCURRENCE with Option A over B/C**, not ratification as-written.

**Verbatim summary:** *"Conditionally concur with Option A over B/C, but do not ratify it as written. Pilot 1 is the least unsafe path only after enforceable synthetic-only and operational-safety gates replace the unsupported 'zero compliance exposure' claim; Pilot 2 also needs jurisdictional and cross-border-data review beyond the listed infrastructure checklist."*

### Pass-2 finding 1 — HIGH: "Zero compliance exposure" is categorical and unsupported by enforceable gates

*ERR §80–93 (Option A framing).* Consent + synthetic intent are not sufficient. Volunteers can enter real names, symptoms, medications, or third-party details into free-text; logs, support artifacts, backups, and AI-provider payloads retain any leakage. Consent does not make real health data synthetic. Pilot 1 therefore retains a credible PHI/privacy exposure path on infrastructure explicitly deemed non-PHI-capable.

**Pass-2 recommendation:** Block Pilot 1 until enforceable technical + operational gates exist:
- Synthetic identities + approved scenarios only
- Explicit prohibition + training against real personal/clinical data
- Automated input/output + log checks (regex + LLM screening for PII patterns)
- Verified redaction + telemetry/AI-vendor data controls
- Least-privilege access + tenant-isolation tests
- Environment purge/reset procedure
- Named incident owner + isolation/session-revocation steps + rehearsed stop criterion

**Wording fix:** replace "zero compliance exposure" with "materially reduced compliance exposure."

### Pass-2 finding 2 — HIGH: Pilot 2 prerequisites omit cross-border and full processor-chain authorization

*ERR §86–88 (Pilot 2 requirements).* The gate assumes AWS us-east-1 + BAA + KMS + Ghana DPA processor agreement establishes compliance. For Ghana patients, US-hosted infrastructure + US AI + US SMS + US email + US logging subprocessors creates separate data-transfer / controller-processor / retention / data-residency questions. A US HIPAA BAA is not a substitute for Ghana-law authorization.

**Pass-2 recommendation:** Require counsel/privacy-owner approval of:
- Data classification (what qualifies as PHI under Ghana law)
- Controller/processor roles (who owns the data, who processes it)
- Cross-border transfer basis (Ghana → US legal basis)
- DPIA or equivalent assessment
- Residency requirements (is any category data-residency-locked to Ghana?)
- Retention/deletion rules
- Data-subject rights (Ghana DPA equivalents of HIPAA/GDPR rights)
- Breach duties (Ghana DPC notification timelines + content)
- **Every subprocessor** (Anthropic, Resend, Telnyx, AWS, Hetzner) — separately authorized

Select region + vendors only after that review — do not pre-commit to us-east-1.

### Pass-2 finding 3 — MEDIUM: Pilot 1 has no measurable exit criteria and overstates the signal it produces

*ERR §64–78 (what Pilot 1 delivers).* "Real workflow signal" + "~80% validation" from team members or friendly clinicians acting from contrived cases has no acceptance thresholds, representative scenario set, independence safeguards, failure budget, or Pilot-1-to-Pilot-2 exit criteria. Such participants know the product and may avoid confusion, accessibility constraints, poor connectivity, language variation, and unsafe inputs seen in the target population. Ratifier could approve Pilot 2 based on a green but non-representative rehearsal.

**Pass-2 recommendation:** Before ratification:
- Define Pilot 1 as a **workflow rehearsal, not clinical validation**
- Specify representative scripted + adversarial cases (coverage matrix)
- Success + abort thresholds
- Observability requirements
- Rollback/recovery drills
- Independent issue capture (not just self-report)
- Explicit evidence required to advance to Pilot 2
- Remove the "80%+" claim unless backed by a traceable coverage matrix

### Pass-2 next steps

- Ratify Option A only **conditionally**, subject to the Pilot 1 gates above.
- Require a **revised ERR** with a qualified exposure statement, measurable Pilot 1 exit criteria, and counsel-approved Pilot 2 jurisdiction/subprocessor gates.

## Convergence check (per auto-proceed rule, CLAUDE.md 2026-05-20)

| View | Position on Option A |
|---|---|
| Claude recommendation | Option A, ratify + execute |
| Codex Pass-1 (R1) | The runbook as written is NO-SHIP; Option A framing not yet reviewed |
| Codex Pass-2 (synthesis) | Option A over B/C, ratify **conditionally** with three specific gate additions |

**All three concur on direction (Option A over B/C).** Divergence is on ratification cadence: Claude ready to ratify + execute; Pass-2 wants ERR revision first with gates baked in.

Auto-proceed determination pending ratifier's chosen framing (see next section).

## Ratifier decision — RATIFIED 2026-08-30 (Path α)

**Ratifier:** Evans, via chat message *"go with your recommendation and continue working nonstop"* 2026-08-30.

**Chosen path:** **Path α** — ratify Option A + treat Pass-2's three additional gates as first execution work items (rather than requiring pre-ratification ERR revision under Path β). Rationale accepted: the gates ARE the first work anyway; a second ratification round adds cycle time without adding rigor.

**Ratified position:**
- **Option A over B/C** for pilot framing
- **Pilot 1 = synthetic-only closed beta on Hetzner staging as workflow rehearsal** (NOT clinical validation)
- **Pilot 2 = real-PHI Ghana chronic-care** gated on Phase E/F prerequisites including counsel-approved cross-border + subprocessor authorization
- All three Pass-2 gates baked into revised runbook (see `PATH_A_PILOT_COMPLETION_RUNBOOK.md` at merge; supersedes the original filed 2026-08-30)

**Companion artifacts landing under this ratification (this PR):**
1. `PATH_A_PILOT_COMPLETION_RUNBOOK.md` — REWRITTEN with Pass-2 gates baked in
2. `PILOT_1_TO_PILOT_2_GATING_CHECKLIST.md` — Pass-2 finding-2 subprocessor + counsel authorization matrix
3. `PILOT_1_SYNTHETIC_PARTICIPANT_CONSENT.md` — consent template
4. `PILOT_1_COVERAGE_MATRIX.md` — scripted + adversarial scenarios; success/abort thresholds (Pass-2 finding-3)
5. `PILOT_1_INCIDENT_RESPONSE_MINI_RUNBOOK.md` — named owner + rehearsed stop criterion (Pass-2 finding-1)
6. `PII_SCREENING_AND_LOG_REDACTION_SPEC.md` — enforceable synthetic-only gate (Pass-2 finding-1)

**Promotion Ledger entry:** P-045 (to be appended at merge of this PR).

**Autonomous-work authorization confirmed:** Evans authorized "continue working nonstop" alongside ratification. Auto-proceed rule active for Pilot 1 substrate work + parallel Track 5 (Pilot 2 AWS + BAA + KMS + backups + SIEM + IR runbook + counsel prep) initiation. STOP conditions unchanged.

---

## Cycle close
