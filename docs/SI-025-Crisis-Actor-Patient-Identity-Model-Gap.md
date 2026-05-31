# SI-025 — Crisis slice actor/patient identity-model gap (UUID vs canonical VARCHAR(26) `account_id`)

**Raised by:** Engineering (autonomous queue-drain run 2026-05-31; surfaced by Codex R1 adversarial review of crisis Sprint 2 PR 5 `GET /v0/crisis-events/:id/patient-summary` — the first handler to actually consume the patient self-scoping view `crisis_event_patient_summary_v`)
**Date:** 2026-05-31
**Severity:** **HIGH** — the crisis slice's actor-identity + patient self-scoping model is built on a `UUID` assumption that contradicts the platform-canonical patient/actor identity (`accounts.account_id VARCHAR(26)`). For a **real (non-test) token**, the `::UUID` casts raise `invalid_text_representation` and (a) the patient-summary endpoint can never return the patient's own row, and (b) the merged mid-lifecycle wrappers cannot bind a real actor. Masked in CI today only because every crisis test fixture uses a UUID-shaped `account_id`.
**Status:** **OPEN — v0.1 DRAFT (pre-ratifier; routes to Track 6 — Evans + Engineering Lead + CDM owner)**
**Target spec docs:** `Telecheck_Canonical_Data_Model_v1_2.md` (CDM — `crisis_event.patient_id` type + crisis lifecycle-transition `actor_principal_id` type); SI-022 Crisis Response Slice v1.0 + the CDM v1.9→v1.10 Amendment (P-040) that ratified the crisis entity shapes.
**Target migrations (consumers, all MERGED on `main`):** `033_crisis_response_entities.sql` (`crisis_event.patient_id UUID`, `crisis_event_lifecycle_transition.actor_principal_id UUID`), `034_crisis_response_derived_views.sql` (patient view self-scoping predicate), `036_crisis_response_initiation_wrapper.sql` + `037_crisis_response_mid_lifecycle_wrappers.sql` (`v_actor_principal_id := current_actor_account_id()::UUID`).
**Affected PRs:** crisis Sprint 2 PR 5 (#203, HELD), PR 6 sweep (#204, HELD); **and the already-merged** PR 2 initiate (#?), PR 3 acknowledge (#199), PR 4 respond/resolve (#202) — all share the `::UUID` actor cast.
**Promotion Ledger target:** TBD future P-NUM (ratifier-assigned).

---

## What this is

The platform's **canonical patient/actor identity is `accounts.account_id`, typed `VARCHAR(26)`** (a 26-char Crockford-ULID). Evidence across already-canonical surfaces:

- `accounts.account_id VARCHAR(26) PRIMARY KEY` (migration `012_accounts.sql`).
- `current_actor_account_id()` (SI-010 trust anchor, migration `031_session_actor_context.sql`) **RETURNS TEXT** — the VARCHAR(26) account id.
- `forms_submission.patient_id → accounts.account_id` composite FK (migration `012` doc-comment) — i.e., a patient's identity is their `account_id`.
- `medication_requests.patient_account_id VARCHAR(26)` with FK to `accounts(tenant_id, account_id)` (migration `025_medication_requests.sql`).

The **crisis slice diverges** from this canonical pattern:

- `crisis_event.patient_id` is **`UUID NOT NULL`** (migration `033` line 475) — not `VARCHAR(26)`, and migration `033` explicitly does **not** FK it to `accounts`.
- `crisis_event_lifecycle_transition.actor_principal_id` is **`UUID`**.
- The patient self-scoping view predicate (migration `034` §line 190-191) is:
  ```sql
  AND ce.patient_id = ( SELECT current_actor_account_id()::UUID )
  ```
- The SECURITY DEFINER wrappers (migrations `036`/`037`) bind the actor as:
  ```sql
  v_actor_principal_id := v_actor_account_id_text::UUID;   -- v_actor_account_id_text := current_actor_account_id()
  ```

A real ULID `account_id` (e.g., `01KSZNCKZMRZAGBFRW9SVJ5S80`, 26 chars) **is not a valid UUID** — `::UUID` raises `invalid_text_representation` (surfaced tenant-blind per I-025). And even setting the format aside, a `VARCHAR(26)` column cannot store a 36-char canonical UUID, so the two identity spaces cannot be reconciled by encoding alone — they are genuinely different keyspaces unless `crisis_event.patient_id` is re-typed to the canonical `account_id`.

**Why CI is green anyway:** every crisis unit-test fixture (acknowledge/respond/resolve/initiate/patient-summary) sets `accountId` to a UUID-shaped literal such as `00000000-0000-4000-8000-000000000001` (36 chars — which could not even be stored in `accounts.account_id VARCHAR(26)`), and the handlers mock `current_actor_account_id()` / the actor context, so the real ULID↔UUID mismatch is never exercised.

## Why this is a ratifier (Track 6) question, not an app-layer fix

The handlers faithfully consume **canonical** surfaces (the view + wrappers + CDM entity shapes) that were ratified into SI-022 / the CDM v1.9→v1.10 Amendment (P-040). Reconciling the gap means amending canonical schema (`crisis_event.patient_id` + `actor_principal_id` types), the derived view predicate, and the wrapper casts — i.e., a **CDM amendment** and a re-ratification of the crisis entity identity model. That is squarely a CDM-owner + Engineering-Lead + Evans decision; per the discipline floor (hard-floor item 6) Engineering must not close it inline within a handler PR.

## Options for the ratifier (FOR REVIEW)

### Option A — Re-type crisis identity to canonical `VARCHAR(26)` account_id (recommended)

Bring the crisis slice into line with `forms_submission` / `medication_requests`:

- `crisis_event.patient_id` → `VARCHAR(26)` (rename to `patient_account_id` for cross-slice consistency, FK to `accounts(tenant_id, account_id)`), and `crisis_event_lifecycle_transition.actor_principal_id` → `VARCHAR(26)`.
- Drop the `::UUID` casts in the view predicate (`034`) and wrappers (`036`/`037`) — compare `account_id` TEXT to TEXT.
- **Pros:** one identity keyspace platform-wide; matches every other patient-facing slice; eliminates the cast-raise failure mode; the patient self-scoping predicate becomes a correct TEXT equality.
- **Cons:** requires new forward migrations re-typing merged columns + amending merged wrappers/views; touches the already-merged #199/#202/initiate; a CDM amendment + P-NUM.

### Option B — Keep `UUID` patient_id + introduce a canonical `account_id (ULID) → patient_id (UUID)` mapping

Treat the clinical `patient_id` as a distinct UUID keyspace and add a ratified mapping the view/wrappers resolve through (e.g., a `patient_directory(account_id VARCHAR(26), patient_uuid UUID)` lookup) instead of a raw `::UUID` cast.

- **Pros:** preserves UUID `patient_id` if there is a downstream reason (none found in this slice).
- **Cons:** net-new canonical table + a second patient keyspace that contradicts forms/pharmacy; more surface area; the cast must still be removed. **Codex flagged in the dual-recommendation consult that this is the heavier, less-canonical path.**

### Option C — Document a hard guarantee that patient `account_id`s are UUIDs + validate at auth/bind

Only viable if account ids were UUIDs — they are `VARCHAR(26)` ULIDs, so this option is **disqualified** by the existing `accounts` schema unless `accounts.account_id` itself is re-typed (a far larger, platform-wide change).

## Recommendations (dual)

- **Engineering (Claude):** **Option A.** It collapses the crisis slice onto the one canonical identity keyspace already used by forms + pharmacy, removes the failure mode at the root, and avoids inventing a second patient keyspace. Remediation scope must explicitly include the merged #199/#202/initiate (re-typed columns + wrapper casts), sequenced as forward migrations.
- **Codex (R1 adversarial review):** identity-model contract decision required — "a real patient/account mapping predicate, or a documented guarantee that patient account IDs are UUIDs plus validation at auth/bind time." Consistent with Option A (canonical account identity) over the heavier Option B; Option C is disqualified by the `VARCHAR(26)` schema.

## Remediation scope once ratified

1. Forward migration re-typing `crisis_event.patient_id` + `crisis_event_lifecycle_transition.actor_principal_id` (Option A) or adding the mapping table (Option B).
2. Amend view `034` predicate + wrappers `036`/`037` to drop `::UUID`.
3. Update crisis handler test fixtures to use real `VARCHAR(26)` ULID `account_id`s (removes the masking).
4. Re-validate merged #199/#202/initiate against the corrected identity model; re-open the HELD #203/#204 once the canonical surface is fixed.
5. Append Promotion Ledger entry; bump CDM version.

---

_Filed under the autonomous queue-drain discipline (hard-floor item 6: net-new canonical schema / invariant question beyond the SI under review → STOP + escalate, do not close inline). Crisis Sprint 2 PRs #203/#204 are HELD pending this SI's ratification; the remaining non-crisis queue PRs continue to drain independently per the operator's direction._
