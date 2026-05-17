# SI-013 — CCR crisis-helpline key ratification

**Raised by:** Engineering (autonomous run 2026-05-16; PR #160 Mode 1 chat handler TODO + Addendum 25 next-entry-point)
**Date:** 2026-05-16
**Severity:** MEDIUM at pilot launch — the Mode 1 chat handler currently passes `escalationDestination: null` to `runCrisisGate` because the canonical CCR key for crisis helplines hasn't been ratified. Crisis-detection audit rows therefore carry a null escalation field; the crisis-resource sentinel response text is a generic "your care team has been alerted" without a country-localized helpline number. Neither posture is acceptable beyond the v1.0 fail-soft pilot (Telecheck-Ghana chronic care will surface crisis content; patients need a real helpline number).
**Status:** Open — awaiting spec-corpus ratifier (Evans + Engineering Lead + Contracts Pack v5.2 CCR_RUNTIME owner) to expand the canonical CCR key namespace
**Target spec docs:** `Telecheck_Contracts_Pack_v5_00_CCR_RUNTIME.md` (canonical key namespace expansion), `Telecheck_Contracts_Pack_v5_00_AUDIT_EVENTS.md` (new Category B action `crisis.escalation_destination_resolved` per Rule 4 / Codex R3 M1 closure), `Telecheck_AI_Clinical_Assistant_Slice_PRD_v1_0.md` §6.2 (crisis-resource response surface), `Telecheck_Master_Platform_PRD_v1_10.md` §17 (CCR-driven country-of-care config)
**Target slice:** Mode 1 conversational assistant (handler in `src/modules/ai-service/internal/handlers/chat.ts`); future Mode 2 case-prep surface will consume the same keys
**Parallel SIs:** independent — does not block or depend on other open SIs

---

## What this is

The Mode 1 chat handler at `src/modules/ai-service/internal/handlers/chat.ts:312` hardcodes `escalationDestination: null` when invoking `runCrisisGate`. The inline comment documents the gap:

> Per-tenant escalation destination resolution lands with the CCR-driven helpline integration (Slice PRD §6.2 + CCR_RUNTIME contract). Null at v1.0 → ops alert via the crisis audit row.

The CCR resolver (`src/modules/tenant-config/internal/services/ccr-resolver.ts`) is production-ready. The canonical key constants are in `src/modules/tenant-config/internal/ccr-keys.ts`. The crisis-helpline key is NOT in the namespace today because the canonical CCR_RUNTIME contract doesn't enumerate it.

This SI scopes the namespace expansion as a formal deliverable so the spec-corpus ratifier can batch it with the other 8 pending SIs in the next ratification ceremony.

## Why this matters for pilot launch

Telecheck-Ghana chronic care is the first revenue-bearing pilot. Per the audit (2026-05-15), chronic care patients DO surface crisis content in conversational interfaces. The current behavior:

1. Patient sends crisis-text message
2. `runCrisisGate` correctly detects + emits Category A `crisis_detection_trigger` audit
3. Crisis-resource sentinel response text is returned:
   > "I noticed you may be going through something serious. Your safety is the priority. If you are in immediate danger, please call emergency services right away. Your care team has been alerted and a clinician will follow up."

The sentinel text is generic. A Ghana patient gets the same "emergency services" reference as a US patient — but the Ghana emergency number is different from 911, and the Ghana mental-health helpline (Ghana Mental Health Authority, MindfreedomGhana, etc.) is country-specific. Without CCR-driven resolution, the surface degrades to the lowest common denominator.

Also: the Category A audit's `escalation_destination` field is null. Ops alerts on null-destination crisis events fire excessively (every crisis is a "no destination" event) and the field has no value for post-hoc forensic correlation between crisis events and which helpline was surfaced.

## Proposed CCR key namespace expansion (FOR REVIEW — not authoritative)

Add to `src/modules/tenant-config/internal/ccr-keys.ts` `CCR_KEYS` constant, alphabetized within domain. The `crisis` domain is new — first use of this domain. Subsequent crisis-related CCR keys (e.g., `crisis.emergency_number_e164` for the country's emergency-services number, `crisis.lgbtq_helpline_e164` for population-specific options) extend this domain.

| Key | Type | Notes |
|---|---|---|
| `crisis.helpline_e164` | E.164 phone string | Country-of-care-driven crisis helpline number. Validated E.164 (`^\+[1-9][0-9]{6,14}$`) — short codes go in `crisis.emergency_number` below, NOT here. Example values: `'+18002738255'` (US — 988 SMS-compatible alternate), `'+233244841920'` (Ghana — example MindfreedomGhana). |
| `crisis.helpline_label` | Display string | Human-readable label for the helpline, surfaced in the crisis-sentinel response text. Examples: `'988 Suicide & Crisis Lifeline'` (US), `'Mental Health Helpline'` (GH). |
| `crisis.emergency_number` | Dialable string (NOT E.164) | Country's primary emergency-services number. Per Codex R1 M1 closure 2026-05-16: short codes (`'911'`, `'112'`, `'191'`) are NOT E.164 and naming a key `*_e164` for them is naming drift that downstream tel-link rendering / validation can mangle. The dialable-string contract is: a value the patient device's dialer can place a call to verbatim. Examples: `'911'` (US), `'112'` (GH), `'191'` (GH alternate). Surfaced in the sentinel as "call emergency services at 112". |

### Surface integration (downstream impl)

When the CCR keys ratify, the Mode 1 chat handler resolves them ONLY on the crisis-detected branch, AFTER `runCrisisGate` has fired. Two safety-floor rules constrain the resolution order (Codex R1 H1+H2 closures 2026-05-16):

**Rule 1 — crisis gate runs FIRST, unconditional.**
The gate is the I-019 platform-floor; it cannot be gated behind a CCR lookup. The handler passes `escalationDestination: null` to the gate (same as today), the gate emits the Category A `crisis_detection_trigger` audit if positive, and ONLY THEN does the handler resolve the CCR helpline values for the sentinel response. If CCR resolution fails (DB timeout, transient unavailability, version skew), the patient still gets a safety surface — the generic sentinel without country-specific numbers — because the gate has already done its work.

**Rule 2 — CCR resolution is fail-soft.** Wrapped in try/catch; on any failure, the resolver returns null and the sentinel falls back to the generic template. The handler logs the failure at warn level for ops triage but DOES NOT propagate it as a 503.

**Rule 3 — country-profile defaults require TYPED resolvers**, not the generic `resolveCcrKey`. The generic resolver only reads `ccr_configs` and returns null for tenants without overrides; country-profile defaults are not auto-mapped (per the resolver's own docstring — see `src/modules/tenant-config/internal/services/ccr-resolver.ts` "country-profile defaults are NOT auto-mapped here because the country_profiles columns are typed... Use the typed resolvers below..."). So this SI's downstream impl ALSO ratifies typed crisis resolvers — `resolveCrisisHelpline(ctx)`, `resolveCrisisEmergencyNumber(ctx)` — that walk ccr_configs override → country_profile default → null.

**Rule 4 — forensic correlation via paired Category B audit (Codex R3 M1 closure 2026-05-16).** The SI's stated benefit of removing null-destination ops-alert noise + enabling post-hoc forensic correlation requires that the destination be CAPTURED in the audit chain. Since Rule 1 forces the gate to run FIRST with null destination, the original Category A `crisis_detection_trigger` audit will always carry `escalation_destination: null` — that field never gets populated after the fact (I-003 audit append-only).

The forensic-correlation mechanism is therefore a SECOND audit event ratified by this SI:

- **Action ID:** `crisis.escalation_destination_resolved` (new; add to AUDIT_EVENTS Category B at ratification)
- **Category:** B (governance/operational follow-up; not safety-floor since the safety surface already fired via Category A)
- **Linked to:** the original Category A `crisis_detection_trigger` audit via `linked_events[]` carrying its `audit_id`
- **Detail fields:**
  - `resolved_destination: string | null` — the helpline E.164 if CCR resolved, null otherwise
  - `resolution_status: 'resolved' | 'ccr_unavailable' | 'unmapped_country'` — three-value enum for ops-alert filtering
- **Emission policy:** mandatory ATTEMPT alongside Category A regardless of CCR outcome. If CCR resolved successfully, status is `resolved`. If CCR threw, status is `ccr_unavailable` (this is the alert-worthy state). If CCR returned null because the tenant's country has no defaults configured, status is `unmapped_country` (also alert-worthy, but a different ops triage path — "add helpline defaults for country X" not "fix CCR connectivity").
- **Failure policy — FAIL-SOFT, divergent from FLOOR-020 (Codex R5 H1 closure 2026-05-16).** Emission of this Category B event MUST be wrapped in try/catch by the handler. If the audit write throws (audit DB outage, hash-chain commit failure, etc.) the handler logs at ERROR level for ops triage but STILL returns 200 with the crisis sentinel response to the patient. This is an intentional divergence from the FLOOR-020 operational-audit pattern used by Mode 1 Category C (`ai_chat_response_emitted`), which DOES return 503 on emission failure. The rationale: a patient in crisis MUST receive the sentinel response — losing forensic-correlation coverage on a transient audit-DB outage is a tolerable operational regression; suppressing the safety surface is not. The forensic loss is itself recoverable post-hoc via the Category A row's timestamp + actor + tenant + crisis_session_id, which all remain durably committed on the safety-floor path regardless of Category B's fate.

This fail-soft posture is the reason Rule 4 establishes a SEPARATE audit event rather than attempting to amend the Category A `crisis_detection_trigger` write to carry the destination directly. The Category A write must remain on the synchronous safety-floor commit path (cannot be skipped, cannot be deferred); the Category B write rides a softer SLA so we can guarantee Category A delivery without coupling crisis-response delivery to a second blocking audit dependency.

This decoupling also avoids reworking `runCrisisGate` to accept deferred-resolution callbacks (which would complicate the gate's already-careful dedupe logic) and keeps the safety-floor Category A audit semantically unchanged.

```typescript
// Mode 1 chat handler — crisis-bypass branch (post-SI-013)
// Rule 1: crisis gate FIRST with null escalation; gate is unconditional.
const inputCrisisOutcome = await runCrisisGate(
  {
    // ... existing fields ...
    escalationDestination: null,  // resolved AFTER gate per Rule 1
    idempotencyCtx,
  },
  rawMessageText,
  'ai_chat_input',
);

const crisisDetected = inputCrisisOutcome.kind === 'crisis';
if (!crisisDetected) {
  // ... existing no-crisis branch, no CCR resolution needed ...
}

// Rule 2: fail-soft CCR resolution. Generic-sentinel fallback on failure.
let helplineE164: string | null = null;
let helplineLabel: string | null = null;
let emergencyNumber: string | null = null;
// Rule 4 status-derivation: track whether the catch fired so we can
// distinguish 'ccr_unavailable' (resolver threw — connectivity alert)
// from 'unmapped_country' (resolver returned null for all values
// because the tenant's country has no defaults — config alert). A
// null-only heuristic without this flag would mis-classify legitimate
// unmapped-country lookups as CCR outages (Codex R4 M1 closure
// 2026-05-16).
let ccrThrew = false;
try {
  // Rule 3: typed resolvers, not the generic resolveCcrKey.
  helplineE164 = await resolveCrisisHelpline(ctx);
  helplineLabel = await resolveCrisisHelplineLabel(ctx);
  emergencyNumber = await resolveCrisisEmergencyNumber(ctx);
} catch (err) {
  ccrThrew = true;
  req.log.warn(
    { err, tenant_id: ctx.tenantId },
    'mode_1_chat: CCR crisis-resource resolution failed — falling back to generic sentinel',
  );
}

// Render sentinel; generic template used if any resolved value is null.
const crisisResponseText = renderCrisisSentinel({
  helplineE164,
  helplineLabel,
  emergencyNumber,
});

// Rule 4 (Codex R3 M1 closure 2026-05-16): forensic correlation
// REQUIRED. The original Category A crisis_detection_trigger
// audit's escalation_destination remains null (gate must run
// first per Rule 1, before we know the destination). A SECOND
// audit event ratified by this SI — Category B
// `crisis.escalation_destination_resolved` — emits AFTER the
// CCR resolution (success OR fail-soft fallback), carrying:
//   - linked_events: [<original Category A audit_id>]
//   - detail.resolved_destination: helplineE164 | null (null when
//     CCR failed or country has no defaults)
//   - detail.resolution_status: 'resolved' | 'ccr_unavailable' |
//     'unmapped_country'
// This is a mandatory ATTEMPT, not a mandatory commit — the SI's
// stated benefit of removing null-destination ops noise + enabling
// post-hoc forensic correlation depends on Category B always
// emitting alongside Category A WHEN POSSIBLE. Per Codex R5 H1
// closure 2026-05-16, the emission is FAIL-SOFT (divergent from
// FLOOR-020 / Category C policy): a Category B write failure logs at
// ERROR but DOES NOT 503, because the patient is in crisis and must
// receive the sentinel response regardless of audit-DB liveness.
// Forensic loss on a transient outage is recoverable post-hoc via
// Category A's durable timestamp + actor + tenant + crisis_session_id.
try {
  await emitCrisisEscalationDestinationResolved({
    linkedAuditId: inputCrisisOutcome.audit_id,
    resolvedDestination: helplineE164,
    // Status derivation MUST match the engineering checklist (Codex R4
    // M1 closure 2026-05-16): 'resolved' iff the primary helpline
    // E.164 resolved; else 'ccr_unavailable' iff the resolver threw
    // (the alert-worthy connectivity state); else 'unmapped_country'
    // (the alert-worthy config-gap state — tenant's country has no
    // defaults for these keys). A pure null-check heuristic without
    // `ccrThrew` would mis-classify legitimate unmapped-country
    // lookups as CCR outages and corrupt the ops-alert signal this SI
    // is adding.
    resolutionStatus: helplineE164 !== null
      ? 'resolved'
      : ccrThrew
        ? 'ccr_unavailable'
        : 'unmapped_country',
    // ... tenant + actor + countryOfCare attribution ...
  });
} catch (auditErr) {
  // Rule 4 fail-soft policy (Codex R5 H1 closure 2026-05-16):
  // DO NOT 503. The crisis sentinel response MUST reach the patient.
  // Ops triage handles the forensic-audit gap via Category A
  // recovery; suppressing the safety surface for an audit write is
  // not acceptable on the crisis branch.
  req.log.error(
    { err: auditErr, tenant_id: ctx.tenantId, linked_audit_id: inputCrisisOutcome.audit_id },
    'mode_1_chat: Category B crisis.escalation_destination_resolved emission failed — sentinel still returned to patient (fail-soft per Rule 4)',
  );
}
```

The `renderCrisisSentinel` helper interpolates the resolved values into a template; the template itself remains a module constant (reviewable in one place). When any value is null (CCR fail-soft path, or country-profile lookup miss for an unmapped country), the template gracefully omits the country-specific line and surfaces only the generic "your care team has been alerted" text — same as today's pre-SI-013 behavior.

### Regression test obligations (downstream impl)

When the code change lands, the test suite MUST cover (Codex R3 M1 closure 2026-05-16 expanded Rule 4 coverage in items 6–9; Codex R5 H1 closure 2026-05-16 added item 10 for the fail-soft Category B policy):

1. Happy path: US tenant + crisis input → sentinel contains `'988'` (or whatever US helpline ratifies)
2. Happy path: GH tenant + crisis input → sentinel contains the Ghana helpline label
3. Fail-soft: crisis input + CCR resolver throws → 200 generic sentinel (NOT 503) + Category A audit STILL emits
4. Country-profile default path: tenant with NO ccr_configs override → typed resolver walks to country_profile + returns the default
5. Unmapped country: tenant whose country_of_care has no defaults → sentinel falls back to generic template, no crash
6. **Rule 4 happy path:** crisis input + CCR resolves successfully → exactly ONE Category B `crisis.escalation_destination_resolved` audit emits with `detail.resolution_status === 'resolved'` AND `detail.resolved_destination === <expected E.164>` AND `linked_events` contains the original Category A `crisis_detection_trigger` audit_id
7. **Rule 4 ccr_unavailable:** crisis input + CCR resolver throws → Category B audit STILL emits with `detail.resolution_status === 'ccr_unavailable'` AND `detail.resolved_destination === null` AND `linked_events` correctly references the Category A audit_id (NOT swallowed by the try/catch — the Category B emission lives OUTSIDE the resolver try/catch)
8. **Rule 4 unmapped_country:** crisis input + tenant with no country defaults → Category B audit emits with `detail.resolution_status === 'unmapped_country'` AND `detail.resolved_destination === null` (this is the "ratifier needs to add helpline defaults for country X" alert path; semantically distinct from `ccr_unavailable` which is a connectivity alert)
9. **Rule 4 idempotency-retry invariant:** crisis input with retry under the same Idempotency-Key → across both attempts, exactly ONE Category A `crisis_detection_trigger` AND exactly ONE Category B `crisis.escalation_destination_resolved` (no duplicate emission on replay; same pattern as the FLOOR-020 + I-019 two-layer dedupe from PR #163)
10. **Rule 4 Category B fail-soft (Codex R5 H1 closure 2026-05-16):** crisis input + Category B audit emitter throws (audit-DB outage simulated via the PR #163 vi.mock injection harness pattern, extended for `emitCrisisEscalationDestinationResolved`) → response is **200** with the crisis sentinel (NOT 503), Category A audit STILL committed durably, ERROR-level log emitted with `linked_audit_id` for ops triage, and NO Category B row present in `audit_records`. This is the test that proves the SI's safety-surface guarantee survives audit-DB outage — and the test that pins the divergence from FLOOR-020/Category C's 503-on-failure policy. A regression here is a P0 because it means the crisis branch CAN fail closed.

## What this SI does NOT propose

- **The exact helpline numbers per country.** That's a clinical-operations + compliance decision (Ghana mental-health policy, US 988 deployment scope, etc.). The SI proposes the KEY shape; the operational team populates VALUES at ratification.
- **A new entity in CDM v1.2.** CCR keys live in the existing `ccr_configs` + `country_profiles` tables. No CDM expansion needed.
- **Per-program overrides.** If a future Ghana program (e.g., a chronic-care cohort) needs a different helpline than the country default, the existing `ccr_configs` per-tenant override path covers it — no SI work needed.
- **An amendment to the existing Category A `crisis_detection_trigger` audit shape.** That event ALREADY carries `escalation_destination` per AUDIT_EVENTS v5.2 (currently null because the handler passes null per Rule 1 — the gate must run first, before the destination is known). The Category A shape itself is unchanged. (Note: Rule 4 above DOES introduce a NEW Category B event — `crisis.escalation_destination_resolved` — which is a spec change to AUDIT_EVENTS; that is in-scope for this SI per Codex R3 M1 closure. This bullet only clarifies that Category A's pre-existing shape is preserved as-is.)

## Resolution path

When SI-013 closes:

1. CCR_RUNTIME contract v5.3 (or v5.2 patch) lands with the three keys ratified above + country-profile defaults populated for US + GH.
2. AUDIT_EVENTS contract v5.3 (or v5.2 patch) lands with the new Category B `crisis.escalation_destination_resolved` action ID + the three-value `resolution_status` enum on its detail schema (Codex R3 M1 closure 2026-05-16; Rule 4).
3. Engineering authors (downstream impl checklist — MUST preserve Rules 1+2+3+4 from "Surface integration" above; Codex R2 H1 + Codex R3 M1 closures 2026-05-16):
   - `src/modules/tenant-config/internal/ccr-keys.ts` — extend `CCR_KEYS` constant with the three new entries (purely additive; existing surface unchanged)
   - `src/modules/tenant-config/internal/services/ccr-resolver.ts` — add three typed resolvers (`resolveCrisisHelpline`, `resolveCrisisHelplineLabel`, `resolveCrisisEmergencyNumber`) walking `ccr_configs` override → `country_profiles` default → null. Do NOT use generic `resolveCcrKey` for these values — it only reads `ccr_configs` and skips country-profile defaults (per its own docstring).
   - `src/modules/ai-service/internal/audit.ts` — **NEW emitter `emitCrisisEscalationDestinationResolved(args, tx?)` (Rule 4 mandatory attempt; fail-soft callsite per Codex R5 H1 closure 2026-05-16).** Emits a Category B audit row with action `crisis.escalation_destination_resolved`, `linked_events: [<original Category A audit_id>]`, `detail: { resolved_destination: string | null, resolution_status: 'resolved' | 'ccr_unavailable' | 'unmapped_country' }`. Audit-envelope population (tenant_id, actor, ai_workload_type='conversational_assistant', autonomy_level='advisory') follows the same I-027 attribution rules as the existing Mode 1 Category C emitter. Implementation surface mirrors `emitMode1ChatResponseAudit` (so the PR #163 vi.mock injection harness can exercise its failure path), BUT the handler-level callsite wraps it in try/catch and downgrades failure to ERROR log + 200 sentinel (NOT 503). Do NOT introduce a `CrisisEscalationDestinationAuditEmissionFailedError → 503` mapping equivalent to the Mode 1 Category C `Mode1AuditEmissionFailedError` — that pattern is specific to Category C's safety budget and would break Rule 4's fail-soft policy on the crisis branch.
   - `src/modules/ai-service/internal/handlers/chat.ts` — KEEP `runCrisisGate(... escalationDestination: null ...)` exactly as today. Rule 1: gate runs first, unconditional. Do NOT add a CCR call inside or before the gate.
   - `src/modules/ai-service/internal/handlers/chat.ts` — in the crisis-detected branch (after gate returns `kind: 'crisis'`), invoke the typed crisis resolvers INSIDE a try/catch (Rule 2 fail-soft). On any throw: log warn, set all three values to null, continue to render the generic sentinel. Track whether the catch fired (boolean `ccrThrew`) to distinguish `ccr_unavailable` from `unmapped_country` in Rule 4 emission below.
   - `src/modules/ai-service/internal/handlers/chat.ts` — **MANDATORY ATTEMPT (Rule 4):** invoke `emitCrisisEscalationDestinationResolved` AFTER the resolver try/catch returns (success OR failure), passing `linkedAuditId: inputCrisisOutcome.audit_id`, `resolvedDestination: helplineE164`, and `resolutionStatus` derived from the three states: `'resolved'` if `helplineE164 !== null`; else `'ccr_unavailable'` if `ccrThrew === true`; else `'unmapped_country'`. The Category B invocation lives OUTSIDE the resolver try/catch so a CCR throw cannot suppress the forensic-correlation audit attempt. **FAIL-SOFT (Codex R5 H1 closure 2026-05-16; divergent from FLOOR-020 / Category C):** the Category B emission itself MUST be wrapped in its own try/catch. On audit-write failure, log at ERROR level for ops triage (include `linked_audit_id` so the gap can be reconciled against the durable Category A row post-hoc) and STILL return the 200 + crisis sentinel response. Do NOT translate Category B emitter failure into a 503 — the patient is in crisis and the safety surface must reach them regardless of audit-DB liveness. This is intentionally different from the Mode 1 Category C operational-audit policy, where emission failure DOES return 503 (no safety-surface penalty in that case because there's no in-flight crisis).
   - `src/modules/ai-service/internal/handlers/chat.ts` — replace the hardcoded `CRISIS_RESPONSE_TEXT` module constant with `renderCrisisSentinel({ helplineE164, helplineLabel, emergencyNumber })`. The renderer template gracefully omits the country-specific line when any value is null.
   - Integration tests per the 9-case obligation list in "Regression test obligations" above (items 6–9 cover Rule 4).
4. Code change is bounded (≤240 LOC including the typed resolvers + Category B emitter + renderer + 10 tests; single PR; Codex-reviewable in 2-3 rounds).

## Cross-cutting impact

This SI's resolution improves but does not block pilot launch — at v1.0 the crisis sentinel surfaces correct safety messaging even without a country-specific helpline number (patient is referred to "your care team" + "emergency services"). The audit's null `escalation_destination` is a known ops-alert noise source but not a safety-floor violation.

After ratification, the Telecheck-Ghana pilot launches with country-correct crisis resources, which materially improves the safety surface and removes the ops-alert noise.

## Status

- **Filed:** 2026-05-16 (autonomous run; Addendum 25 next-entry-point identification)
- **Target Promotion Ledger entry:** P-022 (alongside the 8 other pending SIs in the next ratification ceremony — SI-003/004/005/008/009/010/011/012)
- **Blocks:** country-localized crisis-resource surface in Mode 1 chat
- **Blocked by:** ratifier availability for CCR_RUNTIME namespace expansion

— Claude (Opus 4.7, 1M context), 2026-05-16 autonomous run
