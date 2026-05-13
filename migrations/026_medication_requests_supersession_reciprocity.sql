-- =============================================================================
-- File:    migrations/026_medication_requests_supersession_reciprocity.sql
-- Purpose: Close the supersession reciprocity gap inline-deferred in
--          migration 025. Adds a PL/pgSQL trigger function +
--          DEFERRABLE INITIALLY DEFERRED constraint trigger that fires
--          at transaction commit time to verify every supersession edge
--          is reciprocal: A.superseded_by_id = B ↔ B.supersedes_id = A.
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
--   2. The trigger checks edges in BOTH directions:
--        a. For every row with non-null superseded_by_id:
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
--        b. For every row with non-null supersedes_id:
--             - the referenced row MUST exist
--             - the referenced row MUST have superseded_by_id = this
--               row's id
--             - both rows MUST be in the same tenant
--             - both rows MUST be for the same patient_account_id
--             - the referenced row's status MUST be 'superseded'
--
--   3. The trigger is statement-level (FOR EACH STATEMENT) rather than
--      row-level because constraint triggers fire after statement
--      completion regardless of granularity, and statement-level avoids
--      re-walking the same edge multiple times when a single UPDATE
--      touches multiple rows.
--
--   4. The trigger fires on INSERT OR UPDATE OF (id, supersedes_id,
--      superseded_by_id, status, tenant_id, patient_account_id) — these
--      are the columns whose change could break reciprocity. Updates
--      that don't touch any of these columns don't trigger the check.
--
-- PRECONDITIONS:
--   025_medication_requests.sql applied (target table exists with the
--   row-local CHECK constraints + partial UNIQUE indexes).
--
-- ROLLBACK:
--   migrations/rollback/026_rollback.sql
-- =============================================================================

CREATE OR REPLACE FUNCTION medication_requests_supersession_reciprocity_check()
RETURNS TRIGGER AS $$
DECLARE
    edge_row RECORD;
    referenced_row RECORD;
BEGIN
    -- Direction A: every row with a non-null `superseded_by_id` must
    -- point at a row that:
    --   (a) exists
    --   (b) lives in the same tenant
    --   (c) belongs to the same patient
    --   (d) has supersedes_id = this row's id (reciprocity)
    --   (e) has status in (active, discontinued, superseded, expired)
    --       — the replacement may have advanced past active by the
    --       commit time
    -- AND this row's status MUST be 'superseded'.
    FOR edge_row IN
        SELECT id, tenant_id, patient_account_id, status, superseded_by_id
          FROM medication_requests
         WHERE superseded_by_id IS NOT NULL
    LOOP
        IF edge_row.status <> 'superseded' THEN
            RAISE EXCEPTION
                'medication_requests supersession reciprocity violated: '
                'row % has superseded_by_id set but status=% (expected: superseded)',
                edge_row.id, edge_row.status
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        SELECT id, tenant_id, patient_account_id, status, supersedes_id
          INTO referenced_row
          FROM medication_requests
         WHERE id = edge_row.superseded_by_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION
                'medication_requests supersession reciprocity violated: '
                'row % has superseded_by_id=% but the referenced row does not exist',
                edge_row.id, edge_row.superseded_by_id
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF referenced_row.tenant_id <> edge_row.tenant_id THEN
            RAISE EXCEPTION
                'medication_requests supersession reciprocity violated: '
                'row % (tenant=%) points at row % in different tenant=%',
                edge_row.id, edge_row.tenant_id,
                referenced_row.id, referenced_row.tenant_id
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF referenced_row.patient_account_id <> edge_row.patient_account_id THEN
            RAISE EXCEPTION
                'medication_requests supersession reciprocity violated: '
                'cross-patient supersession: row % (patient=%) points at row % (patient=%)',
                edge_row.id, edge_row.patient_account_id,
                referenced_row.id, referenced_row.patient_account_id
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF referenced_row.supersedes_id IS DISTINCT FROM edge_row.id THEN
            RAISE EXCEPTION
                'medication_requests supersession reciprocity violated: '
                'row % has superseded_by_id=% but row % has supersedes_id=% (expected: %)',
                edge_row.id, edge_row.superseded_by_id,
                referenced_row.id, referenced_row.supersedes_id, edge_row.id
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF referenced_row.status NOT IN ('active', 'discontinued', 'superseded', 'expired') THEN
            RAISE EXCEPTION
                'medication_requests supersession reciprocity violated: '
                'row % points forward at row % with status=% (expected: active|discontinued|superseded|expired)',
                edge_row.id, referenced_row.id, referenced_row.status
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END LOOP;

    -- Direction B: every row with a non-null `supersedes_id` must point
    -- at a row that:
    --   (a) exists
    --   (b) lives in the same tenant
    --   (c) belongs to the same patient
    --   (d) has superseded_by_id = this row's id (reciprocity)
    --   (e) has status = 'superseded'
    FOR edge_row IN
        SELECT id, tenant_id, patient_account_id, status, supersedes_id
          FROM medication_requests
         WHERE supersedes_id IS NOT NULL
    LOOP
        SELECT id, tenant_id, patient_account_id, status, superseded_by_id
          INTO referenced_row
          FROM medication_requests
         WHERE id = edge_row.supersedes_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION
                'medication_requests supersession reciprocity violated: '
                'row % has supersedes_id=% but the referenced row does not exist',
                edge_row.id, edge_row.supersedes_id
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF referenced_row.tenant_id <> edge_row.tenant_id THEN
            RAISE EXCEPTION
                'medication_requests supersession reciprocity violated: '
                'row % (tenant=%) points back at row % in different tenant=%',
                edge_row.id, edge_row.tenant_id,
                referenced_row.id, referenced_row.tenant_id
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF referenced_row.patient_account_id <> edge_row.patient_account_id THEN
            RAISE EXCEPTION
                'medication_requests supersession reciprocity violated: '
                'cross-patient supersession: row % (patient=%) points back at row % (patient=%)',
                edge_row.id, edge_row.patient_account_id,
                referenced_row.id, referenced_row.patient_account_id
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF referenced_row.superseded_by_id IS DISTINCT FROM edge_row.id THEN
            RAISE EXCEPTION
                'medication_requests supersession reciprocity violated: '
                'row % has supersedes_id=% but row % has superseded_by_id=% (expected: %)',
                edge_row.id, edge_row.supersedes_id,
                referenced_row.id, referenced_row.superseded_by_id, edge_row.id
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF referenced_row.status <> 'superseded' THEN
            RAISE EXCEPTION
                'medication_requests supersession reciprocity violated: '
                'row % points back at row % with status=% (expected: superseded)',
                edge_row.id, referenced_row.id, referenced_row.status
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END LOOP;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Constraint trigger: DEFERRABLE INITIALLY DEFERRED so it fires at COMMIT
-- time, not after each statement. This is the critical mechanism that
-- accommodates the natural 2-row supersession write (markSuperseded
-- updates the old row's superseded_by_id; the new row's matching
-- supersedes_id was written earlier in the transaction by
-- transitionStatus's activation envelope) — at COMMIT, both halves are
-- visible and the reciprocity check passes.
CREATE CONSTRAINT TRIGGER medication_requests_supersession_reciprocity_trigger
AFTER INSERT OR UPDATE OF
    id, supersedes_id, superseded_by_id, status, tenant_id, patient_account_id
ON medication_requests
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION medication_requests_supersession_reciprocity_check();
