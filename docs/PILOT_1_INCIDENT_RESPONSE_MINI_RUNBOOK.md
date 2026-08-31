# Pilot 1 Incident Response Mini-Runbook

**Filed:** 2026-08-30
**Status:** ACTIVE — companion to `PATH_A_PILOT_COMPLETION_RUNBOOK.md` under Path α ratification
**Owner:** Evans (named incident owner) + Claude (on-call technical responder)
**Scope:** Pilot 1 substrate (Hetzner staging with synthetic identities). Real-PHI incidents are OUT OF SCOPE — Pilot 2 has a separate FULL runbook.
**Addresses:** Codex Pass-2 finding 1 (Pilot 1 needs named owner + rehearsed stop criterion)

---

## Named roles

| Role | Person | Responsibilities |
|---|---|---|
| **Incident owner** | Evans | Sole decision-maker on: participant notification, session abort, participant removal, escalation to Pilot 1 pause |
| **Technical responder** | Claude | Executes technical isolation + purge + audit-chain preservation on incident owner's authorization |
| **Participant coordinator** | Evans (or delegate) | Communicates with participants; handles consent-violation ceremonies |

## Incident categories

### Category 1 — Real PHI leak detected (any layer)

**Trigger:** Layer 1 input screener block fires, OR Layer 2 output screener redaction fires, OR Layer 3/4/5 catches something.

**Severity:** medium if caught by any layer (system worked as designed); high if the pattern was novel and only caught by later layers; **CRITICAL if all layers were bypassed and real data reached durable storage / AI vendor / rendered output**.

**Response:**

1. **Immediate:** the layer that caught the pattern has already blocked / redacted. Log the incident: `docs/pilot-1-incident-log.md` entry with participant handle, timestamp, category, layer that fired.
2. **Notify participant** (Evans): explain the block, ask them to re-enter with synthetic values, point at Participant Kit.
3. **If CRITICAL** (all layers bypassed): execute `bash scripts/pilot-1-env-purge.sh` per `PII_SCREENING_AND_LOG_REDACTION_SPEC.md` §Environment purge. Preserve forensic snapshot BEFORE purge: `docker compose logs --no-color > /home/deploy/incident-logs/incident-$(date -u +%FT%TZ).log`. Halt Pilot 1 until root-cause analysis complete.
4. **Root cause:** file a defect on the layer that should have caught it. Add adversarial test to prevent regression. Codex adversarial review on the fix before re-opening Pilot 1.

### Category 2 — Cross-tenant isolation failure

**Trigger:** any evidence that a participant can see another tenant's data (e.g., a US-tenant participant sees a Ghana-tenant consult by direct API call, or a status endpoint leaks cross-tenant metadata).

**Severity:** **CRITICAL always.** This violates I-023 / I-025 which are platform-floor invariants and cannot be relaxed even in Pilot 1.

**Response:**

1. **Immediate:** halt Pilot 1. All participant sessions suspended.
2. **Isolate:** `docker compose stop app` to freeze the API surface. Read replicas + Redis remain up for forensic access.
3. **Preserve:** capture full DB snapshot (`docker compose exec db pg_dump …`) + app-log snapshot BEFORE any recovery step. Store in `/home/deploy/incident-logs/`.
4. **Root cause:** trace the specific query / endpoint / RLS-policy path that allowed the leak. Verify against SI-010 bind-pool discipline. This is likely an SI-class defect requiring ratifier escalation per hard-floor item 6 (invariant amendment scope).
5. **Fix + verify:** patch, add regression test, Codex adversarial review, verify cross-tenant isolation across ALL sibling paths before re-opening.
6. **Escalate:** if root cause implicates a canonical schema / invariant amendment, STOP + author ERR + ratifier decision required.

### Category 3 — Audit chain gap

**Trigger:** daily audit-chain integrity check finds a gap; audit event should have fired but didn't; audit records show a break in the chain.

**Severity:** **CRITICAL always.** I-003 (audit append-only) + I-027 (audit attribution) are platform-floor.

**Response:**

1. **Halt:** pause Pilot 1. Suspend participant sessions.
2. **Preserve:** capture audit records + app logs for the window containing the gap.
3. **Root cause:** identify why the audit event was skipped. Common causes: bare suppression on emission failure (forbidden), missing invocation site, transaction rolled back after emission.
4. **Fix:** patch. Add regression test. Codex adversarial review.
5. **Recover:** if the gap is in the past and cannot be back-filled, document the gap in the incident log with explanation. Pilot 1 exit gate requires no unexplained gaps.

### Category 4 — Provider / infrastructure outage

**Trigger:** Anthropic API down, Resend down, Postgres down, Redis down, Caddy TLS cert renewal failure, Hetzner VPS unreachable, etc.

**Severity:** medium if <15 min impact; high if >1 hr; CRITICAL if causes Pilot 1 abort of active session.

**Response:**

1. **Diagnose:** which provider / component is down. Check provider status page + `docker compose ps`.
2. **Notify:** participants in the affected session that Pilot 1 is temporarily paused.
3. **Fallback:** if AI provider down, staging is inert but doesn't lose data. If Postgres/Redis down, restart via `docker compose restart <service>`. If VPS unreachable, reprovision per `infra/staging/STAGING_RUNBOOK.md` (~20 min; no PHI loss because Pilot 1 has none).
4. **Log:** entry in incident log with provider, duration, impact.

### Category 5 — Consent violation (participant persistently ignores synthetic-only rules)

**Trigger:** a participant is repeatedly triggering PII-screener blocks after warnings, or is verbally reporting real-medical-issue behavior in the system.

**Severity:** medium (per-participant); high (if pattern across multiple).

**Response:**

1. **First warning:** Evans direct-message the participant. Point at consent form § "You agree not to enter your real name…". Confirm understanding.
2. **Second occurrence:** pause participant's access. Purge affected records for that participant per `pilot-1-env-purge.sh` scoped variant (or full purge if scoped isn't safe).
3. **Third occurrence:** remove participant from Pilot 1. Document in incident log + defect log. Backfill with alternate participant if roster permits.

---

## Stop criterion (rehearsed before Pilot 1 Day-0)

**"Pilot 1 STOP" is declared by Evans (incident owner) when:**

- Any CRITICAL incident from Categories 1–3
- Two or more HIGH incidents within a 24-hour window
- Independent finding by Claude, Codex, or a participant that a systemic issue undermines the integrity of Pilot 1's exit gate

**Stop procedure:**

1. Evans posts "Pilot 1 STOP" in the coordination channel + notifies all active participants.
2. Claude executes `bash scripts/pilot-1-env-purge.sh` after forensic-log capture.
3. Root-cause analysis begins. No re-open until Codex adversarial review of the fix + Evans's re-authorization.

**Rehearsal:** before Pilot 1 Day-0 dry run, execute a full STOP-and-purge cycle against a contrived incident to verify the runbook works. Record the drill in the incident log with duration + any friction findings.

---

## Communication channels

- **Primary:** email — participants ← test coordinator → Evans + Claude
- **Backup:** [named Slack / chat channel — Evans to designate before Day-0]
- **Escalation:** Evans's direct phone (documented off-repo per operational-security discipline)

## Forensic-evidence preservation

**Cardinal rule:** an incident-log capture on the non-PHI substrate is a legitimate operational need for defect-attribution, but if the incident involves real-PHI leakage, preserving raw leaked content in cleartext on Hetzner extends the exposure rather than closing it. All evidence handling therefore honors: **sanitize where feasible, encrypt where preserved, retain briefly, destroy verifiably, escalate when real data touches the substrate**.

### Capture procedure

Every incident triggers preservation BEFORE any recovery action, with per-artifact treatment:

- **App log snapshot** — capture via `docker compose logs --no-color app`, immediately pipe through the same regex + local-NER redaction as Layer 3 (`node scripts/pii-scrub.mjs`), THEN encrypt the redacted output with age or gpg to a project-owned key. Path: `/home/deploy/incident-logs/app-<timestamp>.log.age`. Raw unredacted content NEVER hits disk.
- **DB snapshot** — capture via `pg_dump | node scripts/pii-scrub.mjs` (same regex + local-NER pass) with output encrypted the same way. Path: `/home/deploy/incident-logs/db-<timestamp>.sql.age`.
- **Caddy access-log snapshot** — captured raw (URLs + status codes + timings only; no request bodies). Encrypted. Path: `/home/deploy/incident-logs/caddy-<timestamp>.log.age`.
- **Audit-record snapshot** — captured raw (audit records are by design non-PHI per I-027 attribution discipline). Encrypted for consistency. Path: `/home/deploy/incident-logs/audit-<timestamp>.csv.age`.

### Encryption key management

- Public key stored on VPS at `/home/deploy/.age-recipients` (age encryption, safe to store publicly)
- Private key stored OFF-VPS by Evans (personal secure storage; not committed anywhere; used only for evidence decryption during root-cause analysis)
- Key rotation: quarterly at minimum; immediately after any Pilot 1 STOP incident

### Retention + destruction

- **Retention:** 30 days maximum for encrypted incident logs; auto-purge via `scripts/incident-log-gc.sh` (weekly cron; deletes files older than 30 days)
- **Explicit destruction on Pilot 1 close:** on Pilot 1 exit (win or abort), Evans authorizes full `/home/deploy/incident-logs/` wipe; wipe is recorded in the incident log
- **Never off-VPS-backup-eligible** — the incident-log path is on VPS-local disk only, not eligible for the VPS's backup rotation (should there be one; presently Pilot 1 has no VPS-backup rotation on purpose)

### Include incident-logs in verified purge

The Pilot 1 env-purge script (`scripts/pilot-1-env-purge.sh` per `PII_SCREENING_AND_LOG_REDACTION_SPEC.md`) MUST include `/home/deploy/incident-logs/` in its wipe step OR explicitly leave it (with recorded reason) if the current incident is under active RCA. Purge script is updated to prompt on this decision + record in the run log.

### Escalation trigger — real data touches the substrate

If forensic evidence confirms real personal or clinical data reached ANY part of the substrate (DB rows, in-flight AI payloads, logs, backups, incident-log captures), Category 1 elevates to **CRITICAL** and additional obligations attach beyond the Category 1 procedure:

1. **STOP Pilot 1 immediately** (not just the affected session).
2. **Notify affected participant** within 1 business day; Evans owns communication.
3. **Notify any external processor** that received the leaked data (Anthropic, Resend, etc.) with request for their-side purge confirmation.
4. **Assess whether Ghana DPC notification obligations attach** (usually not — Pilot 1 participants are volunteer testers not covered patients — but counsel confirmation required).
5. **Escalate to ratifier ceremony** — the incident triggers an SI-class review of why the technical gates failed. Codex adversarial review on the root-cause + fix; no Pilot 1 re-open without Evans's re-ratification.
6. **Document in Promotion Ledger** as a P-XXX entry with lessons-learned.

Real-data-on-substrate is a hard STOP with wide implications; the mini-runbook explicitly acknowledges it exceeds Pilot 1's normal scope and hands off to the Pilot 2 full IR runbook framework (draft under `PILOT_1_TO_PILOT_2_GATING_CHECKLIST.md` Gate 6) if the pattern repeats.

---

## What this runbook is NOT

- **Not the Pilot 2 IR runbook.** Pilot 2 needs 24/7 on-call, breach-notification workflows per Ghana DPA + HIPAA, named clinical continuity plan, coordinated processor escalation, tabletop-rehearsed with full quorum. Authored separately under Gate 6 of `PILOT_1_TO_PILOT_2_GATING_CHECKLIST.md`.
- **Not a substitute for spec-corpus incident-response ADRs.** Any invariant-implicating incident feeds back into the SI queue for canonical ratification.
- **Not a scale-tested runbook.** Pilot 1 scale is ~10 participants + a handful of clinicians. Real-world incident-response volumes are handled by Pilot 2's full runbook.

## Rehearsal cadence

- Full STOP-and-purge drill before Pilot 1 Day-0.
- Table-top exercise on each Category 1/2/3 scenario before Pilot 1 Day-0.
- Ad-hoc drill mid-Pilot-1 at Evans's discretion.

## Status

This runbook is COMPLETE for Pilot 1 scope as of filing. Modifications must be committed with a version bump + a note to participants if they are substantive.

- **v1.0** (2026-08-30) — initial draft under Path α ratification.
