/**
 * ai-service/internal/guardrails/conservative-default.ts — the
 * immutable Conservative Default guardrail template per AI_LAYERING
 * v5.2 §3 (AI-GUARD-003).
 *
 * "Always active. Cannot deactivate. Emergency Safe Mode reverts all
 *  markets to Conservative Default."
 *
 * The template is hardcoded here (not DB-driven) because:
 *   1. AI-GUARD-003 makes it IMMUTABLE — a DB row that could be
 *      UPDATEd is the wrong substrate. A compiled constant means
 *      modification requires a source edit + redeploy + code
 *      review.
 *   2. It's the rollback target for AI-GUARD-005 (one-action
 *      revert in 60 seconds). A hardcoded constant ships in the
 *      binary; rollback is instant when the runtime switches its
 *      active-template selection.
 *   3. The Promotion Ledger + Reviewer Brief discipline means any
 *      change to this content requires a Spec Issue + reviewer
 *      sign-off per EHBG §12.
 *
 * Per AI_LAYERING v5.2 §3 Ghana launch templates row:
 *   "General health education, medication information, lab
 *    explanation, symptom discussion, crisis detection. No
 *    diagnosis, no dosing outside care."
 *
 * The diagnosis + dosing restrictions are platform-floor (FLOOR-010
 * + FLOOR-011); this template's scope merely enumerates what it
 * ENABLES on top of that floor. Crisis detection runs as a sibling
 * platform-floor concern (I-019) regardless of this template's
 * configuration — it's never relaxable by a template per FLOOR-013.
 */

import { asGuardrailTemplateId } from '../types.js';

import { type GuardrailTemplate, PLATFORM_FLOOR_RULES } from './types.js';

/**
 * Deep-freeze helper. Object.freeze is shallow — a frozen object's
 * nested arrays + objects remain mutable. Walk the structure once
 * at module init and freeze every level so the rollback target is
 * runtime-immutable per AI-GUARD-003.
 *
 * Codex PR E R1 HIGH-1 closure 2026-05-14.
 */
function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === 'object') {
    for (const key of Object.getOwnPropertyNames(obj)) {
      const value = (obj as Record<string, unknown>)[key];
      if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        deepFreeze(value);
      }
    }
    Object.freeze(obj);
  }
  return obj;
}

/**
 * The hardcoded Conservative Default template. Deep-frozen at module
 * init so:
 *   - Direct property assignment (`tpl.version = '2.0'`) throws in
 *     strict mode + silently fails in sloppy mode.
 *   - Array pushes (`tpl.scope.general_education_topics.push(...)`)
 *     are blocked at every nesting level.
 *   - The `platform_floor_inherited` array is a FROZEN COPY of
 *     PLATFORM_FLOOR_RULES (not the same reference) so mutation of
 *     PLATFORM_FLOOR_RULES (if it were possible — it's also frozen,
 *     defense in depth) cannot propagate to Conservative Default.
 */
export const CONSERVATIVE_DEFAULT_TEMPLATE: GuardrailTemplate = deepFreeze({
  id: asGuardrailTemplateId('gtpl_conservative_default_v1_0'),
  name: 'conservative_default',
  version: '1.0',
  description:
    'Conservative Default guardrail template — always active, cannot deactivate, ' +
    'cannot be modified per AI-GUARD-003. The rollback target for AI-GUARD-005. ' +
    'Enables general health education, medication information, lab explanation, ' +
    'and symptom discussion. No diagnosis (FLOOR-011), no dosing outside ' +
    'authenticated care relationship (FLOOR-010). Crisis detection (FLOOR-009 + ' +
    'I-019) runs independent of template configuration.',
  // Frozen COPY of PLATFORM_FLOOR_RULES so the two structures are
  // independent at runtime. PR E R1 HIGH-2 defense-in-depth.
  platform_floor_inherited: [...PLATFORM_FLOOR_RULES],
  scope: {
    general_education_topics: [
      'general_health_education',
      'medication_information',
      'symptom_discussion',
      'preventive_care',
      'lifestyle_factors',
      'when_to_seek_care',
    ],
    program_specific_topics: [],
    lab_explanation_categories: [
      'common_blood_tests',
      'lipid_panel',
      'basic_metabolic_panel',
      'comprehensive_metabolic_panel',
      'cbc',
      'thyroid_panel',
      'a1c_explanation',
    ],
  },
  escalation: {
    // Conservative Default escalates on any topic outside its
    // scope. The template itself doesn't enumerate them; the
    // runtime enforcer (PR F+) refers questions outside this scope
    // to clinician contact rather than answering.
    escalate_on_topics: [
      'chest_pain',
      'shortness_of_breath',
      'severe_bleeding',
      'allergic_reaction',
      'pregnancy_complication',
      'mental_health_crisis',
      'medication_adverse_event',
    ],
    escalate_off_protocol_medications: [],
  },
  immutable: true,
});
