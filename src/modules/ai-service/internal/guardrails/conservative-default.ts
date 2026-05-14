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

export const CONSERVATIVE_DEFAULT_TEMPLATE: GuardrailTemplate = {
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
  platform_floor_inherited: PLATFORM_FLOOR_RULES,
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
};
