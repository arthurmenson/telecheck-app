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

2. **Local NER-based classifier** — for anything that passes regex but might still be PII, use a classifier that runs **entirely inside the trusted staging boundary**:
   - Candidate stack: Microsoft Presidio (open-source PII detection library; runs locally) OR spaCy NER model with a `PERSON`/`GPE`/`ORG` filter, OR a lightweight Node-native pattern classifier
   - **Absolute prohibition:** never send suspected-PHI candidate text to any external AI provider (Anthropic, Bedrock, Azure) to determine if it contains PHI. That would defeat the entire purpose of the layer — the whole reason a candidate reaches Layer 1's secondary classifier is because it MIGHT be real PHI, and sending real PHI to the unauthorized processor is exactly what Layer 4 exists to prevent.
   - Fail-closed on classifier error (treat as "yes" and warn/block)
   - **Adversarial test required:** integration test proving raw candidate text never egresses to any external provider from within the Layer 1 code path

3. **Decision (routes that eventually reach an external AI provider — `POST /v1/ai/mode1/turns` and any other AI-bound endpoint):**
   - Regex hit OR ANY local-NER hit (high OR low confidence) → **BLOCK** with 422 + machine-readable reason + participant-visible message: *"This looks like real personal information. Pilot 1 uses synthetic data only. Please re-enter with synthetic values (see participant kit)."*
   - No hit → pass through

   **Invariant:** on AI-bound routes, low-confidence NER hits are NEVER admitted to the request handler. Prose-form real names and addresses trigger NER but not regex; if they were admitted with only a warn, they could reach Layer 4 (which is regex-only) and cross into the provider payload. Blocking on any NER hit for AI-bound routes closes that path.

4. **Decision (routes that do NOT reach an external AI provider — clinician decision notes, purely internal free-text):**
   - Regex hit OR local-NER hit on high-confidence category → **BLOCK** with 422 (same as above)
   - Local-NER hit on low-confidence category → **REDACT INLINE** in the persisted record with `[REDACTED:PII]` before storage + emit `pii.screener.warn` audit event + participant-visible warning
   - No hit → pass through

**Sprint 1 phasing note:** if a production-quality local NER classifier is not available in the first shipped PR (Sprint 1.1a-b), the initial implementation uses **regex-only** with a conservative pattern set + explicit gate that Pilot 1 Day-0 dry run does NOT authorize until the local NER classifier ships. The regex-only interim is safe because it fail-closes (it does not send candidate text anywhere) — it may under-catch prose-form PII but never leaks candidate content to a provider. **The provider boundary is only opened for participants after the local NER classifier ships.**

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

**How:** response-serialization middleware — same regex + **local NER** stack as Layer 1 (identical prohibition on external-provider classification) — applied to any field that came from patient free-text (never on system-generated content like protocol names).

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

**How:** the input screener at Layer 1 has already blocked or warned on suspected PHI before the request handler runs. Layer 4 is defense-in-depth on the egress side:
- Re-run **regex-only** screening (never NER — Layer 1's NER may not have been invoked on system-generated prompt scaffolding that only Layer 4 sees) against the assembled outbound prompt (system prompt + prior turns + current turn + tool inputs)
- If any high-confidence regex pattern fires in the outbound payload, do NOT send the prompt — return `500 ai.provider.egress_blocked` to the caller with audit event `pii.screener.egress_block`
- Redact any lower-confidence regex hit with `[REDACTED:PII]` before send and emit `pii.screener.egress_redact` audit event
- **Absolute:** all screening on outbound payloads happens LOCALLY. Layer 4 never calls the AI provider to determine if content is PHI (see Layer 1 §Local NER-based classifier §Absolute prohibition).

**Rationale:** the AI vendor is a subprocessor NOT authorized for PHI under Ghana law + no BAA. Under no circumstances does real PII cross into Anthropic's / Bedrock's / Azure's data plane during Pilot 1.

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

**Incident-lock file (machine-enforced incident state):**

- Location: `/home/deploy/incident-logs/.incident.lock` — a JSON file created atomically by `scripts/incident-capture.sh <id>` on its FIRST byte written (before any capture work). Content: `{"incidentId": "<id>", "openedAt": "<ISO-8601>", "openedBy": "<hostname/user>"}`.
- Cleared ONLY by `scripts/incident-clear.sh --incident-id <id> --disposition <RESOLVED|ABANDONED>` — an explicit, audited, incident-owner action. Requires manifest for `<id>` to be marked `consumed: true` OR requires `--force-abandoned` (which writes an audit event + records the reason). Clearing script is separate from purge to prevent accidental clearance during purge.
- The presence of the lock file signals: an incident is active; routine-reset MUST refuse; only incident-mode purge with the matching `<id>` is permitted.

**Two invocation modes (mutually exclusive; script errors if both flags are set or neither):**

- **Routine-reset mode:** `bash scripts/pilot-1-env-purge.sh --routine-reset` — no active incident; used at end-of-session or between test days. Skips all incident-manifest checks. Performs env wipe + reseed only. **Fails-closed if `/home/deploy/incident-logs/.incident.lock` exists OR any unconsumed manifest file exists.** Cannot be forced past the lock — the operator MUST first run `scripts/incident-clear.sh` after disposing of the incident.
- **Incident-mode:** `bash scripts/pilot-1-env-purge.sh --incident-id <id>` — READS `/home/deploy/incident-logs/` to verify preconditions (manifest existence/status/freshness/identity/inventory/consumed=false; lock's incidentId matches). Executes purge. Emits **an append-only DB audit event `env.purge.executed`** with `{incidentId, purgedAt, actor}` into `audit_records` (which is I-003 append-only + preserved across purge by design). **Env-purge writes zero files, zero modifications, zero deletions under `/home/deploy/incident-logs/`.** The audit event is the sole attestation that this incident's purge ran; `incident-clear.sh` verifies it. Mismatched lock → refuse (protects against invoking purge with wrong incident id while a different incident is open).

**Incident-mode preconditions checked at script start (fail-closed):**
- **Manifest existence:** `/home/deploy/incident-logs/<id>.manifest.json` must exist. Missing manifest → refuse.
- **Manifest status:** must contain `"status": "SUCCESS"`. Any other value (including missing / FAILED / IN_PROGRESS / null) → refuse.
- **Manifest freshness:** manifest's `capturedAt` timestamp must be within 30 minutes of the purge invocation. Stale manifest → refuse. (Rationale: an old incident's manifest cannot authorize purge for a new incident.)
- **Manifest identity:** manifest's `incidentId` field must exactly match the `--incident-id` argument. Mismatch → refuse.
- **Manifest inventory:** manifest must list ≥1 captured artifact with paths under `/home/deploy/incident-logs/<id>-*.age`. Empty inventory → refuse.
- **Artifact structural verification:** for each listed artifact, script re-runs the same structural check as the capture script (file exists + non-empty + age-header valid + size ≥ recorded plaintext byte count). Any check fail → refuse.
- **Manifest single-use:** on successful purge, script writes `"consumed": true` back to the manifest. Re-invoking the purge with the same incident-id → refuse. Prevents accidental double-purge on the same incident.

The purge script itself performs NO raw evidence capture. Any forensic artifact must have been produced by the single fail-closed capture path documented in `PILOT_1_INCIDENT_RESPONSE_MINI_RUNBOOK.md` §Capture procedure BEFORE this script runs.

**Steps:**
1. `docker compose exec app pkill -TERM node` (graceful app shutdown)
2. `docker compose stop app` (freeze app container)
3. `docker compose exec db psql -U telecheck telecheck -c 'TRUNCATE TABLE ... CASCADE'` for every non-system-config table (schema preserved, data wiped)
4. `docker compose exec redis redis-cli FLUSHALL`
5. `docker compose exec caddy sh -c '> /var/log/access.log'` (Caddy access log truncate — no cleartext capture; the incident-capture script already captured caddy)
6. `docker compose exec app rm -f /app/logs/*.log` (app-log truncate — no cleartext capture; the incident-capture script already captured app logs sanitized+encrypted)
7. `docker compose exec db psql -U telecheck telecheck -f /migrations/pilot-1-baseline-seed.sql` (reseed synthetic accounts + tenant baseline)
8. `docker compose start app`
9. Verify `/health` returns 200 on both tenant hosts
10. **Regression test — this script MUST NOT touch `/home/deploy/incident-logs/` under any code path.** No delete, no create, no modify. The directory is owned entirely by `incident-capture.sh` (creates), `incident-clear.sh` (removes lock), and `incident-log-gc.sh` (removes aged consumed manifests + artifacts). If purge script ever writes or removes anything under `incident-logs/`, that is a purge-script defect. Add a CI test that runs purge against a stub directory and asserts zero changes to `incident-logs/` contents.

**Runtime:** ~60–120 s.

**Rollback path:** none needed — this IS the rollback. Once run, Pilot 1 is at a clean baseline.

## Rehearsal cadence

- Before Pilot 1 Day-0 dry run: full purge + reset + re-seed. Verify.
- Between Pilot 1 sessions (weekly): full purge + reset + re-seed. Verify.
- On any incident: purge + reset + re-seed AFTER preserving forensic evidence per `PILOT_1_INCIDENT_RESPONSE_MINI_RUNBOOK.md`.

---

## Implementation plan (Sprint 1 breakdown)

1. **PR 1.1a — Layer 1 input screener regex core** (`src/lib/pii-screener/index.ts` + regex library + interface). Unit + integration tests. Wired into `POST /v1/ai/mode1/turns` first. AI-bound routes fail-closed on any hit; internal routes fail-closed on high-confidence, redact-inline on low-confidence (initially the two behaviors are identical since only regex exists).
2. **PR 1.1b — Layer 1 local NER classifier** (Microsoft Presidio OR spaCy NER OR Node-native pattern classifier — decision recorded in the PR). **Never Anthropic / Bedrock / Azure.** Cost is compute-local. Wires into the same Layer 1 middleware; AI-bound routes now BLOCK on any NER hit; internal routes REDACT-INLINE on low-confidence NER hit. Integration test proves raw candidate text does not egress to any provider.
3. **PR 1.1c — Layer 1 wired to remaining routes** (async-consults intake + decision + any other free-text ingress). Each route classified as AI-bound-vs-internal per §Layer 1 Decision rules.
4. **PR 1.1d — Layer 2 output screener** (response middleware; regex + local NER same discipline; redact inline in response body; never call provider).
5. **PR 1.2a — Layer 3 log-redaction extension** (`LOG_REDACT_PATHS` + regex final pass on all log lines).
6. **PR 1.2b — Layer 4 AI-vendor sanitization** (regex-only local pass before every outbound provider call; never calls provider to classify). Integrates with existing provider adapters.
7. **PR 1.2c — Layer 5 backup redaction wrapper** (`pg_dump | node scripts/pii-scrub.mjs` with age-encryption of the output).
8. **PR 1.3 — Env-purge + incident-scripts package** (`scripts/pilot-1-env-purge.sh` with the two mutually-exclusive modes + `migrations/pilot-1-baseline-seed.sql` + `scripts/incident-capture.sh` + `scripts/incident-clear.sh` + `scripts/incident-log-gc.sh` + `scripts/pilot-1-close-wipe.sh` + `scripts/pii-scrub.mjs`). Env-purge NEVER touches `/home/deploy/incident-logs/`; single-writer discipline enforced; CI test asserts.
9. **PR 1.4 — Adversarial test suite** (attempts to bypass each layer; verifies each layer catches independently; explicit test that NO layer sends candidate text to any external AI provider under any code path).

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
