/**
 * ai-service/internal/guardrails/registry.ts — guardrail-template
 * lookup + floor compliance validation per AI_LAYERING v5.2 §3.
 *
 * At PR E the registry only resolves Conservative Default. Other
 * Ghana launch templates (GLP-1 Program, ED Program, Labs) land
 * when their respective program slices activate; per-tenant
 * override (AI_LAYERING v5.2 §9 — tenants may override specific
 * templates with tenant-Clinical-Lead approval) lands when the
 * admin AI-configuration surface ships.
 *
 * AI-GUARD-002 floor-compliance validation:
 *   `validatePlatformFloorCompliance(template)` checks that the
 *   template's `platform_floor_inherited` array includes EVERY
 *   FLOOR_* rule. Returns the offending missing rules so a deploy-
 *   time gate (or runtime sanity-check) can fail-loud rather than
 *   silently allow a floor-weakening template.
 *
 * AI-GUARD-005 emergency rollback:
 *   `getEmergencyRollbackTemplate()` returns Conservative Default
 *   directly. The runtime caller flips its active-template
 *   selection to this and audits the rollback per AUDIT_EVENTS v5.3
 *   Category B (governance action).
 */

import { CONSERVATIVE_DEFAULT_TEMPLATE } from './conservative-default.js';
import {
  type CanonicalGuardrailTemplateName,
  type GuardrailTemplate,
  PLATFORM_FLOOR_RULES,
  type PlatformFloorRule,
} from './types.js';

/**
 * Error thrown when a template fails platform-floor compliance.
 * Per AI-GUARD-002 the configuration validator rejects such
 * templates at deploy time; the runtime enforcer additionally
 * catches violations that pass validation.
 */
export class GuardrailFloorViolationError extends Error {
  constructor(
    public readonly template_id: string,
    public readonly missing_floor_rules: ReadonlyArray<PlatformFloorRule>,
  ) {
    super(
      `Guardrail template ${template_id} violates AI-GUARD-002 — missing platform-floor rules: ${missing_floor_rules.join(', ')}`,
    );
    this.name = 'GuardrailFloorViolationError';
  }
}

/**
 * Validate that a template inherits every platform-floor rule
 * (AI-GUARD-002). Returns the list of missing rules if any; empty
 * array on full compliance.
 *
 * Callers (deploy-time validator + runtime enforcer) gate on
 * `length === 0`.
 */
export function validatePlatformFloorCompliance(
  template: GuardrailTemplate,
): ReadonlyArray<PlatformFloorRule> {
  const inherited = new Set(template.platform_floor_inherited);
  return PLATFORM_FLOOR_RULES.filter((rule) => !inherited.has(rule));
}

/**
 * Resolve the active guardrail template for a (tenant, program?,
 * country?) tuple. At PR E always returns Conservative Default — no
 * per-tenant / per-program / per-country variation is wired yet.
 *
 * The signature accepts the optional discriminators so callers
 * (Mode 1 chat handler, when it lands in PR F+) can already pass
 * the context. The registry's behavior expands when GLP-1 / ED /
 * Labs templates ship.
 */
export function getActiveGuardrailTemplate(_context: {
  tenant_id: string;
  program?: string;
  country_of_care?: string;
}): GuardrailTemplate {
  // PR E: always Conservative Default. Per-template selection lands
  // in subsequent program-slice PRs.
  return CONSERVATIVE_DEFAULT_TEMPLATE;
}

/**
 * Per AI-GUARD-005, returns the rollback target. This is always
 * Conservative Default by spec — the function exists as a named
 * entry point so the runtime path (emergency safe mode) is
 * grep-able and audit-emittable.
 */
export function getEmergencyRollbackTemplate(): GuardrailTemplate {
  return CONSERVATIVE_DEFAULT_TEMPLATE;
}

/**
 * Resolve a template by canonical name. Throws if no such template
 * is wired at the current PR level — fail-loud rather than
 * silently fall back to Conservative Default (which would mask a
 * caller bug).
 *
 * Callers that want fail-soft (e.g., the Mode 1 chat handler when
 * a tenant-override template fails validation) should explicitly
 * fall through to `getActiveGuardrailTemplate` after catching the
 * error, with an audit emission for the fallback.
 */
export function getTemplateByName(name: CanonicalGuardrailTemplateName): GuardrailTemplate {
  switch (name) {
    case 'conservative_default':
      return CONSERVATIVE_DEFAULT_TEMPLATE;
    case 'glp_1_program':
    case 'ed_program':
    case 'labs':
      throw new Error(
        `Guardrail template "${name}" is enumerated in the canonical name union per AI_LAYERING v5.2 §3 but not yet wired — it deploys when the corresponding program / feature slice activates`,
      );
    default: {
      const _exhaustive: never = name;
      void _exhaustive;
      throw new Error(`Unhandled CanonicalGuardrailTemplateName: ${String(name)}`);
    }
  }
}
