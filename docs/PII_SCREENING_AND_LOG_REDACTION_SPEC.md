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
- Cleared ONLY by `scripts/incident-clear.sh --incident-id <id> --disposition <RESOLVED|ABANDONED>` — an explicit, audited, incident-owner action.
  - `--disposition RESOLVED` requires: (a) matching `env.purge.executed{incidentId=<id>}` audit event exists in `audit_records` (proves purge ran), AND (b) manifest for `<id>` currently has `consumed: false` (proves not double-consumed). On success, atomically writes manifest.consumed=true + removes the lock.
  - `--disposition ABANDONED --force-abandoned <reason>` writes an `env.incident.abandoned{incidentId, reason}` audit event, then atomically writes manifest.consumed=true + removes the lock. Used when RCA determines purge was not appropriate.
  - Clearing script is separate from purge to prevent accidental clearance during purge.
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
- **Manifest single-use enforced via audit-event attestation:** env-purge NEVER writes to the manifest. Instead, on successful purge it emits an `env.purge.executed{incidentId, purgedAt, actor}` audit event (append-only, I-003). Re-invoking env-purge with the same incident-id → refuse (script queries audit_records; if event exists for this incidentId, purge is already attested and re-execution is blocked). Prevents accidental double-purge on the same incident. Only `incident-clear.sh --disposition RESOLVED` transitions the manifest to `consumed: true` (verifying the audit event first).

**Conformance test required:** the CI/test suite must include an assertion that env-purge (both modes) leaves the entire `/home/deploy/incident-logs/` tree byte-for-byte unchanged. Diff-based comparison; any change is a purge-script defect.

The purge script itself performs NO raw evidence capture. Any forensic artifact must have been produced by the single fail-closed capture path documented in `PILOT_1_INCIDENT_RESPONSE_MINI_RUNBOOK.md` §Capture procedure BEFORE this script runs.

**Purge table classification policy (spec = policy; Sprint 1.3 implementation PR = FK-graph resolution):**

This specification defines POLICY:
- Participant-data tables are removed to reset the environment
- Schema fixtures, tenant baseline, and immutable evidence (`audit_records`, `audit_dedupe_markers`, `domain_events_outbox`) are preserved
- No blanket truncation — every table must be classified explicitly as one of: **`allowlist`** (participant-only; TRUNCATE), **`preserved`** (never touched), or **`scoped-delete`** (mixed baseline + participant; DELETE with WHERE preserving baseline rows)
- The append-only audit chain must survive purge to carry `env.purge.executed` attestation (I-003)
- The complete FK-aware purge plan (all TRUNCATEs + all scoped DELETEs) executes in a SINGLE transaction with the attestation — failure of any step rolls back all mutations AND the attestation atomically

The **FK-graph resolution** (what SQL operation on which tables in which order) is the responsibility of the Sprint 1.3 implementation PR, which:
1. Enumerates every table in migrations 000–HEAD
2. Classifies each as one of the three: **`allowlist`** (participant-only; TRUNCATE) / **`preserved`** (never touched) / **`scoped-delete`** (mixed baseline + participant; DELETE WHERE clause preserves baseline rows)
3. Models the FK edges between classifications
4. **Prohibits `TRUNCATE ... CASCADE` where CASCADE would reach a preserved table** — instead uses `scoped-delete` for the parent + reclassifies participant-bound child tables (`forms_snapshot` referencing `forms_submission`) or moves the parent to `scoped-delete` with a WHERE predicate that removes only participant rows
5. **Mixed-baseline tables (`accounts` and any table that persists both operators + participants) MUST be classified `scoped-delete`, NEVER `allowlist`.** Truncating `accounts` would erase operator + tenant-service accounts + admin identities — a baseline-loss defect. The scoping predicate MUST NOT rely on account type alone (per migrations 012/027/028 the `accounts.account_type` values include `patient`, `delegate`, `clinician`, `tenant_admin`, `platform_admin` — filtering to `account_type = 'patient'` misses `delegate` participants who are also Pilot-1 participants). Instead: at pilot-1 baseline seed time, every participant account gets an explicit Pilot-1 provenance marker (implementation choice: dedicated column added by Sprint 1.3 migration, OR structured `metadata->>'pilot_1_cohort_id'` tag). The scoped-DELETE predicate uses that marker: `DELETE FROM accounts WHERE <pilot_1_cohort_marker>`. This deletes ALL participant account types (patient + delegate) while preserving clinician / tenant_admin / platform_admin / service identities. Sprint 1.3 PR defines the exact marker + predicate + writes it into `pilot-1-baseline-seed.sql`.
6. Produces the CI test suite that verifies (a) schema-drift classification completeness, (b) canary purge behavior across all three classifications, (c) no FK edge crosses from preserved-scope evidence into truncated-scope data (or, if intentional, is documented + tested for correct scoped-DELETE handling), (d) mixed-baseline-table safeguard: known mixed-baseline tables (`accounts` at minimum) MUST be classified `scoped-delete`; CI test rejects any classification of `accounts` as `allowlist`.

Illustrative classification below reflects a first-pass reading of migrations 000–079. Sprint 1.3 PR revises it against actual FK graph and adds the operational plan (TRUNCATE vs scoped DELETE) per table.

**Illustrative classification (verified against migrations 000–079 as of 2026-08-30; Sprint 1.3 PR must re-verify against migrations at merge time):**

**Classification `scoped-delete` (mixed baseline + participant — DELETE WHERE preserves baseline):**
- `accounts` — DELETE WHERE `<pilot_1_cohort_marker>` (Sprint 1.3 chooses the marker mechanism: dedicated column or `metadata->>'pilot_1_cohort_id'` JSON field). Removes ALL participant account types (`patient` + `delegate`) while preserving `clinician` + `tenant_admin` + `platform_admin` + service accounts. `account_type`-only filtering is INSUFFICIENT because delegates are participants too. Time-window-only filtering is INSUFFICIENT because pre-created / retried pilot identities can fall outside the window. MUST NOT be `allowlist`.

**Classification `allowlist` (participant-only — TRUNCATE):**
- **Identity + auth (participant-only child tables):** `sessions`, `otp_challenges`, `auth_devices`, `account_pin_credentials`, `email_passcodes` — these have FK to `accounts`; dependency order: TRUNCATE these BEFORE the `accounts` scoped-DELETE (or handle via DELETE-then-DELETE with correct ordering)
- **Consent (participant records only; schema `consent_versions` preserved):** `consent`, `delegations`, `delegation_scopes`
- **Forms + intake:** `forms_submission`, `forms_resume_state`, `consult_intake_submission`
- **Consults + clinical:** `consult`, `consult_lifecycle_transition`, `consult_review_claim`, `consult_clinical_summary`, `consult_clinician_decision`, `consult_follow_up_message`, `consults`, `consult_events` (dual naming from schema evolution — both preserved in the list until reconciliation)
- **AI Mode 1:** `ai_mode1_conversation`, `ai_mode1_conversation_turn_admission`, `ai_mode1_conversation_turn_detector_result`, `ai_mode1_conversation_turn_result`, `ai_mode1_conversation_archival_event`
- **Medication + pharmacy:** `medication_requests`, `refills`, `dispensings`, `shipments`
- **Interactions:** `interaction_engine_evaluation`, `interaction_signal`, `interaction_signal_override`, `interaction_signal_lifecycle_transition`
- **Crisis:** `crisis_event`, `crisis_event_lifecycle_transition`, `crisis_sweep_execution`, `notification_crisis_dispatch_ledger`, `notification_crisis_provider_attempt`, `notification_crisis_escalation_obligation`
- **Subscription:** `subscriptions`, `subscription_events`
- **Idempotency:** `idempotency_keys`
- **Redis:** FLUSHALL (Redis is cache/queues; nothing there is source of truth)

**Explicitly PRESERVED (never truncated by env-purge):**
- `audit_records` — I-003 append-only; vehicle for `env.purge.executed` attestation + `env.incident.abandoned` and all other audit events. Truncating would break the manifest-clear flow AND violate I-003.
- `audit_dedupe_markers` — companion to audit_records (dedup discipline requires preservation across purge)
- `tenants`, `tenant_brands`, `tenant_users`, `country_profiles`, `ccr_configs`, `adapter_configs` — tenant baseline
- `forms_template`, `forms_deployment`, `forms_snapshot`, `forms_variant`, `consent_versions`, `product_catalog`, `ai_provider_credential`, `forms_template_admin_review`, `forms_template_admin_review_lifecycle_transition`, `admin_template_decision_idempotency_key`, `admin_dashboard_query_execution` — configuration + admin-review artifacts
- `_session_actor_context`, `_session_tenant_context` — session-context scaffolding (transient at request scope; not participant-owned data)
- `domain_events_outbox` — event-emission ledger (preserved across purge; downstream consumers may need historical events)
- `schema_migrations` — migrations tracker
- Any Postgres system catalog

**Sprint 1.3 CI test suite (mandatory):**

1. **Schema-drift classification test:** enumerate live schema (`information_schema.tables` filtered to `public`) at test time; cross-reference against checked-in classification map (`allowlist` | `preserved` | `scoped-delete` — the last for mixed-baseline tables like `accounts`); FAIL if any live table lacks classification. New migrations adding tables MUST add classification in the same PR.
2. **Preserved-to-purged FK-edge test:** enumerate FK constraints from `information_schema.referential_constraints`; FAIL if any FK edge points from a `preserved`-scope table to an `allowlist`-scope table (would break under TRUNCATE) OR from a `preserved`-scope table to a `scoped-delete`-scope table where the scoped-delete plan does not preserve the referenced rows.
3. **Seeded-canary purge integration test:** seed identifiable canary rows into every classified table via `pilot-1-baseline-seed.sql --with-canaries`. For `scoped-delete` tables and specifically for `accounts`, seed BOTH participant-scoped canaries AND baseline canaries across every mixed identity type. Explicit canaries required for `accounts`:
   - `patient` account with pilot_1_cohort_marker (participant; expected DELETED)
   - `delegate` account with pilot_1_cohort_marker (participant; expected DELETED)
   - `patient` account WITHOUT pilot_1_cohort_marker (pre-window / retried; test decides whether this qualifies as participant — implementation predicate must handle it)
   - `clinician` account (baseline; expected INTACT)
   - `tenant_admin` account (baseline; expected INTACT)
   - `platform_admin` account (baseline; expected INTACT)
   - Any service account (baseline; expected INTACT)

   Run env-purge (both modes: routine-reset from clean; incident-mode with manifest); verify (a) every `allowlist`-canary is GONE, (b) every `preserved`-canary is INTACT, (c) every `scoped-delete`-canary matches expectation per above enumeration, (d) `audit_records` contains the `env.purge.executed` event with matching incidentId (incident-mode only), (e) no orphaned FK rows across the entire schema post-purge, (f) no baseline account of ANY type deleted under any code path.
4. **Attestation-transaction test:** verify FK-aware atomic purge rollback across BOTH operation kinds:
   - Inject a failure AFTER at least one successful `TRUNCATE` on an `allowlist` table but before COMMIT — verify the entire transaction rolls back: audit event GONE + truncated table's rows RESTORED + purge exits non-zero
   - Inject a failure AFTER at least one successful scoped `DELETE` on a `scoped-delete` table but before COMMIT — verify the same: audit event GONE + deleted rows RESTORED + purge exits non-zero
   - Inject a failure INSIDE the audit event INSERT — verify no participant mutation occurred + purge exits non-zero

**Post-purge:** re-seed synthetic tenant baseline + participant handles per `pilot-1-baseline-seed.sql`. Baseline seed is idempotent (uses `ON CONFLICT DO NOTHING`).

**Attestation transaction (FK-aware):** the `env.purge.executed` audit event is inserted BEFORE any participant-data mutation, in the same transaction as the complete FK-aware purge plan. Order: BEGIN → INSERT `env.purge.executed` audit event → execute the complete purge plan (all `TRUNCATE` operations for `allowlist` tables in FK dependency order + all `DELETE ... WHERE` operations for `scoped-delete` tables per their scoping predicate) → COMMIT. Any error at any step rolls back the entire transaction including the attestation — no false attestation, no partial participant deletion. Second stage (reseed) is a separate transaction executed only after successful COMMIT.

**Steps:**
1. `docker compose exec app pkill -TERM node` (graceful app shutdown)
2. `docker compose stop app` (freeze app container)
3. `docker compose exec db psql -U telecheck telecheck` — single atomic transaction: BEGIN → INSERT `env.purge.executed` audit event → execute complete FK-aware purge plan (all TRUNCATEs + all scoped DELETEs per the Sprint 1.3 classification map) → COMMIT. On any error, transaction rolls back completely (audit event + any partial deletion); env-purge exits non-zero; Redis + app logs are NOT touched (steps 4-6 are gated on step 3 success).
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
