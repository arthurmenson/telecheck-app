# SI-013 — CCR crisis-helpline key ratification

**Raised by:** Engineering (autonomous run 2026-05-16; PR #160 Mode 1 chat handler TODO + Addendum 25 next-entry-point)
**Date:** 2026-05-16
**Severity:** MEDIUM at pilot launch — the Mode 1 chat handler currently passes `escalationDestination: null` to `runCrisisGate` because the canonical CCR key for crisis helplines hasn't been ratified. Crisis-detection audit rows therefore carry a null escalation field; the crisis-resource sentinel response text is a generic "your care team has been alerted" without a country-localized helpline number. Neither posture is acceptable beyond the v1.0 fail-soft pilot (Telecheck-Ghana chronic care will surface crisis content; patients need a real helpline number).
**Status:** Open — awaiting spec-corpus ratifier (Evans + Engineering Lead + Contracts Pack v5.2 CCR_RUNTIME owner) to expand the canonical CCR key namespace
**Target spec docs:** `Telecheck_Contracts_Pack_v5_00_CCR_RUNTIME.md` (canonical key namespace expansion), `Telecheck_AI_Clinical_Assistant_Slice_PRD_v1_0.md` §6.2 (crisis-resource response surface), `Telecheck_Master_Platform_PRD_v1_10.md` §17 (CCR-driven country-of-care config)
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
try {
  // Rule 3: typed resolvers, not the generic resolveCcrKey.
  helplineE164 = await resolveCrisisHelpline(ctx);
  helplineLabel = await resolveCrisisHelplineLabel(ctx);
  emergencyNumber = await resolveCrisisEmergencyNumber(ctx);
} catch (err) {
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

// Update the Category A audit's escalation_destination AFTER the fact
// via a follow-up Category B `crisis.escalation_destination_resolved`
// event? OR: rework runCrisisGate to accept a deferred-resolution
// callback. Either path is an additional design decision the ratifier
// settles. At v1.0 the audit's escalation_destination remains null
// (current behavior); post-SI-013, the field becomes populatable.
```

The `renderCrisisSentinel` helper interpolates the resolved values into a template; the template itself remains a module constant (reviewable in one place). When any value is null (CCR fail-soft path, or country-profile lookup miss for an unmapped country), the template gracefully omits the country-specific line and surfaces only the generic "your care team has been alerted" text — same as today's pre-SI-013 behavior.

### Regression test obligations (downstream impl)

When the code change lands, the test suite MUST cover:

1. Happy path: US tenant + crisis input → sentinel contains `'988'` (or whatever US helpline ratifies)
2. Happy path: GH tenant + crisis input → sentinel contains the Ghana helpline label
3. Fail-soft: crisis input + CCR resolver throws → 200 generic sentinel (NOT 503) + Category A audit STILL emits
4. Country-profile default path: tenant with NO ccr_configs override → typed resolver walks to country_profile + returns the default
5. Unmapped country: tenant whose country_of_care has no defaults → sentinel falls back to generic template, no crash

## What this SI does NOT propose

- **The exact helpline numbers per country.** That's a clinical-operations + compliance decision (Ghana mental-health policy, US 988 deployment scope, etc.). The SI proposes the KEY shape; the operational team populates VALUES at ratification.
- **A new entity in CDM v1.2.** CCR keys live in the existing `ccr_configs` + `country_profiles` tables. No CDM expansion needed.
- **Per-program overrides.** If a future Ghana program (e.g., a chronic-care cohort) needs a different helpline than the country default, the existing `ccr_configs` per-tenant override path covers it — no SI work needed.
- **An audit-event amendment.** The `crisis_detection_trigger` Category A audit ALREADY carries `escalation_destination` per AUDIT_EVENTS v5.3 (currently null because we don't pass a value). Populating it once the CCR keys ratify is a code change, not a spec change.

## Resolution path

When SI-013 closes:

1. CCR_RUNTIME contract v5.3 (or v5.2 patch) lands with the three keys ratified above + country-profile defaults populated for US + GH.
2. Engineering authors (downstream impl checklist — MUST preserve Rules 1+2+3 from "Surface integration" above; Codex R2 H1 closure 2026-05-16):
   - `src/modules/tenant-config/internal/ccr-keys.ts` — extend `CCR_KEYS` constant with the three new entries (purely additive; existing surface unchanged)
   - `src/modules/tenant-config/internal/services/ccr-resolver.ts` — add three typed resolvers (`resolveCrisisHelpline`, `resolveCrisisHelplineLabel`, `resolveCrisisEmergencyNumber`) walking `ccr_configs` override → `country_profiles` default → null. Do NOT use generic `resolveCcrKey` for these values — it only reads `ccr_configs` and skips country-profile defaults (per its own docstring).
   - `src/modules/ai-service/internal/handlers/chat.ts` — KEEP `runCrisisGate(... escalationDestination: null ...)` exactly as today. Rule 1: gate runs first, unconditional. Do NOT add a CCR call inside or before the gate.
   - `src/modules/ai-service/internal/handlers/chat.ts` — in the crisis-detected branch (after gate returns `kind: 'crisis'`), invoke the typed crisis resolvers INSIDE a try/catch (Rule 2 fail-soft). On any throw: log warn, set all three values to null, continue to render the generic sentinel.
   - `src/modules/ai-service/internal/handlers/chat.ts` — replace the hardcoded `CRISIS_RESPONSE_TEXT` module constant with `renderCrisisSentinel({ helplineE164, helplineLabel, emergencyNumber })`. The renderer template gracefully omits the country-specific line when any value is null.
   - Integration tests per the 5-case obligation list in "Regression test obligations" above.
3. Code change is bounded (≤150 LOC including the typed resolvers + renderer + 5 tests; single PR; Codex-reviewable in 2-3 rounds).

## Cross-cutting impact

This SI's resolution improves but does not block pilot launch — at v1.0 the crisis sentinel surfaces correct safety messaging even without a country-specific helpline number (patient is referred to "your care team" + "emergency services"). The audit's null `escalation_destination` is a known ops-alert noise source but not a safety-floor violation.

After ratification, the Telecheck-Ghana pilot launches with country-correct crisis resources, which materially improves the safety surface and removes the ops-alert noise.

## Status

- **Filed:** 2026-05-16 (autonomous run; Addendum 25 next-entry-point identification)
- **Target Promotion Ledger entry:** P-022 (alongside the 8 other pending SIs in the next ratification ceremony — SI-003/004/005/008/009/010/011/012)
- **Blocks:** country-localized crisis-resource surface in Mode 1 chat
- **Blocked by:** ratifier availability for CCR_RUNTIME namespace expansion

— Claude (Opus 4.7, 1M context), 2026-05-16 autonomous run
