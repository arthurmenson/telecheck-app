# PII Screening + Log Redaction Spec — Pilot 1 Substrate Gate

**Filed:** 2026-08-30
**Status:** ACTIVE — companion to `PATH_A_PILOT_COMPLETION_RUNBOOK.md` under Path α ratification
**Owner:** Claude (implementation) + Evans (accept-test of the built system)
**Addresses:** Codex Pass-2 finding 1 (Pilot 1 needs enforceable technical gates against volunteer-injected real PHI)
**Implementation target:** merged + deployed to staging before Pilot 1 Day-0 dry run

---

## Threat model

**Threat:** a Pilot 1 volunteer, despite signing the synthetic-participant consent, enters real personal or clinical information into the system. Vectors:
- Chat free-text field (AI Mode 1)
- Intake form free-text fields
- Consult decision notes (clinician side)
- Any free-text response

**Impact if unmitigated:** real PHI enters the substrate that was declared synthetic-only. Data flows to:
- PostgreSQL (persistent) → backups → durable storage
- AI vendor payloads (Anthropic API + telemetry)
- Pino logs → stdout → `docker logs` → potentially external log aggregation
- Response bodies rendered to clinician console

**Compliance implication:** Hetzner staging becomes de-facto PHI substrate without any of the compliance controls Pilot 2 requires. Codex Pass-2 correctly flagged this as HIGH.

**Mitigation posture:** defense-in-depth across four layers. Each layer independently reduces exposure; combined they materially reduce it to acceptable Pilot 1 residual risk.

---

## Layer 1 — Input screener (block-or-warn at ingress)

**Where:** every route that accepts free-text patient-facing content. Enumerate:
- `POST /v1/ai/mode1/turns` (chat messages)
- `POST /v1/async-consults/:id/intake` (intake form free-text fields)
- `POST /v1/async-consults/:id/decision` (clinician decision notes)
- Any other endpoint accepting `body.text`, `body.notes`, `body.freeText`, `body.symptomDescription`, etc.

**How:** shared middleware `src/lib/pii-screener/` invoked before route handler. On each free-text input:

1. **Regex fast-path** — regex library catches high-confidence patterns:
   - US SSN (`\d{3}-\d{2}-\d{4}`)
   - Ghana National ID (per Ghana Card format — 15 chars)
   - US phone (`(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}`)
   - Ghana phone (`\+233\d{9}` or `0\d{9}`)
   - Email address (`[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}`)
   - Credit card (Luhn-validated 13–19 digit sequences)
   - Common medical record number patterns
   - IPv4 / IPv6

2. **LLM-based classifier** — for anything that passes regex but might still be PII:
   - Small dedicated Claude call: *"Does this free-text contain: real person name, real medical condition tied to identifiable person, real address, real date-of-birth, real medical record identifier, real prescription details tied to identifiable person?"*
   - Returns yes/no + category
   - Deterministic temperature (0.0); prompt-cached for cost control
   - Fail-closed on API error (treat as "yes" and warn/block)

3. **Decision:**
   - Regex hit OR LLM hit on high-confidence category → **BLOCK** with 422 + machine-readable reason + participant-visible message: *"This looks like real personal information. Pilot 1 uses synthetic data only. Please re-enter with synthetic values (see participant kit)."*
   - LLM hit on low-confidence category → **WARN** with 200 + audit-event `pii.screener.warn` + participant-visible message
   - No hit → pass through

**Response contract:**
```json
{
  "error": "pii.screener.block",
  "reason": "regex_match" | "llm_hit_high_confidence",
  "categories": ["ssn", "real_name", "medical_condition_identifiable"],
  "guidance": "Pilot 1 uses synthetic data only. See participant kit for synthetic values."
}
```

**Audit event:** `pii.screener.block` and `pii.screener.warn` per AUDIT_EVENTS Contracts Pack v5.4 (new event to be registered under Sprint 1 as SI extension).

**Testing:** unit tests per category; integration tests against the routes above; adversarial tests confirming known-tricky patterns (e.g. names spelled with unusual capitalization; addresses in international format; phone numbers embedded in prose).

## Layer 2 — Output screener (block-or-redact at egress)

**Where:** every response body rendered to clinician console + patient app.

**How:** response-serialization middleware — same regex + LLM stack as Layer 1 — applied to any field that came from patient free-text (never on system-generated content like protocol names).

**Decision:**
- Regex or high-confidence LLM hit → **REDACT** the specific token with `[REDACTED:PII]`
- Log the redaction as `pii.screener.egress_redact` audit event
- Never expose real PII to the clinician console even if it slipped past Layer 1

**Rationale:** Layer 1 could miss a pattern; Layer 2 is the safety net. Clinician workflow degrades slightly (redaction is visible) but compliance is preserved.

## Layer 3 — Log redaction (Pino)

**Where:** all `pino` log paths — extend `LOG_REDACT_PATHS` in `.env.example` and enforce at boot.

**How:**
- Existing redaction paths: `req.headers.authorization`, `req.body.password`, `req.body.token`
- Add: `req.body.text`, `req.body.notes`, `req.body.freeText`, `req.body.symptomDescription`, `res.body.*.text`, `res.body.*.notes`, any field ever populated from patient input
- Additionally: **regex-based redaction on the entire log line** as a final pass, catching any PII pattern that leaks via a path not in the explicit list

**Rationale:** logs are the third leak vector (stdout → `docker logs` → potentially SIEM or external log aggregation). Even in Pilot 1 with no external SIEM, the redaction discipline prepares for Pilot 2.

## Layer 4 — AI vendor payload sanitization

**Where:** every call to `src/lib/ai-service/` provider adapters (Anthropic primary; Bedrock + Azure secondary).

**How:** before sending a prompt to the provider, run the message-body through Layer 1's screener. If any block-condition fires, do NOT send the prompt — return an error to the caller stating the input needs re-entry. If any warn-condition fires, redact the specific tokens with `[REDACTED:PII]` before sending.

**Rationale:** the AI vendor is a subprocessor that has NOT been authorized for PHI under Ghana law + does NOT have a BAA. Under no circumstances does real PII cross into Anthropic's / Bedrock's / Azure's data plane during Pilot 1.

**Bonus:** this discipline directly reduces AI cost by refusing to send garbage prompts (real names + real medical details are irrelevant to a Mode 1 conversational reply anyway).

## Layer 5 — Backup redaction

**Where:** `pg_dump` invocations for staging backup (currently manual per `STAGING_RUNBOOK.md`).

**How:** wrap `pg_dump` output through a redaction pass that catches any regex patterns in dumped rows before the dump hits durable storage. Rejected patterns get replaced with `[REDACTED:PII]` in the dump; original DB rows are separately audit-logged for incident response.

**Rationale:** durable storage is the highest-consequence leak vector. If backups are ever shared for troubleshooting, they must be clean.

**Nuance:** this layer degrades Pilot 1 backup fidelity slightly (redactions in the dump), which is acceptable because Pilot 1 has no PHI worth preserving faithfully anyway.

---

## Environment purge/reset procedure

**File:** `scripts/pilot-1-env-purge.sh`

**Purpose:** idempotent full reset of the Pilot 1 substrate — DB, Redis, Caddy access logs, application logs. Rehearsed before every Pilot 1 session start and available on-demand for incident response.

**Steps:**
1. `docker compose exec app pkill -TERM node` (graceful app shutdown)
2. `docker compose stop app` (freeze app container)
3. `docker compose exec db psql -U telecheck telecheck -c 'TRUNCATE TABLE ... CASCADE'` for every non-system-config table (schema preserved, data wiped)
4. `docker compose exec redis redis-cli FLUSHALL`
5. `docker compose exec caddy sh -c '> /var/log/access.log'` (Caddy access log truncate)
6. `docker compose logs --no-color app > /home/deploy/incident-logs/purge-$(date -u +%FT%TZ).log` (preserve app-log tail for forensics BEFORE truncate)
7. `docker compose exec app rm -f /app/logs/*.log` (app-log truncate)
8. `docker compose exec db psql -U telecheck telecheck -f /migrations/pilot-1-baseline-seed.sql` (reseed synthetic accounts + tenant baseline)
9. `docker compose start app`
10. Verify `/health` returns 200 on both tenant hosts

**Runtime:** ~60–120 s.

**Rollback path:** none needed — this IS the rollback. Once run, Pilot 1 is at a clean baseline.

## Rehearsal cadence

- Before Pilot 1 Day-0 dry run: full purge + reset + re-seed. Verify.
- Between Pilot 1 sessions (weekly): full purge + reset + re-seed. Verify.
- On any incident: purge + reset + re-seed AFTER preserving forensic evidence per `PILOT_1_INCIDENT_RESPONSE_MINI_RUNBOOK.md`.

---

## Implementation plan (Sprint 1 breakdown)

1. **PR 1.1a — Layer 1 input screener core** (`src/lib/pii-screener/index.ts` + regex library + interface). Unit + integration tests. Wired into `POST /v1/ai/mode1/turns` first.
2. **PR 1.1b — LLM classifier for input screener** (Anthropic prompt-cached call). Cost telemetry.
3. **PR 1.1c — Layer 1 wired to remaining routes** (async-consults intake + decision + any other free-text ingress).
4. **PR 1.1d — Layer 2 output screener** (response middleware; redaction not block on egress).
5. **PR 1.2a — Layer 3 log-redaction extension** (`LOG_REDACT_PATHS` + regex final pass).
6. **PR 1.2b — Layer 4 AI-vendor sanitization** (integrate screener with provider adapters).
7. **PR 1.2c — Layer 5 backup redaction wrapper** (pg_dump wrapper script).
8. **PR 1.3 — Env-purge script + baseline-seed migration** (`scripts/pilot-1-env-purge.sh` + `migrations/pilot-1-baseline-seed.sql`).
9. **PR 1.4 — Adversarial test suite** (attempts to bypass each layer; verifies each layer catches independently).

Each PR through Codex adversarial review → APPROVE → merge → addendum + cockpit bump.

---

## Success metrics

- **Layer 1 (input) recall on adversarial test suite:** ≥ 95% on high-confidence PII patterns; ≥ 80% on subtle patterns
- **Layer 1 false-positive rate on synthetic data:** ≤ 2% (a synthetic phone shouldn't get blocked)
- **Layer 3 log redaction:** 100% recall on all patterns in Layer 1's regex library
- **Layer 4 AI-vendor payload zero-PHI rate:** 100% verified by post-send Layer-1 replay on payloads
- **Layer 5 backup redaction:** 100% recall verified against pg_dump adversarial pass

## Known non-goals

- **Layer 1 is NOT clinical-content classification.** Blocking "high blood pressure" (a common phrase) is out of scope. Only PII patterns tied to identifiable persons.
- **Layer 4 does NOT block AI provider access.** It sanitizes the payload; the AI still receives the (cleaned) turn.
- **These layers do NOT replace Pilot 2's compliant substrate.** They reduce Pilot 1 residual risk; they do not authorize real-PHI processing.
