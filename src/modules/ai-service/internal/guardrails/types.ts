/**
 * ai-service/internal/guardrails/types.ts — guardrail-template
 * contracts per AI_LAYERING v5.2 §3.
 *
 * Per AI-GUARD-001..005:
 *   - Every Mode 1 response is governed by exactly one template;
 *     template_id + version are logged on every response.
 *   - No template may relax behavior below the platform floor
 *     (FLOOR-007..FLOOR-013). Validation runs at deploy time +
 *     runtime enforcement catches violations that pass.
 *   - Conservative Default is IMMUTABLE — cannot be modified or
 *     deactivated. Emergency Safe Mode reverts all markets to
 *     Conservative Default.
 *   - Deployment requires a passing test suite.
 *   - Rollback to Conservative Default is one-action for authorized
 *     roles (AI Safety Lead, Country Launch Director), takes
 *     effect within 60 seconds.
 *
 * Ghana launch templates (per AI_LAYERING v5.2 §3):
 *   - Conservative Default — always active, cannot deactivate
 *   - GLP-1 Program — deploys when GLP-1 program launches
 *   - ED Program — deploys when ED program launches
 *   - Labs — deploys when lab upload feature launches
 *
 * At PR E only Conservative Default is wired (hardcoded constant).
 * The other templates land when their respective program slices
 * activate. Per-tenant override (AI_LAYERING v5.2 §9) lands when
 * the admin AI-configuration surface ships.
 *
 * Spec references:
 *   - AI_LAYERING v5.2 §3 (AI-GUARD-001..005)
 *   - AI_LAYERING v5.2 §4 (FLOOR-007..FLOOR-013 immutable boundaries)
 *   - AI_LAYERING v5.2 §9 (tenant scoping; templates platform-scoped
 *     with tenant override capacity)
 *   - Guardrail Templates & Test Suites v1.0 (canonical content)
 *   - AUDIT_EVENTS v5.3 (template_id + guardrail_version on every
 *     Mode 1 audit record per FLOOR-020)
 */

import { asGuardrailTemplateId, type GuardrailTemplateId } from '../types.js';

// ---------------------------------------------------------------------------
// GuardrailTemplate row shape
// ---------------------------------------------------------------------------

/**
 * Canonical template identifiers known at v1.0. Strongly typed as a
 * literal union so:
 *   - A switch on template_id is exhaustively checked at compile
 *     time (a future template addition fails-compile until every
 *     consumer adds a branch).
 *   - Audit envelope queries can filter on a known set without
 *     resorting to string compares.
 *
 * The runtime registry resolves a template_id to a concrete
 * GuardrailTemplate via `getActiveGuardrailTemplate`; only
 * Conservative Default is wired at PR E.
 */
export type CanonicalGuardrailTemplateName =
  | 'conservative_default'
  | 'glp_1_program' // PROGRAM-SCOPED: deploys when GLP-1 program launches
  | 'ed_program' // PROGRAM-SCOPED: deploys when ED program launches
  | 'labs'; // FEATURE-SCOPED: deploys when lab upload launches

/**
 * The platform floor lives outside guardrail-template configuration
 * — these are NOT relaxable per AI-GUARD-002. The template
 * validator rejects any template that attempts to weaken these.
 */
export type PlatformFloorRule =
  | 'FLOOR_007_no_ai_identity_concealment'
  | 'FLOOR_008_no_named_clinician_impersonation'
  | 'FLOOR_009_no_harmful_instructions'
  | 'FLOOR_010_no_unauthenticated_dosing_advice'
  | 'FLOOR_011_no_definitive_diagnosis_without_clinician_review'
  | 'FLOOR_012_no_bypass_of_service_gates'
  | 'FLOOR_013_no_bypass_of_mandatory_escalation';

/**
 * Permissible behavior — what the template ENABLES on top of the
 * platform floor. Templates extend Conservative Default with
 * program-specific or feature-specific scope (per AI_LAYERING v5.2
 * §3 Ghana launch templates table). They never weaken.
 */
export interface GuardrailScope {
  /** Topics the assistant may discuss with general patient education. */
  general_education_topics: ReadonlyArray<string>;
  /** Program-specific topics (e.g., 'glp_1_injection_technique'). */
  program_specific_topics: ReadonlyArray<string>;
  /** Lab-result categories the assistant may interpret at a
   *  patient-explainable level (per FLOOR-011 — explanation only,
   *  no diagnosis). */
  lab_explanation_categories: ReadonlyArray<string>;
}

/**
 * Conditions under which the template MANDATES escalation to a
 * clinician (in addition to platform-floor escalation triggers
 * which are always-on per FLOOR-013 + I-019).
 */
export interface GuardrailEscalation {
  /** Symptoms or topics that ALWAYS escalate to a clinician under
   *  this template. */
  escalate_on_topics: ReadonlyArray<string>;
  /** Medications under this template's program — questions outside
   *  the protocol's scope escalate. */
  escalate_off_protocol_medications: ReadonlyArray<string>;
}

/**
 * The full guardrail template. Persisted in a deploy-controlled
 * source-of-truth (DB at later PRs; hardcoded constant at PR E).
 * Every field is FROZEN at deploy time; mutation post-deploy
 * requires a new version + redeploy per AI-GUARD-004.
 */
export interface GuardrailTemplate {
  readonly id: GuardrailTemplateId;
  readonly name: CanonicalGuardrailTemplateName;
  readonly version: string;
  /** Human-readable description for operator UI. */
  readonly description: string;
  /** Platform floor rules this template explicitly inherits — MUST
   *  include every FLOOR_* rule per AI-GUARD-002 (no template can
   *  weaken the floor). */
  readonly platform_floor_inherited: ReadonlyArray<PlatformFloorRule>;
  /** What the template ENABLES on top of the floor. */
  readonly scope: GuardrailScope;
  /** Escalation triggers ADDED by this template (platform-floor
   *  escalation is always-on regardless). */
  readonly escalation: GuardrailEscalation;
  /** True for Conservative Default; false for every other template.
   *  Per AI-GUARD-003: only the immutable=true template cannot be
   *  modified or deactivated. */
  readonly immutable: boolean;
}

/**
 * The complete platform floor — every FLOOR rule under §4 of
 * AI_LAYERING v5.2. Used by the deploy-time validator + runtime
 * enforcer to assert every template inherits the full set.
 *
 * RUNTIME-FROZEN per Codex PR E R1 HIGH-2 closure 2026-05-14:
 * TypeScript's `readonly` / `ReadonlyArray` are STRUCTURAL — the
 * compiler enforces no-mutation but the runtime array is still
 * mutable through type-assertion escape hatches (e.g.,
 * `(PLATFORM_FLOOR_RULES as PlatformFloorRule[]).push(...)`).
 * Object.freeze locks the array at runtime so a malicious or
 * accidental mutation throws in strict mode + silently fails in
 * sloppy mode rather than corrupting the safety rollback target.
 */
export const PLATFORM_FLOOR_RULES: ReadonlyArray<PlatformFloorRule> = Object.freeze([
  'FLOOR_007_no_ai_identity_concealment',
  'FLOOR_008_no_named_clinician_impersonation',
  'FLOOR_009_no_harmful_instructions',
  'FLOOR_010_no_unauthenticated_dosing_advice',
  'FLOOR_011_no_definitive_diagnosis_without_clinician_review',
  'FLOOR_012_no_bypass_of_service_gates',
  'FLOOR_013_no_bypass_of_mandatory_escalation',
] as const);

// Re-export GuardrailTemplateId + asGuardrailTemplateId from the
// branded-IDs module for callers that import from this file
// directly (the registry below uses them).
export type { GuardrailTemplateId };
export { asGuardrailTemplateId };
