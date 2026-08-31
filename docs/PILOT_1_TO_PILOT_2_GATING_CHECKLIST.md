# Pilot 1 → Pilot 2 Gating Checklist

**Filed:** 2026-08-30
**Status:** ACTIVE — companion to `PATH_A_PILOT_COMPLETION_RUNBOOK.md` under Path α ratification
**Owner:** Evans (ratifier for exit gate) + Claude (evidence collection)
**Purpose:** enumerate every gate that must be ✅ before Pilot 2 (real-PHI Ghana chronic-care) can be authorized

---

## Framing

Pilot 1 is a **workflow rehearsal on synthetic identities**, not clinical validation and not authorization for real-PHI patient onboarding. This checklist is the exit gate that separates the two. **A green Pilot 1 does not imply a green Pilot 2** — the two pilots serve different purposes and validate different things.

The checklist is intentionally exhaustive. It looks like a lot of boxes because Pilot 2 is a real regulated telehealth program serving real patients under Ghana law with US-hosted subprocessors. Undercounting these gates is how compliance incidents happen.

Evans is the sole ratifier for advancing to Pilot 2. Every box must be checked, every checkbox must have named evidence (a URL, a file path, or a signed document reference).

---

## Gate 1 — Pilot 1 exit criteria satisfied

- [ ] Every scripted scenario in `PILOT_1_COVERAGE_MATRIX.md` completed with pass/known-defect status recorded
- [ ] Every adversarial scenario in `PILOT_1_COVERAGE_MATRIX.md` completed
- [ ] Defect log reviewed; no CRITICAL / HIGH open; MEDIUM triaged with fix-or-accept decision
- [ ] Cross-tenant isolation verified end-to-end at least 3× over the Pilot 1 window (`scripts/staging-e2e-smoke.sh --tenant Telecheck-Ghana` cross-assertion)
- [ ] Audit chain integrity verified daily during Pilot 1 window; no gaps
- [ ] AI Mode 1 cost baseline documented (avg tokens + $ per synthetic patient interaction)
- [ ] Ghana clinician UX feedback captured (workflow friction, misclick surface, missing affordances)

## Gate 2 — Technical PHI-capable substrate

- [ ] AWS us-east-1 (or counsel-approved alternative region) provisioned per ADR-026
- [ ] AWS us-west-2 (or counsel-approved alternative cold DR region) provisioned per ADR-026
- [ ] Per-tenant KMS keys provisioned (Telecheck-US + Telecheck-Ghana) per ADR-024
- [ ] AWS Secrets Manager wired for all runtime secrets (Anthropic key, Telnyx key, Resend key, DB passwords, BIND_ROLE_PASSWORD)
- [ ] RDS PostgreSQL 16 provisioned with full role-DDL freedom (managed with an operator role that can create NOLOGIN NOBYPASSRLS roles + SECURITY DEFINER functions — verified via migration chain apply on production RDS)
- [ ] ElastiCache Redis provisioned
- [ ] ECS or EKS cluster running the container image (same image as staging)
- [ ] ALB + ACM cert for `heroshealth.com` + `ghana.heroshealth.com`
- [ ] Encrypted off-host backups configured — daily minimum, 30-day retention minimum, tested restore procedure
- [ ] Point-in-Time Recovery (PITR) enabled on RDS + tested (documented RPO ≤ 5 min; documented RTO ≤ 1 hr)
- [ ] SIEM shipping pipeline live — pino stdout → SIEM (candidate: AWS CloudWatch → Wazuh / Splunk / Datadog)
- [ ] Request nonce in `LOG_REDACT_PATHS` per SI-010 nonce-as-secret discipline (already spec'd; verify in production)

## Gate 3 — Processor inventory (every production data recipient authorized separately)

**Inventory principle:** every service that receives, stores, transmits, or processes Pilot 2 patient data (identified or de-identified) is a processor requiring counsel-approved authorization BEFORE Gate 3 passes. Inventory is maintained continuously — no processor is added silently.

Each inventory row must have counsel-approved values for: **transfer basis** (Ghana → recipient jurisdiction legal basis), **contract type** (BAA / DPA / SCC / equivalent — status: executed / negotiating / N/A), **data categories** (PHI / PII / telemetry / audit), **retention** (days), **region** (physical processing location), **subprocessors** (their subprocessors, recursively at least one level).

### Substrate + compute
- [ ] **AWS (compute + storage)** — HIPAA BAA + Ghana counsel approval for controller/processor role under Ghana Data Protection Act (Act 843)
- [ ] **AWS (KMS)** — same BAA + counsel approval; specifically for encryption-key-processing role
- [ ] **AWS (Secrets Manager)** — same BAA + counsel approval
- [ ] **Hetzner** — DELISTED from Pilot 2 substrate (staging only; not a Pilot 2 vendor)

### AI processors
- [ ] **Anthropic** — HIPAA BAA (if available) + Ghana counsel approval for AI processor role — OR replaced with alternative provider (AWS Bedrock with BAA OR Azure OpenAI with BAA)

### Communication processors
- [ ] **Resend (email)** — HIPAA BAA (Resend does not currently offer BAA at time of filing — verify) OR replaced with Amazon SES + BAA
- [ ] **Email provider** (whoever ends up being it) — Ghana counsel approval for email processor role
- [ ] **Telnyx (SMS)** — HIPAA BAA + Ghana counsel approval; if unavailable, replaced with HIPAA-compliant SMS provider
- [ ] **SMS provider** (whoever ends up being it) — Ghana counsel approval

### Observability + logging processors (previously omitted per Codex R1 R2 finding)
- [ ] **AWS CloudWatch (logs + metrics)** — covered by AWS BAA; counsel approval that log content classification is honored
- [ ] **SIEM vendor** (Wazuh self-hosted / Splunk / Datadog / other) — HIPAA BAA + Ghana counsel approval BEFORE selection. If SIEM ingests logs that may contain patient identifiers, this is a full processor.
- [ ] **Application performance monitoring** (if any — Datadog APM / New Relic / Sentry / other) — HIPAA BAA + Ghana counsel approval
- [ ] **Error tracking** (if any — Sentry / Rollbar / other) — HIPAA BAA + Ghana counsel approval; consider disabling entirely for Pilot 2 if BAAs unavailable

### Backup + DR processors
- [ ] **Backup destination** (AWS S3 / off-region S3 / third-party) — HIPAA BAA + Ghana counsel approval
- [ ] **Backup encryption** (KMS-managed OR customer-managed keys) — key custody documented

### Support + customer-facing processors
- [ ] **Support ticket system** (if any — Zendesk / Intercom / other) — HIPAA BAA + Ghana counsel approval; consider email-only for Pilot 2 to avoid a subprocessor
- [ ] **Analytics** (if any — PostHog / Amplitude / other) — HIPAA BAA + Ghana counsel approval; consider first-party-only analytics for Pilot 2

### Payment processors (if Gate 8 requires; may be N/A per Pilot 2 launch decision)
- [ ] **MTN MoMo (Ghana)** — Ghana Payment System regulatory + counsel approval for payment processor role
- [ ] **Any card processor** (Stripe / other for potential future US-side) — HIPAA BAA + counsel approval; likely N/A for Pilot 2 (Ghana-only)

### Inventory publication + discipline
- [ ] Full processor inventory published as a data-processing addendum (DPA) — required document, not on-request
- [ ] Inventory added-to via named process only (not silently); any new processor gets Gate-3-blocking status until authorized
- [ ] Quarterly review of processor list + BAA/DPA/counsel-approval status by Evans + Ghana counsel

## Gate 4 — Ghana regulatory (counsel-approved before Pilot 2 opens)

- [ ] Ghana Data Protection Commission (DPC) processor registration completed
- [ ] Cross-border data transfer basis documented (Ghana → US) — legal basis identified (adequacy? SCC-equivalent? explicit consent + necessity?)
- [ ] Data classification memo — what Telecheck data qualifies as PHI under Ghana law, what qualifies as sensitive personal data, what qualifies as ordinary personal data
- [ ] Controller/processor roles documented — who is controller for what data category (Telecheck-Ghana Ltd. presumably controller; each vendor processor)
- [ ] Data residency requirements verified — any category residency-locked to Ghana? If yes, that category cannot leave Ghana (implication: US region may be insufficient for that data class)
- [ ] Retention + deletion rules documented per data category
- [ ] Data-subject rights procedures — access / correction / deletion / portability requests (Ghana DPA equivalents of GDPR articles)
- [ ] Breach notification procedure — Ghana DPC notification timeline + content requirements
- [ ] DPIA (Data Protection Impact Assessment) completed per Ghana DPA if required for this processing scope
- [ ] Ghana Medical & Dental Council notification / registration for telehealth-mediated prescribing (if required — counsel to confirm)
- [ ] Ghana Pharmacy Council notification / registration for medication_request routing (if required — counsel to confirm)

## Gate 5 — US regulatory (if any pilot participant is a US person or US route is used)

*Trigger: only if a pilot participant is a US resident OR any US-side prescribing is done via Telecheck. If Pilot 2 is Ghana-only with Ghana-resident patients + Ghana-licensed clinicians only, this gate is N/A. Counsel to confirm.*

- [ ] HIPAA covered-entity / business-associate posture documented for Telecheck Health LLC
- [ ] HIPAA Security Rule risk assessment completed
- [ ] HIPAA Privacy Rule Notice of Privacy Practices published
- [ ] Business Associate Agreements executed with each US-side vendor
- [ ] State licensure per prescribing state
- [ ] State PMP integration where required
- [ ] DEA registration + controlled-substance handling per federal rules (Pilot 2 scope permitting — likely N/A if pilot is chronic-care non-controlled)

## Gate 6 — Operational readiness

- [ ] Incident-response runbook FULL VERSION (not the Pilot 1 mini-runbook) authored + tabletop-rehearsed at least 1× with named owners
- [ ] On-call rotation established with 24/7 named engineer + named clinician + named privacy owner
- [ ] Breach-notification workflow rehearsed against a simulated incident
- [ ] Backup restore drill completed successfully (restore from off-host encrypted backup → verify audit chain integrity)
- [ ] Cross-tenant tenant-blindness verified on production infrastructure (not just staging)
- [ ] Monitoring + alerting live for: error rate, latency, audit-chain gap, cross-tenant access attempts, provider outage (Anthropic/Resend/Telnyx)
- [ ] Patient-facing terms of service + privacy policy published (Ghana-jurisdiction, Ghana counsel-approved)
- [ ] Clinician-facing terms of service + acceptable-use published
- [ ] Support channel established (email address, response SLA)
- [ ] Complaint / grievance procedure per Ghana DPA + Ghana medical regulatory requirements

## Gate 7 — Clinical safety (Ghana Twi crisis coverage + protocol)

- [ ] SI-013 CCR Ghana crisis helplines ratified + implemented (specific numbers for Ghana Suicide Prevention, Ghana MOH crisis lines)
- [ ] SI-014 crisis-detection classifier ratified + implemented with **Twi coverage** per ADR-030 Option A/B/C (verified fail-closed + latency + audit tested)
- [ ] Ghana clinical protocol pack ratified for pilot-scope conditions (chronic care: hypertension, diabetes, cholesterol; or narrower per Evans's product decision)
- [ ] Formulary lookup per Ghana CCR verified against Ghana pharmacy availability
- [ ] Ghana clinician on-call rotation for pilot period established
- [ ] Escalation path from Mode 1 chat → human clinician documented + tested with Twi + English contrived scenarios
- [ ] Escalation path from any AI crisis-signal detection → Ghana crisis resources + human clinician documented + tested

## Gate 8 — Payment (if not deferring per Pilot 2 launch decision)

- [ ] MTN MoMo merchant account provisioned + integration wired (or explicit deferral to post-Pilot-2)
- [ ] Ghana tax registration + billing compliance
- [ ] Refund + dispute procedure
- [ ] Payment audit trail per Ghana regulatory + Telecheck audit invariants

## Gate 9 — Consent + participant flow

- [ ] Real-PHI patient consent template drafted by Ghana counsel (distinct from Pilot 1 synthetic consent)
- [ ] Patient-onboarding flow includes counsel-approved consent capture at signup
- [ ] Consent withdrawal procedure tested (I-030 consent-decoupling invariant satisfied)
- [ ] Delegated-access consent procedure tested if in Pilot 2 scope

## Gate 10 — Ratifier decision

- [ ] All 9 gates above ✅
- [ ] Evans's chat-message or file-committed ratification of Pilot 2 opening
- [ ] Promotion Ledger entry recording Pilot 2 authorization (P-XXX)

---

## Owner responsibilities

- **Evans:** owns Gates 1 (ratifies exit criteria met), 2 (owns AWS provisioning), 3 (owns vendor procurement + BAA signings), 4 (owns Ghana counsel engagement), 5 (owns US regulatory posture if applicable), 6 (owns operational hire + rotation setup), 7 (owns Ghana clinician engagement + protocol ratification), 8 (owns payment decision), 9 (owns patient-consent legal drafting), 10 (sole ratifier)
- **Claude:** owns evidence collection into this checklist as boxes are cleared, engineering implementation of everything in Gates 2 + 7 that maps to code + spec, dual-recommendation prep for Pilot 2 ratification ceremony
- **External counsel (Ghana):** owns Gate 4 + parts of Gates 3/5/9 requiring legal opinion

## Checklist status tracking

This file is the source of truth. Each box gets checked with a commit that names the evidence (URL, file path, or signed document reference). A green checklist = Pilot 2 is ratifiable; a red-with-gaps checklist = Pilot 2 is not.

**Current state as of filing 2026-08-30:** all boxes unchecked. Pilot 1 has not yet run; Pilot 2 substrate has not yet been provisioned.
