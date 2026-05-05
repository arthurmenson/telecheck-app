# Crisis-Detection (I-019) Coverage Audit

**Living artifact** — amend in place when re-run; bump revision-line below.

**Revision history:**
- **r1 (2026-05-05, Sprint 4 / TLC-012-rescoped):** initial audit — clean bill of health; lockdown regression test authored. Originally filed as `CRISIS_DETECTION_COVERAGE_AUDIT_2026-05-05.md`.
- **r1.1 (2026-05-05, Sprint 5 kickoff):** renamed to non-dated form per Sprint 5 PM convention decision; lockdown test reference updated to match new path. No content changes.

**Author:** Scrum Master (Claude Code main turn)
**PM verification grep:** `grep -rn "crisisDetector\." src/`
**Result (current):** Clean bill of health for current modules; lockdown regression test authored.

---

## I-019 rule citation

> **I-019 (Contracts Pack v5.2 INVARIANTS):** Crisis detection is platform-floor. The `crisisDetector` MUST run on every free-text patient-input field BEFORE persistence. Active in chat, voice (future), community, forms. Never disable, never gate behind config.

Per CLAUDE.md hard rule:

> **Crisis detection is platform-floor.** Never disable, never gate behind config. Active in chat, voice (future), community. **I-019**.

---

## Per-module audit table

| Module / file path | Function context | Free-text patient input? | Invokes `crisisDetector`? | Scope rationale |
| --- | --- | --- | --- | --- |
| `src/lib/crisis-detection.ts:251` | `crisisDetector` singleton declaration | (declaration) | (declaration) | Platform-singleton; not a callsite |
| `src/modules/forms-intake/internal/services/submission-service.ts:289` | `scanResponsesForCrisis` walker (called from `processSubmission` :389 + `pauseSubmission` :533) | **Y** (form response strings) | **Y** | Codex submissions-r1 CRITICAL-1 closure 2026-05-03 |
| `src/modules/identity/internal/services/account-service.ts` | `createAccount` / `activateAccount` | N (structured demographics: phone, names, DOB, gender) | N | No free-text — out of I-019 scope |
| `src/modules/identity/internal/services/session-service.ts` | session lifecycle | N (no patient text) | N | Out of I-019 scope |
| `src/modules/identity/internal/services/otp-service.ts` | OTP issue / verify | N (numeric codes) | N | Out of I-019 scope |
| `src/modules/identity/internal/services/auth-device-service.ts` | device registration | N (device metadata only) | N | Out of I-019 scope |
| `src/modules/identity/internal/handlers/registration.ts` | registration HTTP surface | N (structured demographics) | N | Out of I-019 scope |
| `src/modules/consent/internal/services/consent-service.ts` | consent grant / revoke | N (structured consent acknowledgment) | N | Out of I-019 scope |
| `src/modules/consent/internal/services/delegation-service.ts` | delegation invite / accept / revoke | N (structured invite token + role) | N | Out of I-019 scope |
| `src/modules/tenant-config/internal/handlers/admin.ts` | admin read handlers | N (operator surface; no patient input) | N | Out of I-019 scope |
| `src/modules/tenant-config/internal/handlers/admin-write.ts` | admin write 503 stubs (TLC-009) | N (operator-side; 503-only) | N | Out of I-019 scope (operator surface) |
| `src/modules/pharmacy/` | TLC-001 skeleton | N (no handlers) | N | Skeleton — no free-text surface yet |
| `src/modules/med-interaction/` | TLC-007 skeleton | N (no handlers) | N | Skeleton — no free-text surface yet |
| `src/modules/subscription/` | TLC-010 skeleton | N (no handlers) | N | Skeleton — no free-text surface yet |
| chat module | not yet authored | N/A | N/A | Sprint 7+ — must invoke crisisDetector when authored |
| community module | not yet authored | N/A | N/A | Future scope — must invoke crisisDetector when authored |

---

## Finding

**Clean bill of health.** The only free-text patient-input surface in the current codebase is forms-intake submission responses, and that surface DOES invoke `crisisDetector.detect` via the iterative `scanResponsesForCrisis` walker (closed by Codex submissions-r1 CRITICAL-1 on 2026-05-03 — `submission-service.ts:289`).

All other modules touch only structured patient input (demographics, OTP codes, structured consent acknowledgments) or operator-side surfaces (admin handlers). These are out of I-019 scope by spec design — I-019 covers free-text patient input where suicidality / crisis language could plausibly appear.

---

## Gating principle (forward)

**Any future module that accepts free-text patient input MUST scan with `crisisDetector` BEFORE persistence.** This is platform-floor per I-019 + CLAUDE.md. The pattern to follow is `submission-service.scanResponsesForCrisis` at `src/modules/forms-intake/internal/services/submission-service.ts:268-310`:

```typescript
// Iterative walker; throws CRISIS_DETECTED sentinel on first hit
const outcome = crisisDetector.detect(value, tenantId, '<source-context>');
if (outcome.crisisDetected) {
  // Emit Category A crisis_detection_trigger audit in OWN transaction
  // (durable even if the write doesn't proceed — bare suppression
  // forbidden per I-003)
  // Throw sentinel; handler maps to crisis-resource HTTP response
}
```

Modules that will need this pattern when authored:
- **Chat module** (Sprint 7+) — every patient message scans before persistence
- **Community module** (future) — every post + comment scans before persistence
- **Voice module** (future) — every transcribed utterance scans before persistence
- **Async consult patient narrative** — already covered if authored as a forms-intake submission; if authored as a separate module, must invoke `crisisDetector` independently
- **Adverse event patient narrative** (Sprint 10) — same rule

---

## Lockdown regression test

`tests/integration/crisis-detection-coverage-lockdown.test.ts` asserts:

1. `submission-service.processSubmission` invokes `crisisDetector.detect` for free-text response fields (the only known I-019 invocation today)
2. The test fails if a future refactor removes the call (regression lockdown)

The lockdown is intentionally narrow — it asserts call presence, not specific argument shapes. This avoids over-fitting: legitimate refactors (e.g., changing the source-context label from `'form_response'` to a more specific value) shouldn't break the test, but removing the call entirely should.

---

## Sprint reference

- TLC-012 originally proposed as a research story to surface coverage gaps
- PM grep at Sprint 4 kickoff revealed clean bill of health — no genuine gap exists in current modules
- Story rescoped to documentation (this audit) + lockdown regression test (no new production paths)
- Sprint 4 retro will record the descope/rescope path as a successful application of the "verify before authoring" PM rubric sub-rule (Sprint 1 retro lesson formalized in Sprint 3)

---

## Spec references

- `Telecheck_Contracts_Pack_v5_00_INVARIANTS.md` I-019
- CLAUDE.md (project root + telecheck-app) "Crisis detection is platform-floor" hard rule
- Master PRD v1.10 §11 (crisis detection in patient-facing surfaces)
- `src/lib/crisis-detection.ts` (the singleton implementation)
- Codex submissions-r1 CRITICAL-1 closure 2026-05-03 (the closure that wired `crisisDetector` into forms-intake submissions)
