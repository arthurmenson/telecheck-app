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
| `crisis.helpline_e164` | E.164 phone string | Country-of-care-driven crisis helpline number. Resolved via `resolveCcrKey(ctx, 'crisis.helpline_e164')`. Example values: `'+18002738255'` (US — 988 SMS-compatible alternate), `'+233244841920'` (Ghana — example MindfreedomGhana). Country-profile defaults populated for both US + GH at first ratification. |
| `crisis.helpline_label` | Display string | Human-readable label for the helpline, surfaced in the crisis-sentinel response text. Examples: `'988 Suicide & Crisis Lifeline'` (US), `'Mental Health Helpline'` (GH). Country-profile defaults. |
| `crisis.emergency_number_e164` | E.164 phone string | Country's primary emergency-services number. Examples: `'911'` (US — non-E.164 but conventional), `'112'` (GH or 191). Surfaced in the sentinel as "call emergency services" → "call 112". Country-profile defaults. |

### Surface integration (downstream impl)

When the CCR keys ratify, the Mode 1 chat handler's crisis-bypass branch resolves them at request time:

```typescript
// Mode 1 chat handler — crisis-bypass branch (post-SI-013)
const helplineE164 = await resolveCcrKey(ctx, CCR_KEYS.CRISIS_HELPLINE_E164);
const helplineLabel = await resolveCcrKey(ctx, CCR_KEYS.CRISIS_HELPLINE_LABEL);
const emergencyNumber = await resolveCcrKey(ctx, CCR_KEYS.CRISIS_EMERGENCY_NUMBER_E164);

// Pass to crisis gate so the Category A audit captures the destination
const inputCrisisOutcome = await runCrisisGate(
  {
    // ... existing fields ...
    escalationDestination: helplineE164,  // was null
    idempotencyCtx,
  },
  rawMessageText,
  'ai_chat_input',
);

// Surface the country-localized sentinel
const crisisResponseText = renderCrisisSentinel({
  helplineE164,
  helplineLabel,
  emergencyNumber,
});
```

The `renderCrisisSentinel` helper interpolates the resolved values into a template. The template itself remains a module constant (reviewable in one place); only the helpline + emergency-number values vary by country.

## What this SI does NOT propose

- **The exact helpline numbers per country.** That's a clinical-operations + compliance decision (Ghana mental-health policy, US 988 deployment scope, etc.). The SI proposes the KEY shape; the operational team populates VALUES at ratification.
- **A new entity in CDM v1.2.** CCR keys live in the existing `ccr_configs` + `country_profiles` tables. No CDM expansion needed.
- **Per-program overrides.** If a future Ghana program (e.g., a chronic-care cohort) needs a different helpline than the country default, the existing `ccr_configs` per-tenant override path covers it — no SI work needed.
- **An audit-event amendment.** The `crisis_detection_trigger` Category A audit ALREADY carries `escalation_destination` per AUDIT_EVENTS v5.3 (currently null because we don't pass a value). Populating it once the CCR keys ratify is a code change, not a spec change.

## Resolution path

When SI-013 closes:

1. CCR_RUNTIME contract v5.3 (or v5.2 patch) lands with the three keys ratified above + country-profile defaults populated for US + GH.
2. Engineering authors:
   - `src/modules/tenant-config/internal/ccr-keys.ts` — extend `CCR_KEYS` constant with the three new entries
   - `src/modules/ai-service/internal/handlers/chat.ts` — replace `escalationDestination: null` with `resolveCcrKey(ctx, CCR_KEYS.CRISIS_HELPLINE_E164)`
   - `src/modules/ai-service/internal/handlers/chat.ts` — replace the hardcoded `CRISIS_RESPONSE_TEXT` constant with `renderCrisisSentinel({...})` interpolation
   - Integration test: assert the resolved helpline number appears in the crisis sentinel response for US + GH tenants respectively
3. Code change is bounded (≤100 LOC, single PR, Codex-reviewable in 2-3 rounds).

## Cross-cutting impact

This SI's resolution improves but does not block pilot launch — at v1.0 the crisis sentinel surfaces correct safety messaging even without a country-specific helpline number (patient is referred to "your care team" + "emergency services"). The audit's null `escalation_destination` is a known ops-alert noise source but not a safety-floor violation.

After ratification, the Telecheck-Ghana pilot launches with country-correct crisis resources, which materially improves the safety surface and removes the ops-alert noise.

## Status

- **Filed:** 2026-05-16 (autonomous run; Addendum 25 next-entry-point identification)
- **Target Promotion Ledger entry:** P-022 (alongside the 8 other pending SIs in the next ratification ceremony — SI-003/004/005/008/009/010/011/012)
- **Blocks:** country-localized crisis-resource surface in Mode 1 chat
- **Blocked by:** ratifier availability for CCR_RUNTIME namespace expansion

— Claude (Opus 4.7, 1M context), 2026-05-16 autonomous run
