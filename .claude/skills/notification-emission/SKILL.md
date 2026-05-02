---
name: notification-emission
description: Fire patient/clinician/operator notifications through the channel hierarchy with tenant variant resolution, privacy redaction per Notification Spec v1.1, language preference per CCR, and audit emission via notification.delivered. Use whenever code triggers an outbound notification (SMS, email, in-app, push).
when_to_invoke: Implementing or modifying any code path that delivers a notification — appointment reminders, prescription-ready, refill-due, crisis-detection acknowledgement, research-consent-grant confirmation, etc.
tools_used: Read, Edit, Write, Grep
---

## When to use this skill

Any code that:
- sends an SMS, email, push notification, or in-app notification
- queues a notification for delivery
- composes a notification body that contains tenant brand strings or patient PII

If you're rendering an in-product banner that does not leave the request, you don't need this skill — it's for outbound channels only.

## Read first

Set `${SPEC}` = `${TELECHECK_SPEC_PATH:-../telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE}`.

1. `${SPEC}/Telecheck_Notifications_Slice_PRD_v*.md` — Notification Spec v1.1 (channel hierarchy, redaction rules, fallback)
2. `${SPEC}/Telecheck_Contracts_Pack_v5_00_CCR_RUNTIME.md` (v5.2) — for `country_of_care`-driven SMS provider, language preference, retry policy
3. `${SPEC}/Telecheck_Contracts_Pack_v5_00_INVARIANTS.md` — I-008 (consent for cross-jurisdiction), I-019 (crisis detection cannot be configured away), I-027 (audit envelope tenant_id)
4. `${SPEC}/Telecheck_Contracts_Pack_v5_00_AUDIT_EVENTS.md` (v5.2) — for `notification.delivered` action
5. `${SPEC}/Telecheck_Master_Platform_PRD_v1_10.md` §17 — brand-structure rules; consumer DBA in patient-facing copy
6. Patient mock v7 in `telecheck-design-system/project/Patient interactive mock v7.html` if the notification has an in-app surface

## Workflow

1. **Identify the notification template.** Notification Spec v1.1 lists templates by event. If your template doesn't exist, escalate via §12; do NOT inline a one-off.
2. **Resolve tenant variant.** Each template has a per-tenant variant resolved via `tenant.consumer_dba` (e.g., "Heros Health" for Telecheck-US, "Heros Health Ghana" for Telecheck-Ghana). **Never render `tenant.id` to a patient.** Master PRD v1.10 §17 brand-structure rule.
3. **Resolve language.** From `patient.locale` (or fallback to `tenant.default_locale` from CCR). Tenant configuration sets the supported locale list.
4. **Resolve channel hierarchy.** Per Notification Spec v1.1: try preferred channel first; fall back per the hierarchy until success or hierarchy exhausted. SMS provider chosen by CCR (`tenant.country_of_care` → AWS SNS for US, Hubtel/Arkesel for Ghana per ADR-024).
5. **Apply redaction.** Per Notification Spec v1.1 redaction rules:
   - SMS: minimal — never include lab values, diagnoses, full medication name strings; reference appointment / refill IDs only by short opaque code. Never include `tenant.id`, never include other-tenant patient names.
   - Email: more permissive but still no PHI in subject lines.
   - Push: same as SMS.
   - In-app: full clinical content allowed (already inside the authenticated app).
6. **Crisis detection (I-019).** Crisis detection runs upstream of notifications and may trigger an emergency-channel notification with elevated priority. Crisis-channel emission cannot be disabled by tenant config.
7. **Idempotency.** Use a tenant-scoped idempotency key (per IDEMPOTENCY v5.1) keyed on `(template_id, recipient_id, trigger_event_id)` to prevent duplicate sends on retry.
8. **Emit audit on delivery.** Canonical action ID: `notification.delivered`. Envelope per AUDIT_EVENTS v5.2: `tenant_id`, `actor_id` (the system actor), `resource_type: "notification"`, `resource_id`, `outcome` (`success` | `failed` | `suppressed`), `channel`, `template_id`. Emit on failure too — `outcome: "failed"` with `failure_reason`. Use the `audit-emission` skill.
9. **Test.** (a) happy path with template variant + redaction; (b) language fallback when patient locale not in tenant supported list; (c) channel hierarchy fallback on first-channel failure; (d) idempotency replay does not duplicate; (e) cross-tenant attempt rejected (recipient must be in same tenant as triggering event).

## Hard rules

- **Never render `tenant.id` to a patient.** Use `tenant.consumer_dba`. Master PRD v1.10 §17.
- **I-008:** patient data does not cross jurisdiction without explicit consent. A notification destined for a recipient in a different jurisdiction than the originating event triggers consent check before send.
- **I-019:** crisis detection cannot be configured away. Crisis notifications fire regardless of tenant notification preferences.
- **I-027:** every `notification.delivered` audit envelope carries `tenant_id`.
- **Redaction rules per channel** are non-negotiable. SMS never carries diagnoses or full medication names.
- **CCR-driven config.** SMS provider, retry policy, supported locales come from `country_of_care` resolution. No hardcoded country branches.
- **Glossary:** `tenant`, `medication_request`, canonical entity names. Never `customer`, never `prescription`.

## Common mistakes

- **Hardcoding "Heros Health" in templates.** Variants are resolved via `tenant.consumer_dba`. A new tenant onboards by adding a row, not by editing template strings.
- **Putting PHI in SMS body.** Redaction violation. Even "Reminder: take your Ozempic at 8am" leaks PHI on a shared device or carrier log.
- **Skipping audit when delivery fails.** I-003 bare-suppression rule applies. Failures emit `outcome: "failed"` with `failure_reason`.
- **Tenant-blind idempotency keys.** Same key in two tenants would collide. Always tenant-scope per IDEMPOTENCY v5.1.
- **Hardcoding SMS provider.** AWS SNS for US, Hubtel/Arkesel for Ghana. CCR resolves; code does not branch on country directly.
- **Bypassing crisis-detection upstream gate** to "save latency." I-019 violation.

## Reporting

- **Templates wired:** list with template ID + tenant-variant strategy
- **Channels enabled:** with CCR-resolved provider per channel
- **Redaction applied:** per channel — confirm SMS/push redacted, email subject redacted
- **Audit action:** `notification.delivered` envelope fields populated, including failure path
- **Spec citations:** Notification Spec v1.1 §X; CCR_RUNTIME v5.2 keys consumed; INVARIANTS §I-XXX
- **Tests:** happy + locale fallback + channel fallback + idempotency + cross-tenant
