/**
 * i029-gate.ts — I-029 6-condition reject-unless evaluator for research data export.
 *
 * Purpose:
 *   Evaluates all 6 conditions of I-029 at export completion time. Returns
 *   `{ pass: true }` only when ALL 6 conditions hold simultaneously.
 *   On failure, returns a structured result with the canonical `invalidation_reason`
 *   enum value matching the violated condition.
 *
 *   Callers MUST emit:
 *     1. `research.export_completed(status='invalidated', invalidation_reason=<reason>)` at high_pii
 *     2. Paired `signal_enforcement_trigger` Category B audit
 *   Bare suppression of the completion-attempt audit is forbidden per I-003.
 *
 * Spec references:
 *   - I-029: 6-condition reject-unless gate (canonical normative text; expanded to
 *     6 conditions 2026-05-02 per Codex Round-12 Scope 3 HIGH-1 adding per-export
 *     grant artifact re-validation as condition 6).
 *   - I-003: audit chain MUST capture failed-completion attempt; bare suppression forbidden.
 *   - I-031: research export audit records carry `audit_sensitivity_level = high_pii`.
 *   - AUDIT_EVENTS v5.2 §5: `research.export_completed` MUST emit with `status=invalidated`
 *     + canonical 6-value `invalidation_reason` enum on delivery rejection.
 *   - TYPES v5.2 `ResearchDataExport.invalidation_reason`: canonical 6-value enum.
 *     Shared exactly with AUDIT_EVENTS v5.2 and STATE_MACHINES v1.1.
 *
 * The 6 conditions (from I-029):
 *   1. `dsa_status_at_export === 'active'`               → `dsa_inactive`
 *   2. `k_threshold_actual >= k_min_required`             → `k_anonymity_violation`
 *   3. `permitted_data_domains_at_export` matches snapshot → `permitted_domain_drift`
 *   4. `consent_cohort_snapshot_hash_completed === consent_cohort_snapshot_hash_initiated` → `consent_cohort_change`
 *   5. Every contributing patient has active ResearchConsent at completion-time → `consent_revocation_mid_export`
 *   6. Per-export grant artifact unexpired + ID/hash-matched + signer-chain-attesting → `grant_artifact_invalidated`
 *
 * Design decisions:
 *   - Conditions are evaluated in order (1→6). First failure short-circuits.
 *     Rationale: DSA validity (condition 1) is the outermost gate; grant artifact
 *     (condition 6) is the most recently added. All six must hold.
 *   - The function does NOT emit audit events itself — that is the caller's
 *     responsibility. Separation of concerns: gate evaluates; caller emits.
 *   - Condition 5 (per-patient consent gate) is STUBBED: real implementation
 *     queries each patient's ResearchConsent record. STUB throws in production
 *     to prevent silent pass-through.
 *   - Condition 6 (grant artifact) is STUBBED: real implementation verifies
 *     the PolicyAuthorization / signer attestation artifact against the
 *     grant_artifact_id + grant_signer_chain_attestation_hash from the
 *     `research.export_initiated` audit event.
 *
 * Open questions for Engineering Lead:
 *   - Condition 5 stub: which DB table holds ResearchConsent records?
 *     CDM v1.2 §ConsentRecord with `consent_type = research_data_use`. Query
 *     per TYPES v5.2 ResearchConsent shape: `granted_at` non-null, `revoked_at` null.
 *   - Condition 6 stub: grant artifact store is not yet implemented (ADR-028
 *     + GOVERNANCE_CONTROLS v5.2 deferred to research data partnership slice).
 *     Until that slice, condition 6 cannot be fully verified at runtime.
 *   - Permitted data domains closed enum: validate against the CCR
 *     `research_permitted_data_domains` key for the tenant's country_of_care.
 */

// ---------------------------------------------------------------------------
// Canonical 6-value invalidation_reason enum
// Shared exactly with TYPES.ResearchDataExport.invalidation_reason and
// STATE_MACHINES v1.1 ResearchExportRequest reject-unless rule.
// ---------------------------------------------------------------------------

export type I029InvalidationReason =
  | 'dsa_inactive'
  | 'k_anonymity_violation'
  | 'permitted_domain_drift'
  | 'consent_cohort_change'
  | 'consent_revocation_mid_export'
  | 'grant_artifact_invalidated';

export type I029GateResult = { pass: true } | { pass: false; reason: I029InvalidationReason };

// ---------------------------------------------------------------------------
// Export context input type
// ---------------------------------------------------------------------------

type DsaStatus = 'active' | 'suspended' | 'expired' | 'retired';

export interface I029ExportContext {
  /** DSA status at completion-time check. Must be 'active'. */
  dsa_status_at_export: DsaStatus;

  /** Actual k-anonymity threshold achieved in the de-identified output. */
  k_threshold_actual: number;
  /** Minimum k-anonymity threshold required (per DSA; default 11 per Master PRD §15.3). */
  k_min_required: number;

  /**
   * Permitted data domains at export completion-time.
   * Must match the snapshot from `research.export_initiated`.
   * Closed enum: `chronic_disease_longitudinal | ncd_surveillance |
   *   pharmacovigilance_signal | population_health_aggregate`.
   */
  permitted_data_domains_at_export: readonly string[];
  /** Snapshot of permitted domains from the `research.export_initiated` audit event. */
  permitted_data_domains_at_initiation: readonly string[];

  /** Consent cohort snapshot hash recorded at completion-time. */
  consent_cohort_snapshot_hash_completed: string;
  /** Consent cohort snapshot hash recorded at initiation. */
  consent_cohort_snapshot_hash_initiated: string;

  /**
   * IDs of all contributing patients.
   * Condition 5 verifies each has active ResearchConsent at completion time.
   */
  contributing_patient_ids: readonly string[];

  /**
   * Per-export grant artifact fields (condition 6 — added v5.2 per Codex Round-12).
   * Required: grant_artifact_id, grant_artifact_validity_to (ISO 8601),
   *           grant_signer_chain_attestation_hash_at_initiation,
   *           grant_signer_chain_attestation_hash_at_completion.
   */
  grant_artifact_id: string;
  grant_artifact_validity_to: string; // ISO 8601
  grant_signer_chain_attestation_hash_at_initiation: string;
  /** Re-validated at completion-time. Must equal the initiation hash. */
  grant_signer_chain_attestation_hash_at_completion: string;
}

// ---------------------------------------------------------------------------
// Condition evaluators
// ---------------------------------------------------------------------------

function evaluateCondition1(ctx: I029ExportContext): I029GateResult {
  if (ctx.dsa_status_at_export !== 'active') {
    return { pass: false, reason: 'dsa_inactive' };
  }
  return { pass: true };
}

function evaluateCondition2(ctx: I029ExportContext): I029GateResult {
  if (ctx.k_threshold_actual < ctx.k_min_required) {
    return { pass: false, reason: 'k_anonymity_violation' };
  }
  return { pass: true };
}

function evaluateCondition3(ctx: I029ExportContext): I029GateResult {
  const atExport = new Set(ctx.permitted_data_domains_at_export);
  const atInitiation = new Set(ctx.permitted_data_domains_at_initiation);

  if (atExport.size !== atInitiation.size) {
    return { pass: false, reason: 'permitted_domain_drift' };
  }
  for (const domain of atExport) {
    if (!atInitiation.has(domain)) {
      return { pass: false, reason: 'permitted_domain_drift' };
    }
  }
  return { pass: true };
}

function evaluateCondition4(ctx: I029ExportContext): I029GateResult {
  if (ctx.consent_cohort_snapshot_hash_completed !== ctx.consent_cohort_snapshot_hash_initiated) {
    return { pass: false, reason: 'consent_cohort_change' };
  }
  return { pass: true };
}

/**
 * Condition 5 — per-patient active ResearchConsent gate.
 *
 * STUB: real implementation queries the `consent_records` table for each
 * patient ID, checking `consent_type = 'research_data_use'`, `granted_at IS NOT NULL`,
 * `revoked_at IS NULL` at completion-time evaluation.
 *
 * SECURITY: this stub THROWS in production to prevent silent pass-through.
 * It may only return a result when `NODE_ENV === 'test'` with a forced override.
 */
async function evaluateCondition5(ctx: I029ExportContext): Promise<I029GateResult> {
  // STUB: per-patient active ResearchConsent verification.
  // STUB: requires CDM v1.2 ResearchConsent query (migration not yet authored).
  // STUB: this function MUST be replaced before any research export reaches production.
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error(
      'I-029 condition 5 (per-patient ResearchConsent gate) is STUBBED. ' +
        'Real implementation required before research data export can proceed in production. ' +
        'See i029-gate.ts open questions.',
    );
  }
  // Test mode: if _testOverrideCondition5 is set, use it; otherwise pass.
  const override = _testOverrideCondition5;
  if (override !== null) return override;
  void ctx.contributing_patient_ids; // referenced to satisfy noUnusedParameters
  return { pass: true };
}

// Test injection point (only readable in test mode)
let _testOverrideCondition5: I029GateResult | null = null;
export function _testSetCondition5Override(result: I029GateResult | null): void {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error('_testSetCondition5Override is only available in test mode.');
  }
  _testOverrideCondition5 = result;
}

/**
 * Condition 6 — per-export grant artifact verification.
 *
 * STUB: real implementation:
 *   1. Retrieves the grant artifact by `grant_artifact_id` from the
 *      PolicyAuthorization / evidence-locker store.
 *   2. Checks `grant_artifact_validity_to >= now()` (not expired).
 *   3. Verifies `grant_signer_chain_attestation_hash_at_completion` matches
 *      `grant_signer_chain_attestation_hash_at_initiation` (no signer rescinded).
 *   4. Verifies the artifact ID/hash binding matches the export's record.
 *
 * STUB: THROWS in production. Requires ADR-028 research data partnership slice.
 */
async function evaluateCondition6(ctx: I029ExportContext): Promise<I029GateResult> {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error(
      'I-029 condition 6 (per-export grant artifact verification) is STUBBED. ' +
        'Real implementation requires the ADR-028 PolicyAuthorization framework ' +
        '(research data partnership slice, Release 2). ' +
        'See i029-gate.ts open questions.',
    );
  }

  // Test mode verification: check expiry and hash match with provided values
  const now = new Date();
  const validityTo = new Date(ctx.grant_artifact_validity_to);
  if (validityTo < now) {
    return { pass: false, reason: 'grant_artifact_invalidated' };
  }
  if (
    ctx.grant_signer_chain_attestation_hash_at_completion !==
    ctx.grant_signer_chain_attestation_hash_at_initiation
  ) {
    return { pass: false, reason: 'grant_artifact_invalidated' };
  }
  return { pass: true };
}

// ---------------------------------------------------------------------------
// evaluateI029Gate — main entry point
// ---------------------------------------------------------------------------

/**
 * evaluateI029Gate — evaluate all 6 I-029 conditions at export completion time.
 *
 * Returns `{ pass: true }` only when ALL 6 conditions hold simultaneously.
 * Conditions are evaluated in order 1 → 6; first failure short-circuits.
 *
 * On `{ pass: false }`, the CALLER must:
 *   1. Emit `research.export_completed(status='invalidated', invalidation_reason=result.reason)`
 *      at `audit_sensitivity_level = 'high_pii'` (I-031).
 *   2. Emit paired `signal_enforcement_trigger` Category B audit capturing
 *      artifact destruction, partner notification, engineering review trigger.
 *
 * Bare suppression of either audit on failure is FORBIDDEN per I-003.
 */
export async function evaluateI029Gate(ctx: I029ExportContext): Promise<I029GateResult> {
  // Condition 1: DSA active
  const c1 = evaluateCondition1(ctx);
  if (!c1.pass) return c1;

  // Condition 2: k-anonymity threshold
  const c2 = evaluateCondition2(ctx);
  if (!c2.pass) return c2;

  // Condition 3: permitted data domain match
  const c3 = evaluateCondition3(ctx);
  if (!c3.pass) return c3;

  // Condition 4: consent cohort snapshot hash
  const c4 = evaluateCondition4(ctx);
  if (!c4.pass) return c4;

  // Condition 5: per-patient active ResearchConsent (STUBBED)
  const c5 = await evaluateCondition5(ctx);
  if (!c5.pass) return c5;

  // Condition 6: per-export grant artifact verification (STUBBED)
  const c6 = await evaluateCondition6(ctx);
  if (!c6.pass) return c6;

  return { pass: true };
}
