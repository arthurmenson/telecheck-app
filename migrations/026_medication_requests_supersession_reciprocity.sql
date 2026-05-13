-- =============================================================================
-- File:    migrations/026_medication_requests_supersession_reciprocity.sql
-- Purpose: Close the supersession reciprocity gap inline-deferred in
--          migration 025. Adds a PL/pgSQL trigger function +
--          DEFERRABLE INITIALLY DEFERRED constraint trigger that fires
--          at transaction commit time to verify every supersession edge
--          is reciprocal: A.superseded_by_id = B ↔ B.supersedes_id = A.
--          ALSO runs a one-time apply-time validation pass over existing
--          medication_requests rows so pre-existing corruption can never
--          slip past the new trigger.
--
-- Spec:    - Sprint 35 / TLC-055 PR B
--          - migrations/025_medication_requests.sql (which inline-
--            documents this work item as the TLC-055 acceptance
--            criterion under the DEFERRED WORK block, Codex
--            pharmacy-scaffold-rebuild R12 HIGH finding)
--          - CDM v1.3 §4.16 MedicationRequest
--          - I-003 (audit append-only; bare suppression forbidden)
--          - I-023 / I-027 (tenant scoping)
--
-- HISTORY:
--   Migration 025 (PR #110) ships 4 row-local CHECK constraints + 2
--   partial UNIQUE indexes that catch supersession pathologies
--   detectable from a single row in isolation: self-loops, branching
--   (A → B AND A → C), convergence (B → A AND C → A), status-mismatched
--   pointers (superseded_by_id set on non-superseded rows, supersedes_id
--   set on non-active/non-discontinued rows). What 025 does NOT enforce
--   is reciprocity: A.superseded_by_id = B requires B.supersedes_id = A
--   (and vice versa). Direct-SQL paths, partial-failure retries, or
--   buggy out-of-band writes could otherwise persist a one-sided
--   supersession edge that downstream chain-traversal in refill /
--   dispensing / subscription consumers would mis-route on.
--
--   Migration 026 closes this gap via a deferrable constraint trigger
--   that fires at COMMIT time (after all transactional row changes have
--   landed). The trigger validates BOTH halves of the supersession edge
--   simultaneously, accommodating the natural ordering problem: a
--   supersession is written across two rows, and at the moment row #1
--   commits its half of the edge, row #2's matching half may not yet be
--   in the table. DEFERRABLE INITIALLY DEFERRED lets the trigger queue
--   until COMMIT, when both halves are visible.
--
-- CRITICAL CORRECTNESS NOTES:
--   1. The trigger MUST be DEFERRABLE INITIALLY DEFERRED. Without this,
--      the constraint fires after each row-level UPDATE/INSERT, which
--      makes the natural 2-row supersession write impossible: when
--      `markSuperseded(old, new)` flips old.superseded_by_id = new_id
--      first, the immediate trigger fires and sees new.supersedes_id =
--      NULL (because new was activated by transitionStatus in an earlier
--      step of the service-layer composition; new.supersedes_id was set
--      at activation, BEFORE this UPDATE on old). Deferred-to-COMMIT
--      lets both halves coexist as transient state inside the
--      transaction, only enforcing reciprocity at the commit boundary.
--
--   2. The trigger fires FOR EACH ROW on INSERT OR UPDATE OF (id,
--      supersedes_id, superseded_by_id, status, tenant_id,
--      patient_account_id) but the function validates ONLY the
--      triggered row's own edges plus their reciprocal endpoints —
--      NOT a full-table scan. This keeps trigger cost O(edges
--      touched) rather than O(rows touched × rows in table). The
--      function re-fetches NEW.id from the table at trigger-fire time
--      (the deferred trigger runs at COMMIT, so re-fetching picks up
--      the final committed state of the row; NEW captures DML-time
--      state which may be stale relative to later statements in the
--      same transaction). Updates that don't touch any of the listed
--      columns don't pay the check cost.
--
--   3. The trigger checks edges in BOTH directions for THIS row:
--        a. If this row's superseded_by_id is non-null:
--             - the referenced row MUST exist
--             - the referenced row MUST have supersedes_id = this row's id
--             - both rows MUST be in the same tenant
--             - both rows MUST be for the same patient_account_id
--             - this row's status MUST be 'superseded'
--             - the referenced row's status MUST be 'active' or later
--               (active / discontinued / superseded / expired — the
--               replacement could have advanced beyond active by the
--               time the trigger fires; the only requirement is that
--               the back-pointer-bearing row was once activatable)
--        b. If this row's supersedes_id is non-null:
--             - the referenced row MUST exist
--             - the referenced row MUST have superseded_by_id = this
--               row's id
--             - both rows MUST be in the same tenant
--             - both rows MUST be for the same patient_account_id
--             - the referenced row's status MUST be 'superseded'
--      When an edge spans two rows modified in the same transaction,
--      both rows queue triggers; either firing is sufficient to catch
--      any reciprocity violation, but both fire (idempotently).
--
--   4. Apply-time validation. The trigger guards WRITES only; existing
--      rows in medication_requests are not re-validated when the trigger
--      installs. To prevent pre-existing corruption from surviving
--      deployment, this migration runs a one-time validation pass
--      (DO block at the bottom) that checks the same reciprocity,
--      tenant, patient, and status invariants across all existing rows
--      and RAISES EXCEPTION if any violation exists — which aborts the
--      migration and rolls it back as a single transaction (migration
--      runner pattern in tests/setup.ts:applyMigrations + the equivalent
--      CI/prod runner). The validation runs BEFORE the trigger is
--      installed so a clean apply doesn't loop the trigger over the
--      validation queries themselves.
--
-- PRECONDITIONS:
--   025_medication_requests.sql applied (target table exists with the
--   row-local CHECK constraints + partial UNIQUE indexes).
--
-- ROLLBACK:
--   migrations/rollback/026_rollback.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Step 1 — Apply-time validation of existing supersession edges. Runs
-- BEFORE the trigger installs so the validation queries themselves don't
-- recursively invoke the trigger. If any violation is found, RAISE
-- EXCEPTION fails the migration; the migration runner rolls back the
-- enclosing transaction; the trigger is NOT created until corruption
-- is repaired and the migration re-runs.
--
-- The DO block is wrapped in a function for clean variable scoping; it
-- runs once at migration-apply time. Postgres RLS is not consulted here
-- because the migration runs as superuser (per tests/setup.ts and prod
-- migration runner discipline); the validation sees ALL rows across ALL
-- tenants.
-- ---------------------------------------------------------------------------
SET LOCAL search_path = pg_catalog, public;

-- Acquire SHARE ROW EXCLUSIVE on medication_requests for the rest of
-- the migration transaction. Without this, a concurrent writer can
-- commit a malformed supersession edge AFTER the DO-block validation
-- below passes but BEFORE the CREATE TRIGGER statement at the bottom
-- takes effect. Triggers do not retroactively fire for already-
-- committed rows, so that corrupt edge would survive the migration
-- despite the apply-time validation guarantee. SHARE ROW EXCLUSIVE
-- blocks INSERT / UPDATE / DELETE on the table (which all take ROW
-- EXCLUSIVE, conflicting with SHARE ROW EXCLUSIVE) but allows
-- concurrent SELECTs to proceed, and matches the lock level CREATE
-- TRIGGER would acquire on its own — so reads are unimpacted and we
-- pay no extra disruption beyond what the migration's final statement
-- would require anyway. The lock releases at COMMIT, by which time
-- the trigger is installed and protects against any further malformed
-- writes. Codex R4 HIGH closure (online-migration concurrent-write
-- race window).
LOCK TABLE public.medication_requests IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
    violation_count INTEGER := 0;
    violation_sample TEXT := '';
    rec RECORD;
BEGIN
    -- Direction A: every row with non-null superseded_by_id must point
    -- at a row that exists in the same tenant + same patient, with the
    -- reciprocal supersedes_id back-pointer, and whose status is in the
    -- post-active set.
    FOR rec IN
        SELECT a.id          AS a_id,
               a.tenant_id   AS a_tenant,
               a.patient_account_id AS a_patient,
               a.status      AS a_status,
               a.superseded_by_id   AS a_forward,
               b.id          AS b_id,
               b.tenant_id   AS b_tenant,
               b.patient_account_id AS b_patient,
               b.status      AS b_status,
               b.supersedes_id      AS b_back
          FROM public.medication_requests a
          LEFT JOIN public.medication_requests b
            ON b.id = a.superseded_by_id
         WHERE a.superseded_by_id IS NOT NULL
           AND (
                a.status <> 'superseded'
                OR b.id IS NULL
                OR b.tenant_id IS DISTINCT FROM a.tenant_id
                OR b.patient_account_id IS DISTINCT FROM a.patient_account_id
                OR b.supersedes_id IS DISTINCT FROM a.id
                OR b.status NOT IN ('active', 'discontinued', 'superseded', 'expired')
           )
    LOOP
        violation_count := violation_count + 1;
        IF violation_count <= 3 THEN
            violation_sample := violation_sample || format(
                '  - direction A: row %s (tenant=%s, patient=%s, status=%s, superseded_by_id=%s) → row %s (tenant=%s, patient=%s, status=%s, supersedes_id=%s)' || E'\n',
                rec.a_id, rec.a_tenant, rec.a_patient, rec.a_status, rec.a_forward,
                COALESCE(rec.b_id, '<missing>'), COALESCE(rec.b_tenant, '<n/a>'),
                COALESCE(rec.b_patient, '<n/a>'), COALESCE(rec.b_status, '<n/a>'),
                COALESCE(rec.b_back, '<n/a>')
            );
        END IF;
    END LOOP;

    -- Direction B: every row with non-null supersedes_id must point at
    -- a row that exists in the same tenant + same patient, with the
    -- reciprocal superseded_by_id back-pointer, and whose status is
    -- exactly 'superseded'.
    FOR rec IN
        SELECT b.id          AS b_id,
               b.tenant_id   AS b_tenant,
               b.patient_account_id AS b_patient,
               b.status      AS b_status,
               b.supersedes_id      AS b_back,
               a.id          AS a_id,
               a.tenant_id   AS a_tenant,
               a.patient_account_id AS a_patient,
               a.status      AS a_status,
               a.superseded_by_id   AS a_forward
          FROM public.medication_requests b
          LEFT JOIN public.medication_requests a
            ON a.id = b.supersedes_id
         WHERE b.supersedes_id IS NOT NULL
           AND (
                a.id IS NULL
                OR a.tenant_id IS DISTINCT FROM b.tenant_id
                OR a.patient_account_id IS DISTINCT FROM b.patient_account_id
                OR a.superseded_by_id IS DISTINCT FROM b.id
                OR a.status <> 'superseded'
           )
    LOOP
        violation_count := violation_count + 1;
        IF violation_count <= 3 THEN
            violation_sample := violation_sample || format(
                '  - direction B: row %s (tenant=%s, patient=%s, status=%s, supersedes_id=%s) → row %s (tenant=%s, patient=%s, status=%s, superseded_by_id=%s)' || E'\n',
                rec.b_id, rec.b_tenant, rec.b_patient, rec.b_status, rec.b_back,
                COALESCE(rec.a_id, '<missing>'), COALESCE(rec.a_tenant, '<n/a>'),
                COALESCE(rec.a_patient, '<n/a>'), COALESCE(rec.a_status, '<n/a>'),
                COALESCE(rec.a_forward, '<n/a>')
            );
        END IF;
    END LOOP;

    IF violation_count > 0 THEN
        -- NOTE: the format-string position in RAISE EXCEPTION must be a
        -- single string literal (PL/pgSQL parser requirement). Adjacent
        -- E-strings are concatenated by the parser at parse time;
        -- runtime `||` concatenation is NOT permitted here. The
        -- violation_sample substitution carries the newline-separated
        -- lines built up in the FOR loops above.
        RAISE EXCEPTION
            E'migration 026 apply-time validation found % pre-existing supersession-reciprocity violation(s); '
            E'sample (first 3):\n'
            E'%'
            E'REPAIR THE VIOLATIONS BEFORE RE-APPLYING THIS MIGRATION. '
            E'Migration rolled back; trigger NOT installed.',
            violation_count, violation_sample
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Step 2 — Reciprocity-check function (row-scoped; no full-table scan).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION medication_requests_supersession_reciprocity_check()
RETURNS TRIGGER
LANGUAGE plpgsql
-- SECURITY DEFINER is required (Codex R3 HIGH closure). The trigger is
-- enforcing a cross-row durable invariant, NOT a per-session access
-- control. With the default SECURITY INVOKER, the trigger's re-fetch
-- runs under the calling session's RLS context. An adversary with
-- SQL access could:
--   1. set_tenant_context('Telecheck-US') and INSERT a malformed
--      one-sided supersession row in tenant US
--   2. set_tenant_context('Telecheck-Ghana') before SET CONSTRAINTS
--      IMMEDIATE / COMMIT
--   3. trigger fires, re-fetches by NEW.id under Ghana RLS context,
--      sees zero rows (US row is RLS-invisible), hits the NOT FOUND
--      branch, returns silently — letting the malformed edge commit.
-- SECURITY DEFINER makes the function execute with the privileges of
-- the function OWNER (the migration-applying role — superuser in CI and
-- prod, BYPASSRLS in both). Superuser/BYPASSRLS roles bypass FORCE RLS
-- so the re-fetch sees the real row regardless of caller tenant binding.
-- The function only performs parameterized SELECT on the canonical
-- table and RAISE EXCEPTION on violation — no dynamic SQL, no caller-
-- supplied tables, no privilege exposure beyond what the trigger needs.
SECURITY DEFINER
-- Lock search_path to a fixed two-element list (pg_catalog first for
-- builtins, public for our schema). Required for SECURITY DEFINER
-- functions per Postgres SECURITY DEFINER hardening guidance: without
-- this, the elevated execution context could be redirected to a
-- shadow table the caller created in pg_temp. Every table reference
-- inside the function is ALSO schema-qualified as
-- `public.medication_requests` as defense-in-depth so the function is
-- robust even if the SET clause is stripped by a future edit. Codex
-- R2 HIGH closure.
SET search_path = pg_catalog, public
AS $$
DECLARE
    this_row       RECORD;
    referenced_row RECORD;
BEGIN
    -- Re-fetch THIS row at trigger-fire time. NEW captures DML-time
    -- state, but DEFERRABLE triggers fire at COMMIT, by which time other
    -- statements in the same transaction may have updated this row. The
    -- re-fetch gives the final committed state.
    SELECT id, tenant_id, patient_account_id, status, supersedes_id, superseded_by_id
      INTO this_row
      FROM public.medication_requests
     WHERE id = NEW.id;

    IF NOT FOUND THEN
        -- Row was deleted within the same transaction. Deletion is not
        -- within v1.0 medication_requests flows but the trigger
        -- tolerates it gracefully — nothing to validate on a row that
        -- no longer exists.
        RETURN NULL;
    END IF;

    -- ---------------------------------------------------------------
    -- Direction A: this row has a non-null forward supersession pointer.
    -- The referenced row must exist, be in the same tenant + same
    -- patient, have the reciprocal supersedes_id back-pointer, and
    -- carry an active-or-later status. This row's status MUST be
    -- 'superseded'.
    -- ---------------------------------------------------------------
    IF this_row.superseded_by_id IS NOT NULL THEN
        IF this_row.status <> 'superseded' THEN
            RAISE EXCEPTION
                'medication_requests supersession reciprocity violated: '
                'row % has superseded_by_id set but status=% (expected: superseded)',
                this_row.id, this_row.status
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        SELECT id, tenant_id, patient_account_id, status, supersedes_id
          INTO referenced_row
          FROM public.medication_requests
         WHERE id = this_row.superseded_by_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION
                'medication_requests supersession reciprocity violated: '
                'row % has superseded_by_id=% but the referenced row does not exist',
                this_row.id, this_row.superseded_by_id
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF referenced_row.tenant_id <> this_row.tenant_id THEN
            RAISE EXCEPTION
                'medication_requests supersession reciprocity violated: '
                'row % (tenant=%) points at row % in different tenant=%',
                this_row.id, this_row.tenant_id,
                referenced_row.id, referenced_row.tenant_id
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF referenced_row.patient_account_id <> this_row.patient_account_id THEN
            RAISE EXCEPTION
                'medication_requests supersession reciprocity violated: '
                'cross-patient supersession: row % (patient=%) points at row % (patient=%)',
                this_row.id, this_row.patient_account_id,
                referenced_row.id, referenced_row.patient_account_id
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF referenced_row.supersedes_id IS DISTINCT FROM this_row.id THEN
            RAISE EXCEPTION
                'medication_requests supersession reciprocity violated: '
                'row % has superseded_by_id=% but row % has supersedes_id=% (expected: %)',
                this_row.id, this_row.superseded_by_id,
                referenced_row.id, referenced_row.supersedes_id, this_row.id
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF referenced_row.status NOT IN ('active', 'discontinued', 'superseded', 'expired') THEN
            RAISE EXCEPTION
                'medication_requests supersession reciprocity violated: '
                'row % points forward at row % with status=% (expected: active|discontinued|superseded|expired)',
                this_row.id, referenced_row.id, referenced_row.status
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;

    -- ---------------------------------------------------------------
    -- Direction B: this row has a non-null back supersession pointer.
    -- The referenced row must exist, be in the same tenant + same
    -- patient, have the reciprocal superseded_by_id forward-pointer,
    -- and carry status='superseded'.
    -- ---------------------------------------------------------------
    IF this_row.supersedes_id IS NOT NULL THEN
        SELECT id, tenant_id, patient_account_id, status, superseded_by_id
          INTO referenced_row
          FROM public.medication_requests
         WHERE id = this_row.supersedes_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION
                'medication_requests supersession reciprocity violated: '
                'row % has supersedes_id=% but the referenced row does not exist',
                this_row.id, this_row.supersedes_id
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF referenced_row.tenant_id <> this_row.tenant_id THEN
            RAISE EXCEPTION
                'medication_requests supersession reciprocity violated: '
                'row % (tenant=%) points back at row % in different tenant=%',
                this_row.id, this_row.tenant_id,
                referenced_row.id, referenced_row.tenant_id
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF referenced_row.patient_account_id <> this_row.patient_account_id THEN
            RAISE EXCEPTION
                'medication_requests supersession reciprocity violated: '
                'cross-patient supersession: row % (patient=%) points back at row % (patient=%)',
                this_row.id, this_row.patient_account_id,
                referenced_row.id, referenced_row.patient_account_id
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF referenced_row.superseded_by_id IS DISTINCT FROM this_row.id THEN
            RAISE EXCEPTION
                'medication_requests supersession reciprocity violated: '
                'row % has supersedes_id=% but row % has superseded_by_id=% (expected: %)',
                this_row.id, this_row.supersedes_id,
                referenced_row.id, referenced_row.superseded_by_id, this_row.id
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF referenced_row.status <> 'superseded' THEN
            RAISE EXCEPTION
                'medication_requests supersession reciprocity violated: '
                'row % points back at row % with status=% (expected: superseded)',
                this_row.id, referenced_row.id, referenced_row.status
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;

    RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Step 3 — Constraint trigger. DEFERRABLE INITIALLY DEFERRED so it fires
-- at COMMIT time, not after each statement. This is the critical
-- mechanism that accommodates the natural 2-row supersession write
-- (markSuperseded updates the old row's superseded_by_id; the new row's
-- matching supersedes_id was written earlier in the transaction by
-- transitionStatus's activation envelope) — at COMMIT, both halves are
-- visible and the reciprocity check passes.
--
-- FOR EACH ROW with NEW.id-scoped re-fetch keeps work proportional to
-- rows touched, not rows-touched × rows-in-table. UPDATE OF column list
-- means updates that touch no supersession/identity columns don't pay
-- the check cost at all.
-- ---------------------------------------------------------------------------
CREATE CONSTRAINT TRIGGER medication_requests_supersession_reciprocity_trigger
AFTER INSERT OR UPDATE OF
    id, supersedes_id, superseded_by_id, status, tenant_id, patient_account_id
ON medication_requests
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION medication_requests_supersession_reciprocity_check();
