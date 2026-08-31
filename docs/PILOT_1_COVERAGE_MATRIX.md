# Pilot 1 Coverage Matrix — Scripted + Adversarial Scenarios + Exit Gate

**Filed:** 2026-08-30
**Status:** ACTIVE — companion to `PATH_A_PILOT_COMPLETION_RUNBOOK.md` under Path α ratification
**Owner:** Claude (authoring + evidence collection) + Evans (exit-gate ratifier)
**Addresses:** Codex Pass-2 finding 3 (Pilot 1 needs measurable exit criteria + representative coverage; "80%+" claim must be backed by traceable matrix)
**Framing:** Pilot 1 is a **workflow rehearsal**, not clinical validation. This matrix measures workflow coverage, not clinical outcome quality.

---

## Coverage matrix — scripted scenarios

Each scenario has a synthetic participant handle, a stepwise script, and a pass/fail criterion. Every scenario must complete before Pilot 1 exit.

| # | Scenario | Participants | Steps | Pass criterion | Status |
|---|---|---|---|---|---|
| S1 | Happy-path chronic-care intake (hypertension) | `pilot1-participant-01` (patient) + `pilot1-clinician-01` | Signup via email+PIN → intake form with synthetic BP reading → AI Mode 1 confirmation chat → consult submit → clinician claim → clinician decision → medication_request created | All 7 steps complete without error; audit chain intact for the flow | ⬜ |
| S2 | Happy-path chronic-care intake (diabetes) | `pilot1-participant-02` + `pilot1-clinician-01` | Same as S1 but diabetes scenario | Same as S1 | ⬜ |
| S3 | Happy-path chronic-care refill | `pilot1-participant-03` (existing medication_request from S1-shape) + `pilot1-clinician-01` | Refill request → clinician review → refill approved → dispensing event | 4 steps; audit chain includes refill lineage | ⬜ |
| S4 | Multi-condition intake (hypertension + cholesterol) | `pilot1-participant-04` + `pilot1-clinician-01` | Intake covering two conditions → AI Mode 1 addresses both → single consult with two medication_requests | Both med-interaction checks fire; both requests audit-linked | ⬜ |
| S5 | Med-interaction warning flow | `pilot1-participant-05` + `pilot1-clinician-01` | Intake requesting a medication with a known interaction against another synthetic prescription → med-interaction module flags → clinician must acknowledge + override with evidence | Override flow exercised; evidence audit-linked; medication_request only issues after override | ⬜ |
| S6 | Ghana-tenant end-to-end | `pilot1-participant-06` (on Telecheck-Ghana) + `pilot1-clinician-02` (Ghana-tenant clinician) | Same shape as S1 but entirely on Telecheck-Ghana | Cross-tenant negative assertion verified (US patient token cannot see this Ghana consult) | ⬜ |
| S7 | Cross-tenant isolation live-check | `pilot1-participant-01` (US) attempts to access `pilot1-participant-06`'s (Ghana) consult by ID | ALL API paths that reference consult-by-ID | Every path returns tenant-blind 404 (per I-023 + I-025) | ⬜ |
| S8 | Consent withdrawal (I-030) | `pilot1-participant-07` completes intake → withdraws consent → verify data-subject-rights procedure | Signup → intake → withdraw → verify no further AI processing on their data + audit event `consent.withdrawn` fires | Consent-decoupled state honored; I-030 satisfied | ⬜ |
| S9 | Async-consult full lifecycle (queue → claim → decision → visible-to-patient) | `pilot1-participant-08` + `pilot1-clinician-01` | Patient submits → appears in clinician queue → clinician claims → decision → patient sees final state | State-machine transitions all recorded; SI-005 audit events emitted | ⬜ |
| S10 | Email+PIN auth path — signup + login + PIN recovery | `pilot1-participant-09` | Signup → receive real email → login → recover PIN → login again | Full email-auth path exercised (Resend live delivery) | ⬜ |

**S1–S10 all pass = scripted-workflow coverage complete.**

---

## Coverage matrix — adversarial scenarios

Adversarial scenarios verify the system fails safely under unexpected inputs. Each scenario has a pre-defined "acceptable failure mode" — the goal is to verify that failure mode fires, not that the input succeeds.

| # | Adversarial scenario | Expected failure mode | Actual failure mode | Status |
|---|---|---|---|---|
| A1 | Participant enters real-looking name in chat | Layer 1 input screener blocks with 422 + guidance | ⬜ | ⬜ |
| A2 | Participant enters real-looking phone in intake free-text | Layer 1 blocks with 422 | ⬜ | ⬜ |
| A3 | Participant enters real-looking SSN in chat | Layer 1 blocks with 422 | ⬜ | ⬜ |
| A4 | Participant enters real-looking Ghana Card ID in intake | Layer 1 blocks with 422 | ⬜ | ⬜ |
| A5 | Clinician enters real patient's real name in decision notes | Layer 1 blocks with 422 | ⬜ | ⬜ |
| A6 | Free-text with subtle PII (e.g., first name + condition tied together) | Layer 1 LLM classifier hits with warn | ⬜ | ⬜ |
| A7 | Response body would render PII that slipped past Layer 1 (synthesized regression) | Layer 2 egress screener redacts | ⬜ | ⬜ |
| A8 | Log line containing accidental PII pattern | Layer 3 log redaction catches | ⬜ | ⬜ |
| A9 | AI payload would contain PII (synthesized) | Layer 4 sanitizer rejects or scrubs before send | ⬜ | ⬜ |
| A10 | Contrived English crisis prompt (self-harm ideation phrasing) | Crisis-detection heuristic fires → I-019 escalation path invoked → session flagged | ⬜ | ⬜ |
| A11 | Contrived crisis prompt in a non-English language (Twi phrasing) | Heuristic MAY miss (documented ADR-030 gap); the miss itself is a recorded finding informing Pilot 2 SI-014 gate — NOT a Pilot 1 failure | ⬜ | ⬜ |
| A12 | Mid-conversation network drop | AI Mode 1 turn atomicity: either the turn persists fully OR not at all; no half-recorded state | ⬜ | ⬜ |
| A13 | Provider outage (Anthropic returns 5xx) | System returns clean error to participant; audit event `ai.provider.error` fires; no PII leaked in error path | ⬜ | ⬜ |
| A14 | AI Mode 1 hits token limit mid-turn | Graceful truncation; audit event records; participant informed | ⬜ | ⬜ |
| A15 | Clinician attempts to access consult in the other tenant via direct API | Tenant-blind 404 (I-025); no leak in error message | ⬜ | ⬜ |
| A16 | Participant attempts to escalate to admin role via API call | 403; no privilege escalation; audit event fires | ⬜ | ⬜ |
| A17 | Malformed JSON body on POST endpoint | Fastify validation returns 400; no server crash | ⬜ | ⬜ |
| A18 | Extremely long input (10k+ chars in one free-text field) | Enforced max length; graceful rejection | ⬜ | ⬜ |
| A19 | Rapid-fire request storm from one participant | Rate limiter (Redis-backed) engages; participant sees 429 with retry-after | ⬜ | ⬜ |
| A20 | Env-purge invoked mid-participant-session | Session invalidated cleanly; participant sees "session ended" message; no half-purged state | ⬜ | ⬜ |

**A1–A20 all match expected failure = adversarial coverage complete.**

---

## Success + abort thresholds

### Success (advance to Pilot 2 gate evaluation)

- All S1–S10 pass
- A1–A10 match expected failure
- A11 result recorded as informational (does not block; feeds Pilot 2 SI-014 gate)
- A12–A20 match expected failure
- No CRITICAL open defects in the pilot defect log
- HIGH open defects triaged with fix-or-accept decision recorded
- Cross-tenant isolation verified daily during Pilot 1 window; zero failures
- Audit chain verified daily; zero gaps

### Abort (Pilot 1 halted; do not advance to Pilot 2 evaluation)

- ANY genuine real-PHI leak beyond the layer-catchable adversarial cases (i.e., something entirely bypassed all 5 layers)
- Cross-tenant isolation failure (any participant seeing another tenant's data)
- Audit chain gap that cannot be forensically explained
- Any CRITICAL defect that cannot be closed within the Pilot 1 window
- Codex adversarial-review finding of an architectural-judgment class that cannot be addressed under the Pilot 1 scope

Abort → root-cause analysis → decision brief for Evans on whether to re-run Pilot 1 after fixes OR pivot to Option B/C.

---

## Independent issue capture (Pass-2 finding 3 addressed)

Every issue surfaced during Pilot 1 is logged in a shared **Pilot 1 defect log** (proposed location: `docs/pilot-1-defect-log.md` — created at first defect). Requirements:

- Every entry has: date, reporter (participant or observer), scenario#, severity (CRITICAL/HIGH/MEDIUM/LOW), status (OPEN/IN-PROGRESS/CLOSED/ACCEPTED), owner
- Entries are added by participants themselves via a defect-report form (out-of-band; email to test coordinator suffices) — NOT self-reported by the engineering team based on what "seemed OK"
- Weekly digest of defects reviewed with Evans at Sprint 4 cadence

**Reporter mix requirement** — no less than 3 of the 10 participants must be **non-engineering** (contracted UX researchers or friendly clinicians unfamiliar with implementation details). If <3, coverage matrix is INCOMPLETE regardless of scenario-by-scenario pass status. This addresses Pass-2's concern that friendly-clinician-only testers may not surface the confusion + accessibility + connectivity + language issues real Ghana patients would.

---

## Ghana-population representativeness (explicit limitation)

Pilot 1 does NOT represent the actual Ghana chronic-care patient population. Limitations explicitly recorded here so the Pilot 2 gate evaluation does not overclaim:

- No Twi-only Ghana patients tested
- No low-connectivity Ghana patients tested
- No low-digital-literacy Ghana patients tested
- No Ghana-medical-education-specific idioms tested
- No Ghana-specific medication brand names tested against the formulary lookup
- Ghana Medical Council registration + prescribing conventions NOT stress-tested

These limitations become explicit Pilot 2 gate items — see `PILOT_1_TO_PILOT_2_GATING_CHECKLIST.md` Gate 7 (Ghana Twi coverage + protocol pack).

---

## Exit gate — Pilot 1 → Pilot 2 evaluation authorization

**Evans is the sole ratifier.** Pilot 1 exit gate is met when:

- ✅ Scripted matrix complete (S1–S10 all ⬜ → ✅)
- ✅ Adversarial matrix complete (A1–A10 + A12–A20 all match expected; A11 recorded)
- ✅ Defect log ≥ 3 non-engineering reporters
- ✅ No CRITICAL open; no HIGH open beyond triage
- ✅ Cross-tenant + audit-chain verified across full Pilot 1 window
- ✅ Ghana-population limitations formally documented (this file's §Ghana-population representativeness)

Meeting exit gate does NOT authorize Pilot 2 — it authorizes moving into `PILOT_1_TO_PILOT_2_GATING_CHECKLIST.md` evaluation, which has its own 10 gates requiring counsel + procurement + operational rehearsal work.

---

## Status tracking

This matrix is the source of truth for Pilot 1 progress. Every scenario status transition (⬜ → ✅ or ⬜ → ❌) is a git commit. Evans's exit-gate ratification is a chat-message + Promotion Ledger entry.

**Current state (2026-08-30):** all scenarios ⬜; Pilot 1 has not started.
