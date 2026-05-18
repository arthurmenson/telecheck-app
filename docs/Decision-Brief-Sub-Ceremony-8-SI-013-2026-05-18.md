# Sub-Ceremony 8 Decision Brief — SI-013 CCR crisis-helpline key ratification

**Date:** 2026-05-18
**Ratifier:** Evans (Telecheck workstream lead)
**Reviewer (adversarial):** Codex (per-PR adversarial review)
**Target Promotion Ledger entry:** P-025 (per post-SC7 cascade)
**Source spec doc:** `telecheck-app/docs/SI-013-CCR-Crisis-Helpline-Keys.md` (v0.X — extensively pre-Codex-converged across 7 internal rounds 2026-05-16; ratification-ready)
**Cluster:** Standalone (no batching)

---

## Why this needs ratification

The Mode 1 chat handler currently passes `escalationDestination: null` to `runCrisisGate` because the canonical CCR key namespace doesn't yet enumerate crisis-helpline keys. Two operational consequences:

1. **Crisis-resource sentinel response is country-generic.** Telecheck-Ghana chronic-care patients hitting a crisis branch get "call emergency services" without the country-specific helpline number (Ghana has its own emergency number 112/191 + mental-health helpline distinct from US's 988).
2. **Crisis-detection audit chain carries `escalation_destination: null`.** Ops alerts on null-destination crisis events fire excessively; forensic correlation between crisis events + which helpline was surfaced is impossible post-hoc.

SC8 ratifies the CCR key namespace expansion + the paired audit-event addition + the safety-floor invariants that constrain how the handler integrates them.

---

## Six ratifier sub-decisions

### Sub-decision 1 — Three new CCR keys in NEW `crisis` namespace

**Recommendation:** ✅ ACCEPT.

| Key | Type | Example values |
|---|---|---|
| `crisis.helpline_e164` | E.164 phone string (`^\+[1-9][0-9]{6,14}$`) | `'+18002738255'` (US), `'+233244841920'` (Ghana) |
| `crisis.helpline_label` | Display string | `'988 Suicide & Crisis Lifeline'`, `'Mental Health Helpline'` |
| `crisis.emergency_number` | Dialable string (NOT E.164) | `'911'` (US), `'112'` (Ghana), `'191'` (Ghana alt) |

`crisis.emergency_number` is **deliberately not E.164** per Codex R1 M1 closure 2026-05-16: short codes (911, 112) are not E.164 and naming a `*_e164` key for them is naming drift that downstream tel-link rendering / validation can mangle. Dialable-string = "value the patient device's dialer can place a call to verbatim".

`crisis` is a NEW CCR domain namespace; first use. Future crisis-related keys (e.g., `crisis.lgbtq_helpline_e164`) extend this domain.

### Sub-decision 2 — Three typed resolvers (NOT the generic `resolveCcrKey`)

**Recommendation:** ✅ ACCEPT.

Per Rule 3 / Codex R6 M1 closure 2026-05-16: country-profile defaults are NOT auto-mapped by the generic resolver. Each of the three crisis CCR keys needs a typed resolver walking `ccr_configs override → country_profile default → null`:

- `resolveCrisisHelpline(ctx)` → string | null (E.164)
- `resolveCrisisHelplineLabel(ctx)` → string | null
- `resolveCrisisEmergencyNumber(ctx)` → string | null (dialable)

Without the label typed resolver, an implementation can resolve number+emergency from country-profile defaults but silently miss the label default and degrade to the generic sentinel even when localization should have succeeded.

### Sub-decision 3 — NEW Cat B AUDIT_EVENTS action `crisis.escalation_destination_resolved`

**Recommendation:** ✅ ACCEPT.

Per Rule 4 / Codex R3 M1 closure 2026-05-16: forensic correlation requires the destination be captured in the audit chain. Since Rule 1 forces the crisis gate to run FIRST with null destination, the Category A `crisis_detection_trigger` audit ALWAYS carries `escalation_destination: null` and that field can never be retroactively populated (I-003 append-only).

Solution: a SECOND audit event emitted AFTER CCR resolution, linked to the original Category A via `linked_events[<audit_id>]`:

- **Action ID:** `crisis.escalation_destination_resolved`
- **Category:** B (governance/operational; not safety-floor)
- **Detail fields:**
  - `resolved_destination: string | null` — helpline E.164 if patient saw the localized sentinel; null in all three failure states
  - `resolution_status: 'resolved' | 'partial_defaults' | 'unmapped_country' | 'ccr_unavailable'` — 4-value enum (Codex R7 M1 closure added `partial_defaults`)
- **Patient-surface-agreement contract:** `resolved_destination` is non-null ONLY when `resolution_status === 'resolved'` (patient saw localized sentinel); null in `partial_defaults` / `unmapped_country` / `ccr_unavailable` because renderer fell back to generic.

### Sub-decision 4 — Safety-floor invariants (Rule 1 + Rule 2)

**Recommendation:** ✅ ACCEPT.

- **Rule 1:** crisis gate runs FIRST, unconditionally, with `escalationDestination: null`. CCR resolution happens AFTER gate fires Category A. Gate cannot be gated behind a CCR lookup (I-019 platform-floor). Per Codex R1 H1+H2 closures 2026-05-16.
- **Rule 2:** CCR resolution is fail-soft. Wrapped in try/catch; on any failure the resolver returns null and the sentinel falls back to the generic template. Logs at warn level for ops; does NOT propagate as 503.

### Sub-decision 5 — Rule 4 fail-soft policy (divergent from FLOOR-020)

**Recommendation:** ✅ ACCEPT.

Per Codex R5 H1 closure 2026-05-16: Category B emission of `crisis.escalation_destination_resolved` is **FAIL-SOFT**, divergent from FLOOR-020 / Mode 1 Category C's 503-on-failure policy. If the audit write throws:

- Handler logs at ERROR level for ops triage
- Handler STILL returns 200 with the crisis sentinel response
- Patient receives the safety surface

Rationale: a patient in crisis MUST receive the sentinel; losing forensic-correlation coverage on transient audit-DB outage is recoverable post-hoc via Category A's durable timestamp + actor + tenant + crisis_session_id. The Category A audit remains on the synchronous safety-floor commit path (cannot be skipped, cannot be deferred); Category B rides a softer SLA.

### Sub-decision 6 — 11 mandatory regression tests at downstream implementation

**Recommendation:** ✅ ACCEPT.

The downstream code change (mounting the typed resolvers + Cat B emitter on the Mode 1 chat handler crisis branch) MUST land with 11 regression cases per Codex R3 M1 + R5 H1 + R7 M1 closures:

1-5. Standard CCR-key resolution paths (override / default / null)
6-9. Rule 4 Cat B emission paths (resolved / partial_defaults / unmapped_country / ccr_unavailable)
8a. Partial-defaults sub-case (Codex R7 M1): helpline E.164 present + label OR emergency_number missing → renderer falls back to generic; Cat B emits `partial_defaults` with `resolved_destination: null`
10. Cat B fail-soft (Codex R5 H1): audit emitter throws → response 200 with sentinel, Cat A still committed, ERROR log emitted, NO Cat B row present — P0 regression if this fails closed
11. Patient-surface-agreement contract: `resolved_destination` always agrees with what patient saw

---

## What lands at PR-A1⁗‴ (this sub-ceremony's ratification-intent commit)

**Promotion Ledger:**
- **NEW P-025** — SI-013 ratification-intent (CCR_RUNTIME 3 new keys + 3 typed resolvers + 1 new Cat B AUDIT_EVENTS action + Rule 1/2/4 safety-floor invariants + 11 regression-test obligations)
- **Interpretation-rule extension:** from 7 SCs / 10 entries to 8 SCs / 11 entries; SC8 contributes:
  - **CCR_RUNTIME +1 minor** (3 new keys in NEW `crisis` namespace)
  - **AUDIT_EVENTS +1 minor** (1 new Cat B action `crisis.escalation_destination_resolved`)
  - Registry +1 minor lockstep bump
  - No CDM expansion (3 typed resolvers are service-layer code, not entity rows)
  - No DOMAIN_EVENTS (Cat B audit is governance evidence, not domain event)

**Registry:** v2.11 (UNCHANGED per lockstep invariant; bumps land at PR-A2⁗‴/A3⁗‴ canonical-content-port commit). Top-of-Ledger interpretation rule extended to 8 SCs / 11 entries with SC8 framing (NOT CDM-exempt but IS DOMAIN_EVENTS-exempt; AUDIT_EVENTS max-bumps cap extends from 6 to 7).

### P-NUM cascade post-SC8

| SI | P-NUM | Status |
|---|:---:|---|
| ...(prior entries unchanged)... | | |
| **SI-013 (SC8)** | **P-025** | 🕐 **this brief's target** |
| SI-014 (SC9) | P-026 | 🕐 parked until ADR-030 |
| SI-009.1 successor (Codex pre-rat APPROVED) | P-020 | 🕐 ready for ratification at any SC |
| SI-015 / SI-016 / SI-011.1a-d (Codex pre-rat APPROVED) | TBD | 🕐 ready for ratification at any SC |

---

## Ratification

To accept all 6 sub-decisions as recommended: reply **"ratify"**.

The 7 internal Codex pre-ratification rounds (R1-R7) already converged the substantive design; this SC8 ratification commits the design at the Promotion Ledger level.

---

— Claude (Opus 4.7, 1M context), 2026-05-18 Sub-Ceremony 8 Decision Brief delivery
