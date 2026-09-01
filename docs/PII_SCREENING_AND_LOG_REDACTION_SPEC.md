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

**Where:** every route that accepts **server-visible plaintext** free-text patient-facing content.

### ⚠️ Sprint 1.1c finding — the server-visible surface is ONE route, not four

The original enumeration in this spec assumed four screenable routes. Implementation (Sprint 1.1c, 2026-08-31) established that **only one route in the current codebase exposes plaintext free-text to the server**:

| Route | Free-text posture | Layer 1 screenable? |
|---|---|---|
| `POST /v0/ai/chat` (Mode 1) | **Plaintext** `message_text` in request body | ✅ **YES — wired Sprint 1.1c** |
| `POST /v1/async-consults/:id/intake` | Pre-encrypted 8-field KMS envelope (`intake_payload_envelope`) per I-026 | ❌ NO — server never sees plaintext |
| `POST /v1/async-consults/:id/decision` | Pre-encrypted 8-field KMS envelope (`decision_rationale_envelope`) per I-026 | ❌ NO — server never sees plaintext |
| `POST /v1/async-consults/:id/follow-up-messages` | Pre-encrypted 8-field KMS envelope (`message_envelope`) per I-026 | ❌ NO — server never sees plaintext |

The async-consult family encrypts client-side per I-026 (KMS envelope posture; `v1-shared.ts`). The backend receives ciphertext + DEK id + IV + tag and stores it verbatim. There is no plaintext for a server-side screener to inspect — this is not a wiring gap, it is the architecture working as designed.

### Consequence — client-side screening gap (Pilot 1 open item)

Layer 1 as implemented protects the Mode 1 chat route ONLY. For the async-consult routes, PII screening must run **client-side, before encryption**, in:
- `telecheck-patient-app` (Expo/React Native) — intake form + follow-up message composer
- `telecheck-clinician-console` (Vite/React) — decision-rationale composer

That is **Track 4 work**, not backend work. It is a **Pilot 1 startup-authorization gate item** — see `PATH_A_PILOT_COMPLETION_RUNBOOK.md` §Technical gates.

**Interim Pilot 1 mitigation until client-side screening ships:** participant training (the one-pager delivered with the consent form) explicitly instructs participants to use only scripted synthetic scenario content in intake + decision + follow-up fields. Layer 5 (backup redaction) cannot help here either — the stored value is ciphertext. The residual risk is real and must be accepted explicitly by the ratifier before Day-0, or client-side screening must land first.

### Screenable-route implementation

- `POST /v0/ai/chat` — `message_text` field. **Route class: `ai_bound`** (reaches Anthropic / Bedrock / Azure on the non-crisis path), so ANY hit blocks per the decision matrix.

**Ordering invariant (Sprint 1.1c, non-negotiable):** the screener runs **AFTER** the I-019 crisis gate and **BEFORE** Stage-2 validation / persistence / the LLM call.
- *After the crisis gate* because I-019 / FLOOR-013 is platform-floor: crisis detection must run on raw text and must not be suppressible. A distressed participant who also typed real PII still gets the crisis sentinel + Category A audit. The crisis path makes no LLM call (AI_LAYERING §6 crisis-write exception), so no PII crosses the provider boundary on it.
- *Before persistence + LLM call* on the non-crisis path, so a blocked turn never persists and the provider never sees the text.

**Accepted residual risk (documented, not hidden):** a crisis-positive turn that ALSO contains real PII persists the raw `user_message` into `ai_mode1_conversation_turn_admission`. The crisis floor outranks the PII block by design. Mitigations: Layer 3 log redaction, Layer 5 backup redaction, and the IR runbook Category 1 CRITICAL path (capture → purge). Test `PII-6` in `tests/integration/ai-service-mode-1-chat-http.test.ts` pins this ordering invariant.

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

## Layer 2 — Output screener (REDACT-ONLY at egress)

### Egress inventory (established Sprint 1.1d, 2026-08-31)

As with the Layer 1 ingress sweep, the assumed surface was wider than the real one. Actual response-side plaintext:

| Egress surface | Content | Screenable? |
|---|---|---|
| Mode 1 `response_text` | **model-generated prose** | ✅ **YES — wired Sprint 1.1d** |
| async-consult reads (consult / follow-up / decision) | pre-encrypted KMS envelopes (I-026) | ❌ ciphertext |
| Admin dashboards (`consult-queue-health`, `crisis-operational-health`, `mode1-volume-health`) | aggregate counts | ❌ no free-text echo |
| Mode 1 crisis sentinel | fixed server-side constant `CRISIS_RESPONSE_TEXT` | ❌ not user-derived |

### Threat model — what Layer 2 actually defends against

It is NOT the participant's own PII round-tripping. Layer 1 blocks that at ingress: the Mode 1 route is class `ai_bound`, which blocks on ANY hit, so the provider never receives participant PII in the first place. Verified independently: conversation history is **not** replayed to the provider — the prompt is built as `messages: [{ role: 'user', content: rawMessageText }]`, current turn only, so crisis-path-persisted PII cannot leak forward into a later completion.

What remains, and what Layer 2 exists for: **the model emitting PII-shaped text of its own accord** — a hallucinated person name, a plausible-looking SSN, an invented email address. That output is not real PII, but it is indistinguishable from real PII to the participant reading it, and if it coincides with a real identifier it becomes a genuine hazard.

### Why REDACT-ONLY, never block

By the time content reaches egress the work is already done — the LLM has been called, the rows have been written. Blocking the response would cost the participant their turn while leaving upstream state intact: strictly worse than redacting. Layer 1 is the blocking gate; Layer 2 is the safety net.

**Contract:** `screenOutput(text) → { hits, output, redacted }`. There is deliberately **no `action` field** — the only outcomes are redacted-or-not. Pinned by test.

**Both surfaces receive the redacted text.** The Mode 1 handler assigns `egress.output` to *both* `responseText` (what the participant sees) and `persistedAssistantMessage` (what lands in `turn_result`). They must not diverge — a later reader of the stored turn should see exactly what the participant saw.

**How:** same regex + **local NER** stack as Layer 1, with the identical prohibition on external-provider classification.

---

## Route class `audit_bound` (Sprint 1.1d)

A third route class, stricter than `internal` and distinct in rationale from `ai_bound`.

**Where it applies:** `POST /v1/admin/templates/:template_id/reviews/:review_id/decision` — the `decision_payload` object (`review_notes`, `required_revisions[]`, and any forward-extensible string field). **This route was missed by the Sprint 1.1c ingress sweep**, which searched patient-facing routes; this one is reviewer-facing.

**Why it is stricter than `internal`:**

The audit chain is **append-only per I-003**, and the Pilot 1 env-purge allowlist explicitly **PRESERVES** `audit_records` — it has to, because it carries the `env.purge.executed` attestation. So PII that reaches an audit row **survives the environment purge entirely**. The mitigation Pilot 1 leans on everywhere else — capture, then purge — simply does not apply.

Redact-inline is not available either: rewriting an audit payload after the fact would itself violate I-003.

Therefore `audit_bound` **blocks on ANY hit, high or low confidence**, before the audit row is written. Reason code `match_any_audit_bound`.

**Screening walks every string in the payload, recursively** (including inside arrays), because the shape is deliberately forward-extensible. Pinning the screener to `review_notes` alone would silently stop screening the next field someone adds. Depth-bounded at 16.

### Decision matrix (complete, all three classes)

| Route class | Any hit | Rationale |
|---|---|---|
| `ai_bound` | **BLOCK** | Content reaches an external provider with no BAA |
| `audit_bound` | **BLOCK** | Content reaches append-only, purge-exempt storage |
| `internal` + high-confidence | **BLOCK** | Persists to DB, but purgeable |
| `internal` + low-confidence only | **REDACT INLINE** | Preserves workflow; purgeable |

**Decision:**
- Regex or high-confidence LLM hit → **REDACT** the specific token with `[REDACTED:PII]`
- Log the redaction as `pii.screener.egress_redact` audit event
- Never expose real PII to the clinician console even if it slipped past Layer 1

**Rationale:** Layer 1 could miss a pattern; Layer 2 is the safety net. Clinician workflow degrades slightly (redaction is visible) but compliance is preserved.

## Layer 3 — Log redaction (Pino) — implemented Sprint 1.2a

**Rationale:** logs are the third leak vector (stdout → `docker logs` → potentially SIEM or external log aggregation). Even in Pilot 1 with no external SIEM, the discipline prepares for Pilot 2.

### Log-surface audit (Sprint 1.2a, 2026-09-01)

Before implementing, the actual logging surface was enumerated. **The codebase's logging discipline is already sound**: across all 38 `log.*` call sites in `src/`, every merge-object key is an identifier, a status, a count, or a pattern-id list. None is raw user free-text. There are no template-literal log messages interpolating request data.

So the residual risk is **not a forgotten field name**, and adding more `redact.paths` entries would not address it. Two structural vectors remain:

1. **Error objects.** Four call sites log `err`. `Error.message` is caller-shaped — a Postgres error can echo an offending value (`Key (email)=(...) already exists`), a driver can interpolate a parameter, and a future `throw new Error(\`bad input: ${x}\`)` can carry anything.
2. **Future call sites.** A path allowlist protects the code that exists today; the next handler written is unprotected until someone remembers to extend the list.

Both are structural, so the mitigation is structural.

### Two-part posture

**Part 1 — `redact.paths` (allowlist).** Exact, cheap, configured via `LOG_REDACT_PATHS`. Runs first with `remove: true`, so a listed path is dropped entirely. Current value includes `req.headers.authorization`, `req.body.password`, `req.body.token`, `req.body.message_text`.

**Part 2 — whole-line regex pass at the DESTINATION STREAM.** `src/lib/pii-screener/log-redaction.ts`, wired as `stream: createRedactingStream(process.stdout)` in `defaultLoggerConfig()`.

#### Why the stream, and NOT `hooks.logMethod`

`hooks.logMethod` is the obvious seam and it is the wrong one. Two reasons, both surfaced by Codex review of the first implementation:

- **It runs BEFORE pino's serializers.** Fastify's `req`/`res` serializers turn request objects into log records *after* the hook has run — so anything a serializer produces is never seen. That includes **the request URL with its query string**, which is entirely client-controlled. `/?email=real.person@example.com` was a live leak vector under the hook design.
- **Rebuilding objects there corrupts them.** Fastify request properties (`method`, `url`, `headers`, `host`, `ip`) are prototype getters. `Object.entries()` does not copy prototype getters, so cloning the request into a plain object hands the downstream serializer a structurally damaged input, producing empty or incomplete request records — deleting exactly the diagnostics an incident needs.

Redacting at the destination stream avoids both: the line is already fully serialized (serializer output, child bindings, and message all present), and no live object is ever touched.

#### Line handling

Each line is parsed as pino NDJSON, walked with key-awareness, and re-serialized. If a line is not parseable JSON (a pretty-print transport, a partial chunk, a non-JSON warning) it falls back to a whole-line regex scrub — **fail safe**: an unparseable line is still scrubbed, it just loses the identifier carve-out. Batched multi-line chunks are handled per line, preserving framing.

### Regex-only — NER is deliberately NOT used at Layer 3

Layers 1 and 2 run regex + local NER. Layer 3 runs regex only:

- **Cost.** NER is model inference. Logs are high-volume and on the hot path.
- **Precision.** NER's PERSON/GPE/ORG classes would fire on the operational vocabulary logs are made of — role names, tenant identifiers, provider names, module names. Redacting those destroys debuggability while protecting nothing.
- **Value.** What actually shows up in a leaked log line is *structured* identifiers — SSN, email, phone, card. Regex's strength.

### High-confidence patterns only

Low-confidence patterns (IPv4, IPv6, context-bound passport) are **not** scrubbed at Layer 3. An IP address in a log line is usually infrastructure, not PII; removing it would delete genuinely useful diagnostic signal during exactly the incident the logs exist for.

### Identifier-key preservation — keys on the KEY NAME only

A blanket string scrub has a real false-positive mode: `us_ssn` also matches any bare 9-digit run. Most identifiers here are safe from it — UUIDs never expose a 9-digit run bounded by non-digits, and codes like `pg_sqlstate` are too short — but a ULID (26 chars of Crockford base32) can by chance contain exactly nine consecutive digits, and redacting a ULID mid-incident would break correlation.

So values under **server-generated** identifier keys are preserved verbatim, matched on the key name (`*_id` / `*Id` suffix, plus an explicit set: `tenant_id`, `route`, `method`, `status`, `pg_sqlstate`, `provider`, …).

**Client-influenced keys are deliberately NOT carved out.** `url`, `path`, `query`, `params`, `body`, `headers`, `host` are all caller-shaped; their values ARE scrubbed. `url` was present in the first draft's carve-out and was a genuine leak — the claim that a key-name carve-out "cannot be steered by user input" holds only when the key's *value* is server-generated, which for `url` it is not.

The carve-out also applies only to **scalar** values. A nested object under an identifier key is still walked, so `{ request_id: { note: "<pii>" } }` cannot slip through by nesting.

### Depth handling — fails CLOSED via sentinel

Past `LOG_REDACTION_MAX_DEPTH` (32) the subtree is replaced with the fixed `[REDACTED:DEPTH_LIMIT]` sentinel.

The first implementation returned the raw subtree at the bound, arguing that throwing would break logging and that this was the only alternative. That was a false dichotomy, and it left a deterministic bypass: 33 nested containers followed by an email would emit unscreened. Substituting a sentinel keeps the logger available (no throw) **and** refuses to emit unscreened content.

Note the contrast with the `audit_bound` payload walker, which fails closed by *rejecting the request*. Both fail closed; they differ in mechanism because the costs differ — rejecting an over-deep audit payload costs one API call, whereas refusing to log would cost the operational record during an incident. Both behaviours are pinned by test.

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
5. **Mixed-baseline tables (`accounts` and any table that persists both operators + participants) MUST be classified `scoped-delete`, NEVER `allowlist`.** Truncating `accounts` would erase operator + tenant-service accounts + admin identities — a baseline-loss defect. The scoping predicate MUST NOT rely on account type alone (per migrations 012/027/028 the `accounts.account_type` values include `patient`, `delegate`, `clinician`, `tenant_admin`, `platform_admin` — filtering to `account_type = 'patient'` misses `delegate` participants who are also Pilot-1 participants).

**Three-state cohort classification (canonical data model for Pilot 1 accounts):**

Every row in `accounts` MUST be in exactly one of three states:
- **`participant`** — a Pilot-1 participant (patient or delegate) whose data is purged by env-purge
- **`baseline`** — a legitimate baseline account (a `clinician`, `tenant_admin`, `platform_admin`, service account, OR a `patient`/`delegate` seeded for baseline test purposes — e.g., a synthetic patient identity used to seed a fixture that other participants reference). Preserved by env-purge.
- **`unclassified`** — a row that has neither classification. Any `unclassified` row is a data-model defect: either provisioning failed to assign a classification, or a manual database write bypassed the provisioning path.

**Sprint 1.3 migration:** adds a `cohort_classification` column to `accounts` (or equivalent enum field; Sprint 1.3 chooses storage form) with `NOT NULL` constraint + CHECK constraint accepting only the three states. Backfill on migration deploy: every pre-existing row gets an explicit classification (operator + admin rows → `baseline`; any pre-existing patient/delegate → operator-reviewed classification, not auto-assumed).

**Provisioning contract:** every account-creation code path MUST specify the classification atomically in the same INSERT. Attempting an INSERT without the classification column value fails at the NOT NULL constraint.

**Verifier contract:** `scripts/verify-pilot-1-baseline.sh` fails ONLY on `unclassified` rows — `count(*) FROM accounts WHERE cohort_classification = 'unclassified'`. Baseline patient/delegate rows are legitimate and do NOT trigger verifier failure. This closes the contradiction between "markerless patient = legitimate baseline" and "verifier rejects any markerless patient."

**Purge predicate:** `DELETE FROM accounts WHERE cohort_classification = 'participant'`. Never touches `baseline` or `unclassified`. (If `unclassified` exists, the verifier preflight has already refused the purge with an actionable message.)

**Remediation contract:** `scripts/pilot-1-marker-remediation.sh --account-id <id> --classify-as {participant|baseline} --reason "..."` — the ONLY authorized route for classifying an `unclassified` account. Each invocation is audit-logged as `pilot_1.cohort_classification{accountId, classifiedAs, actor, reason}`. Once classified, the account joins its class permanently. Reclassification requires a separate audit-logged decision.
6. Produces the CI test suite that verifies (a) schema-drift classification completeness, (b) canary purge behavior across all three classifications, (c) no FK edge crosses from preserved-scope evidence into truncated-scope data (or, if intentional, is documented + tested for correct scoped-DELETE handling), (d) mixed-baseline-table safeguard: known mixed-baseline tables (`accounts` at minimum) MUST be classified `scoped-delete`; CI test rejects any classification of `accounts` as `allowlist`.

Illustrative classification below reflects a first-pass reading of migrations 000–079. Sprint 1.3 PR revises it against actual FK graph and adds the operational plan (TRUNCATE vs scoped DELETE) per table.

**Illustrative classification (verified against migrations 000–079 as of 2026-08-30; Sprint 1.3 PR must re-verify against migrations at merge time):**

**Classification `scoped-delete` (mixed baseline + participant — DELETE WHERE preserves baseline):**
- `accounts` — DELETE WHERE `cohort_classification = 'participant'`. Preserves `baseline` rows (all clinician/admin/service + any patient/delegate seeded as baseline test fixture). `unclassified` rows are impossible at purge time because verifier preflight refuses purge when they exist. Sprint 1.3 adds the `cohort_classification` column via migration with NOT NULL + CHECK constraints + operator-reviewed backfill.

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
   - `patient` account with `cohort_classification='participant'` (expected **DELETED**)
   - `delegate` account with `cohort_classification='participant'` (expected **DELETED**)
   - `patient` account with `cohort_classification='baseline'` (legitimate baseline test fixture; expected **INTACT**)
   - `delegate` account with `cohort_classification='baseline'` (legitimate baseline test fixture; expected **INTACT**)
   - `clinician` account with `cohort_classification='baseline'` (expected **INTACT**)
   - `tenant_admin` account with `cohort_classification='baseline'` (expected **INTACT**)
   - `platform_admin` account with `cohort_classification='baseline'` (expected **INTACT**)
   - Service account with `cohort_classification='baseline'` (expected **INTACT**)
   - Additionally, a test-only synthesized `patient` row with `cohort_classification='unclassified'` (via raw INSERT bypassing provisioning helper) — expected: **purge REFUSES with actionable message naming this account ID**; expected after remediation reclassifies it: **participant → DELETED or baseline → INTACT depending on remediation choice**

   Run env-purge (both modes: routine-reset from clean; incident-mode with manifest); verify (a) every `allowlist`-canary is GONE, (b) every `preserved`-canary is INTACT, (c) every `scoped-delete`-canary matches expectation per above enumeration, (d) `audit_records` contains the `env.purge.executed` event with matching incidentId (incident-mode only), (e) no orphaned FK rows across the entire schema post-purge, (f) no baseline account of ANY type deleted under any code path.

5. **Cohort-classification integrity test:** every account-creation path in Pilot-1 baseline-seed + participant-provisioning flows MUST atomically write `cohort_classification` as part of the same INSERT. CI test enumerates every code path that inserts into `accounts` under Pilot-1 seed/provisioning; asserts each writes the classification in the same statement. Additionally, CI test attempts a raw INSERT omitting the classification column — the NOT NULL schema constraint MUST reject it. FAIL if either path allows an `unclassified` account to be created.

6. **Day-0 + runtime classification-integrity gate:** the Pilot-1 startup authorization checklist (see `PATH_A_PILOT_COMPLETION_RUNBOOK.md` §Pilot 1 startup authorization checklist) has a required check: at Day-0 dry-run start, script `scripts/verify-pilot-1-baseline.sh` runs `SELECT COUNT(*), array_agg(id) FROM accounts WHERE cohort_classification = 'unclassified'` — count MUST be 0; any offending account IDs are surfaced. Same script runs as env-purge preflight (both modes) and as post-provisioning verifier — any nonzero count refuses purge / rolls back provisioning with actionable message pointing to `scripts/pilot-1-marker-remediation.sh`.
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
8. **PR 1.3 — Env-purge + incident-scripts package + marker-integrity** (`scripts/pilot-1-env-purge.sh` with the two mutually-exclusive modes + `migrations/pilot-1-baseline-seed.sql` + `scripts/incident-capture.sh` + `scripts/incident-clear.sh` + `scripts/incident-log-gc.sh` + `scripts/pilot-1-close-wipe.sh` + `scripts/pii-scrub.mjs` + `scripts/verify-pilot-1-baseline.sh` — the cohort-marker integrity checker). Env-purge NEVER touches `/home/deploy/incident-logs/`; single-writer discipline enforced; CI test asserts.

**Cohort-classification integrity — fail-closed at every enforcement surface (containment, not just detection):**

Refers to the canonical **three-state cohort classification** (participant / baseline / unclassified) defined at §Purge table classification policy step 5 §Three-state cohort classification. This section specifies the enforcement mechanics for Sprint 1.3.

- **Provisioning (atomicity, not post-hoc):** account creation and `cohort_classification` assignment MUST be in the SAME `INSERT INTO accounts (...) VALUES (...)` statement. There is no post-hoc classification-write pattern. Sprint 1.3 PR uses PostgreSQL `INSERT ... RETURNING` semantics + a schema `NOT NULL` constraint on the `cohort_classification` column + `CHECK cohort_classification IN ('participant', 'baseline', 'unclassified')` so an INSERT that omits the column or supplies an invalid value fails at the database.

- **Provisioning integrity CI test:** attempt to insert an `accounts` row without `cohort_classification` via a synthesized SQL statement bypassing the provisioning helper — the schema NOT NULL constraint MUST reject it. Attempt an INSERT with an invalid classification value — the CHECK constraint MUST reject it.

- **Provisioning post-verification (backstop, not the only line of defense):** the provisioning helper MAY additionally run `verify-pilot-1-baseline.sh` as a same-transaction post-check within the provisioning code path. If the verifier detects any `unclassified` row, the provisioning transaction rolls back — the account does NOT exist post-provisioning. Compounds the schema constraint above.

- **Purge preflight (containment surface):** env-purge (both modes) runs `verify-pilot-1-baseline.sh` before any mutation. If any `unclassified` row is detected, purge REFUSES with an actionable message that names the offending account IDs + points to the remediation path (`scripts/pilot-1-marker-remediation.sh --account-id <id> --classify-as {participant|baseline} --reason "..."`). Note: purge does NOT reject baseline patient/delegate rows — those are legitimate and preserved.

- **Remediation path (safe recovery):** `scripts/pilot-1-marker-remediation.sh` is the ONLY authorized route for classifying an `unclassified` account. Each invocation is logged as an audit event (`pilot_1.cohort_classification{accountId, classifiedAs, actor, reason}`). This ensures an incident purge is never blocked forever — the operator can always classify + proceed — while requiring an explicit audited decision for any drift.

**CI test additions covering fail-closed behavior (three-state):**
- Classification-omitted raw INSERT: schema NOT NULL constraint rejects with error; no row inserted; provisioning helper's atomic-insert design is verified.
- Invalid-classification raw INSERT: schema CHECK constraint rejects with error.
- Provisioning-then-verifier-fail simulation: inject a verifier failure post-INSERT within the transaction; verify rollback; verify no account created; verify audit event of provisioning-failure.
- Purge-with-unclassified-account: seed an `unclassified` account (via test-only DDL relaxation bypassing constraints in a controlled fixture); run purge; verify purge REFUSES with actionable message naming the account ID.
- Remediation script `--classify-as participant`: run; verify `pilot_1.cohort_classification` audit event with `classifiedAs: participant`; verify purge now proceeds and account is DELETED.
- Remediation script `--classify-as baseline`: run against a different unclassified account; verify `pilot_1.cohort_classification` audit event with `classifiedAs: baseline`; verify purge now proceeds and account is INTACT.
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
