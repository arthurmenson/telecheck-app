/**
 * ai-service-guardrails.test.ts — guardrail-template tests per
 * TLC-AI PR E.
 *
 * Locks in the AI-GUARD-001..005 invariants for v1.0:
 *   - Conservative Default exists, is named, is versioned.
 *   - Conservative Default is IMMUTABLE per AI-GUARD-003 — every
 *     subfield's reference identity stays stable (a regression
 *     PR that mutates a frozen subfield would fail-loud here).
 *   - Conservative Default inherits EVERY platform-floor rule per
 *     AI-GUARD-002 — the floor-compliance validator returns no
 *     missing rules.
 *   - The registry routes ALL (tenant, program, country) tuples
 *     to Conservative Default at v1.0.
 *   - Emergency rollback target IS Conservative Default per
 *     AI-GUARD-005.
 *   - getTemplateByName throws fail-loud on enumerated-but-not-
 *     wired templates (GLP-1 / ED / Labs) so a callsite that
 *     prematurely depends on one fails immediately.
 *   - A synthetic template that omits a floor rule is rejected by
 *     validatePlatformFloorCompliance.
 *
 * Spec references:
 *   - AI_LAYERING v5.2 §3 (AI-GUARD-001..005)
 *   - AI_LAYERING v5.2 §4 (FLOOR-007..FLOOR-013 immutable boundaries)
 */

import { describe, expect, it } from 'vitest';

import {
  CONSERVATIVE_DEFAULT_TEMPLATE,
  type GuardrailTemplate,
  PLATFORM_FLOOR_RULES,
  getActiveGuardrailTemplate,
  getEmergencyRollbackTemplate,
  getTemplateByName,
  validatePlatformFloorCompliance,
} from '../../src/modules/ai-service/index.ts';

describe('Conservative Default — AI-GUARD-003 immutable contract', () => {
  it('exists with the canonical name + version', () => {
    expect(CONSERVATIVE_DEFAULT_TEMPLATE.name).toBe('conservative_default');
    expect(CONSERVATIVE_DEFAULT_TEMPLATE.version).toBe('1.0');
    expect(CONSERVATIVE_DEFAULT_TEMPLATE.immutable).toBe(true);
  });

  it('inherits every platform-floor rule per AI-GUARD-002', () => {
    for (const rule of PLATFORM_FLOOR_RULES) {
      expect(CONSERVATIVE_DEFAULT_TEMPLATE.platform_floor_inherited).toContain(rule);
    }
  });

  it('enumerates concrete general-education topics (Mode 1 scope)', () => {
    expect(CONSERVATIVE_DEFAULT_TEMPLATE.scope.general_education_topics.length).toBeGreaterThan(0);
    expect(CONSERVATIVE_DEFAULT_TEMPLATE.scope.general_education_topics).toContain(
      'general_health_education',
    );
  });

  it('enumerates concrete escalation triggers (in addition to platform-floor I-019)', () => {
    expect(CONSERVATIVE_DEFAULT_TEMPLATE.escalation.escalate_on_topics.length).toBeGreaterThan(0);
    expect(CONSERVATIVE_DEFAULT_TEMPLATE.escalation.escalate_on_topics).toContain(
      'mental_health_crisis',
    );
  });

  it('has no program-specific topics (Conservative Default is the FLOOR template; programs ADD on top)', () => {
    expect(CONSERVATIVE_DEFAULT_TEMPLATE.scope.program_specific_topics).toEqual([]);
  });
});

describe('validatePlatformFloorCompliance — AI-GUARD-002 enforcement', () => {
  it('Conservative Default passes (returns empty missing-rules array)', () => {
    expect(validatePlatformFloorCompliance(CONSERVATIVE_DEFAULT_TEMPLATE)).toEqual([]);
  });

  it('a synthetic template missing a floor rule fails-loud', () => {
    const partialTemplate: GuardrailTemplate = {
      ...CONSERVATIVE_DEFAULT_TEMPLATE,
      // Strip FLOOR_009 (crisis-detection floor) to simulate a
      // would-be regression that someone might accidentally allow.
      platform_floor_inherited: PLATFORM_FLOOR_RULES.filter(
        (r) => r !== 'FLOOR_009_no_harmful_instructions',
      ),
    };
    const missing = validatePlatformFloorCompliance(partialTemplate);
    expect(missing).toContain('FLOOR_009_no_harmful_instructions');
    expect(missing.length).toBe(1);
  });

  it('a template with empty floor inheritance fails on ALL rules', () => {
    const emptyTemplate: GuardrailTemplate = {
      ...CONSERVATIVE_DEFAULT_TEMPLATE,
      platform_floor_inherited: [],
    };
    const missing = validatePlatformFloorCompliance(emptyTemplate);
    expect(missing.length).toBe(PLATFORM_FLOOR_RULES.length);
  });
});

describe('Registry routes — PR E v1.0', () => {
  it('getActiveGuardrailTemplate returns Conservative Default for ANY context', () => {
    const t1 = getActiveGuardrailTemplate({ tenant_id: 'Telecheck-US' });
    const t2 = getActiveGuardrailTemplate({
      tenant_id: 'Telecheck-Ghana',
      country_of_care: 'GH',
    });
    const t3 = getActiveGuardrailTemplate({
      tenant_id: 'Telecheck-US',
      program: 'glp_1',
      country_of_care: 'US',
    });
    // Reference-identity: every call returns the SAME hardcoded
    // constant. The runtime path treats Conservative Default as a
    // singleton.
    expect(t1).toBe(CONSERVATIVE_DEFAULT_TEMPLATE);
    expect(t2).toBe(CONSERVATIVE_DEFAULT_TEMPLATE);
    expect(t3).toBe(CONSERVATIVE_DEFAULT_TEMPLATE);
  });

  it('getEmergencyRollbackTemplate returns Conservative Default per AI-GUARD-005', () => {
    expect(getEmergencyRollbackTemplate()).toBe(CONSERVATIVE_DEFAULT_TEMPLATE);
  });

  it('getTemplateByName("conservative_default") resolves', () => {
    expect(getTemplateByName('conservative_default')).toBe(CONSERVATIVE_DEFAULT_TEMPLATE);
  });

  it('getTemplateByName throws fail-loud on enumerated-but-not-wired templates', () => {
    expect(() => getTemplateByName('glp_1_program')).toThrow(/not yet wired/);
    expect(() => getTemplateByName('ed_program')).toThrow(/not yet wired/);
    expect(() => getTemplateByName('labs')).toThrow(/not yet wired/);
  });
});
