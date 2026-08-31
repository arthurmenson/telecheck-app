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
3. **If CRITICAL** (all layers bypassed):
   - Halt Pilot 1 (`docker compose stop app`).
   - **Capture forensic evidence via the single fail-closed capture script:** `bash scripts/incident-capture.sh <incident-id>` (assign a fresh incident-id like `2026-08-30T15-45Z-cat1-01`). This script (per §Forensic-evidence preservation) is the ONLY authorized capture path — it sanitizes via regex + local NER, encrypts with age to the project public key, structurally verifies, and emits a SUCCESS manifest tied to the incident-id. **Never write raw `docker compose logs` or raw `pg_dump` to disk during an incident** — the capture script exists precisely so no operator has to compose those commands under pressure.
   - Verify the manifest exists at `/home/deploy/incident-logs/<incident-id>.manifest.json` with `status: SUCCESS`.
   - **Execute manifest-bound purge:** `bash scripts/pilot-1-env-purge.sh --incident-id <incident-id>`. The purge script fails-closed if the manifest is missing / stale / mismatched / already consumed.
   - Halt Pilot 1 until root-cause analysis complete.
4. **Root cause:** file a defect on the layer that should have caught it. Add adversarial test to prevent regression. Codex adversarial review on the fix before re-opening Pilot 1.

### Category 2 — Cross-tenant isolation failure

**Trigger:** any evidence that a participant can see another tenant's data (e.g., a US-tenant participant sees a Ghana-tenant consult by direct API call, or a status endpoint leaks cross-tenant metadata).

**Severity:** **CRITICAL always.** This violates I-023 / I-025 which are platform-floor invariants and cannot be relaxed even in Pilot 1.

**Response:**

1. **Immediate:** halt Pilot 1. All participant sessions suspended.
2. **Isolate:** `docker compose stop app` to freeze the API surface. Postgres + Redis remain up for forensic access.
3. **Preserve via the single fail-closed capture script:** `bash scripts/incident-capture.sh <incident-id>` (per §Forensic-evidence preservation). Script sanitizes + encrypts + verifies before writing. **Never invoke `pg_dump` or `docker compose logs` directly during an incident** — the isolation-failure category is exactly where raw evidence is most likely to contain cross-tenant PHI.
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
2. Claude assigns a fresh incident-id, runs `bash scripts/incident-capture.sh <id>`, verifies SUCCESS manifest, then executes `bash scripts/pilot-1-env-purge.sh --incident-id <id>` (manifest-bound).
3. Root-cause analysis begins. No re-open until Codex adversarial review of the fix + Evans's re-authorization.

**Rehearsal:** before Pilot 1 Day-0 dry run, execute a full STOP-and-purge cycle against a contrived incident to verify the runbook works. Record the drill in the incident log with duration + any friction findings.

---

## Communication channels

- **Primary:** email — participants ← test coordinator → Evans + Claude
- **Backup:** [named Slack / chat channel — Evans to designate before Day-0]
- **Escalation:** Evans's direct phone (documented off-repo per operational-security discipline)

## Forensic-evidence preservation

**Cardinal rule:** an incident-log capture on the non-PHI substrate is a legitimate operational need for defect-attribution, but if the incident involves real-PHI leakage, preserving raw leaked content in cleartext on Hetzner extends the exposure rather than closing it. All evidence handling therefore honors: **sanitize where feasible, encrypt where preserved, retain briefly, destroy verifiably, escalate when real data touches the substrate**.

### Capture procedure — single fail-closed script

**The one authorized capture path is `scripts/incident-capture.sh <incident-id>`.** Operators do not compose raw `docker compose logs` or `pg_dump` commands during an incident — the script exists precisely because the moments requiring evidence preservation are also the moments where a raw redirect would extend PHI exposure.

**Script contract** (per `PII_SCREENING_AND_LOG_REDACTION_SPEC.md` §Layer 3 + §Layer 5):

1. **Sanitize before write** — all captured content flows through `node scripts/pii-scrub.mjs` (regex + local NER pass, same code path as Layer 3) BEFORE any bytes hit disk. Raw unsanitized content never touches the filesystem.
2. **Encrypt before finalize** — sanitized output is encrypted with age to `/home/deploy/.age-recipients` (project public key) before the `.age` suffix is applied. The intermediate sanitized-but-unencrypted file is created in a tmpfs mount that gets unmounted on script exit.
3. **Structural verification (public-key-only, on-VPS)** — script verifies each `.age` file: (a) exists, (b) is non-empty, (c) has a byte size ≥ the plaintext byte count (age adds framing overhead so the ciphertext should never be smaller), (d) begins with the canonical age header (`age-encryption.org/v1` in the file header per age file format spec — script checks the first 32 bytes). If any check fails, script exits non-zero + logs the failure + writes an incident-status file marking capture unsuccessful. **The script does NOT decrypt on the VPS** — the age private key is deliberately off-VPS and the VPS cannot be trusted with it during an incident.
4. **Off-VPS decryption verification (out-of-band, Evans-owned)** — Evans separately downloads the `.age` artifacts to the trusted host holding the age private key, decrypts, and confirms the decrypted content is the expected sanitized content. This step is BEST-PRACTICE for high-severity incidents; not blocking on emergency purge (the structural verification in step 3 gates the purge).
5. **Manifest emitted on success** — a successful `scripts/incident-capture.sh <incident-id>` invocation writes `/home/deploy/incident-logs/<incident-id>.manifest.json` with fields: `{"incidentId": "...", "status": "SUCCESS", "capturedAt": "<ISO-8601>", "artifacts": [{"path": ".../id-app.log.age", "plaintextBytes": N, "ciphertextBytes": M}, ...], "consumed": false}`. A failed invocation writes the manifest with `"status": "FAILED"`, no artifact list. Malformed / incomplete manifests count as FAILED.

6. **Incident-lock file** — `scripts/incident-capture.sh <id>` atomically creates `/home/deploy/incident-logs/.incident.lock` on its first byte written. The lock's presence machine-enforces "an incident is active" — routine-reset purge REFUSES while the lock exists.

7. **Purge gate — incident-mode is manifest + lock bound** — `scripts/pilot-1-env-purge.sh --incident-id <id>` (per `PII_SCREENING_AND_LOG_REDACTION_SPEC.md` §Environment purge preconditions) fails-closed unless the manifest for `<id>` exists + is SUCCESS + is fresh (≤30 min) + matches the id argument + lists ≥1 artifact + each artifact structurally verifies + `consumed: false` + the incident-lock's `incidentId` matches `<id>`. On successful purge the script flips `consumed: true`. The incident-lock remains until an explicit incident-owner disposition (see step 8).

8. **Incident closure — explicit disposition** — after RCA + fix + Codex re-review, the incident owner (Evans) runs `scripts/incident-clear.sh --incident-id <id> --disposition RESOLVED` (requires manifest `consumed: true`) OR `--disposition ABANDONED --force-abandoned` (records reason as audit event). Only this explicit action removes the incident-lock. Routine-reset then becomes available again.

Non-incident environment resets use `scripts/pilot-1-env-purge.sh --routine-reset` (mutually exclusive with `--incident-id`; skips all manifest checks; **fails-closed if the incident-lock exists**) — used at end-of-session, provably never while an incident is under RCA.

**Artifacts captured (all via the single script; per-artifact sanitize + encrypt semantics identical):**

- App log — `/home/deploy/incident-logs/<incident-id>-app.log.age`
- DB snapshot — `/home/deploy/incident-logs/<incident-id>-db.sql.age`
- Caddy access log — `/home/deploy/incident-logs/<incident-id>-caddy.log.age` (URLs + status + timings; no bodies)
- Audit records — `/home/deploy/incident-logs/<incident-id>-audit.csv.age` (audit records are non-PHI per I-027 but encrypted for consistency + defense-in-depth)

**Implementation status:** ⬜ `scripts/incident-capture.sh` + `scripts/pii-scrub.mjs` ship as part of Sprint 1.3. Until they ship, Pilot 1 Day-0 is NOT authorized — no operator manually runs raw evidence-capture commands.

### Encryption key management

- Public key stored on VPS at `/home/deploy/.age-recipients` (age encryption, safe to store publicly)
- Private key stored OFF-VPS by Evans (personal secure storage; not committed anywhere; used only for evidence decryption during root-cause analysis)
- Key rotation: quarterly at minimum; immediately after any Pilot 1 STOP incident

### Retention + destruction

- **Preserved always (cannot be deleted by any generic wipe):**
  - `/home/deploy/incident-logs/.incident.lock` while it exists
  - Any `*.manifest.json` where `consumed: false` OR the corresponding incident-lock still names its incidentId
  - Any `*-<incident-id>-*.age` artifact whose incident-id matches an unconsumed manifest
- **Retention (encrypted incident logs whose manifest is `consumed: true` and lock cleared):** 30 days maximum; auto-purge via `scripts/incident-log-gc.sh` (weekly cron). The GC script's contract: enumerate `*.manifest.json` files; for each, only delete the manifest + its artifacts if manifest.consumed=true AND no incident-lock references that incidentId AND age of file ≥30 days. Never touches `.incident.lock` under any condition. Never deletes an unconsumed manifest.
- **Explicit destruction on Pilot 1 close:** on Pilot 1 exit (win or abort), Evans authorizes full `/home/deploy/incident-logs/` wipe via `scripts/pilot-1-close-wipe.sh --confirm` — script REFUSES if `.incident.lock` exists OR any manifest has `consumed: false`. Any incidents opened but not disposed must be closed via `incident-clear.sh` first. Wipe is recorded in the Pilot 1 close report.
- **Env-purge (both modes) preserves incident state:** neither `pilot-1-env-purge.sh --routine-reset` nor `pilot-1-env-purge.sh --incident-id <id>` deletes `.incident.lock` or any `*.manifest.json`. Only `incident-clear.sh --incident-id <id> --disposition ...` removes the lock; only `incident-log-gc.sh` (after ≥30 days, consumed manifest, cleared lock) removes retained artifacts.
- **Never off-VPS-backup-eligible** — the incident-log path is on VPS-local disk only, not eligible for VPS backup rotation (which presently doesn't exist by design for Pilot 1).

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
