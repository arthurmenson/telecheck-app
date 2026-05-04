/**
 * I-014 canonical glossary enforcement — unit-style integration tests.
 *
 * Covers `src/lib/glossary.ts` (`asMedicationRequestId`, `asTenantId`,
 * `assertCanonicalTerm`, `isTenantIdFormat`, `GlossaryViolationError`).
 * Until this commit had 9 indirect mentions in other tests but ZERO
 * direct coverage of the runtime enforcement paths.
 *
 * Why this matters:
 *   I-014 says canonical vocabulary IS enforced. Forbidden aliases
 *   (`prescription`, `chatbot`, `customer`, bare `Heros`) are documented
 *   regressions that lead to (a) DB-schema vs code drift, (b) audit
 *   envelope ambiguity, and (c) downstream cross-tenant rendering bugs
 *   when consumer DBA leaks into operating-tenant identifier slots
 *   (Master PRD v1.10 §17 brand-structure violations). The runtime
 *   guards in this module are the LAST defense — they must throw
 *   loudly, never silently coerce.
 *
 * Coverage in this file:
 *   1. asMedicationRequestId — accepts mrx_-prefixed IDs; rejects
 *      everything else with GlossaryViolationError citing TYPES v5.2.
 *   2. asTenantId — accepts Telecheck-{Country} format; rejects bare
 *      `Heros`, `Heros-Health`, `customer`, malformed prefixes, lowercase
 *      country codes that don't match the regex.
 *   3. assertCanonicalTerm — case-insensitive forbidden-alias detection;
 *      every documented alias trips; canonical replacements pass through;
 *      optional context appears in the thrown message.
 *   4. isTenantIdFormat — non-throwing predicate; matches/rejects same
 *      patterns as asTenantId regex but does NOT enforce the
 *      bare-Heros forbidden-alias check (predicate is format-only).
 *   5. GlossaryViolationError — name field, instanceof checks, message
 *      cites I-014.
 *
 * Spec references:
 *   - I-014 (canonical vocabulary enforcement)
 *   - Master PRD v1.10 §17 + GLOSSARY v5.2 C3 brand-structure rules
 *   - GLOSSARY v5.2 forbidden-alias list
 *   - TYPES v5.2 ID conventions (mrx_ prefix on MedicationRequestId)
 */

import { describe, expect, it } from 'vitest';

import {
  GlossaryViolationError,
  asMedicationRequestId,
  asTenantId,
  assertCanonicalTerm,
  isTenantIdFormat,
} from '../../src/lib/glossary.ts';

// ---------------------------------------------------------------------------
// 1. asMedicationRequestId
// ---------------------------------------------------------------------------

describe('asMedicationRequestId — mrx_ prefix enforcement (TYPES v5.2)', () => {
  it('accepts a well-formed mrx_-prefixed ULID', () => {
    const id = asMedicationRequestId('mrx_01HXY12345ABCDEFG');
    expect(id).toBe('mrx_01HXY12345ABCDEFG');
  });

  it('rejects bare ULID without prefix', () => {
    expect(() => asMedicationRequestId('01HXY12345ABCDEFG')).toThrow(GlossaryViolationError);
  });

  it('rejects rx_-prefixed ID (close-but-wrong prefix)', () => {
    expect(() => asMedicationRequestId('rx_01HXY12345ABCDEFG')).toThrow(GlossaryViolationError);
  });

  it('rejects prescription_-prefixed ID (forbidden alias prefix)', () => {
    expect(() => asMedicationRequestId('prescription_01HXY12345')).toThrow(GlossaryViolationError);
  });

  it('rejects empty string', () => {
    expect(() => asMedicationRequestId('')).toThrow(GlossaryViolationError);
  });

  it('error message cites TYPES v5.2 + the offending value', () => {
    try {
      asMedicationRequestId('rx_invalid');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GlossaryViolationError);
      const e = err as GlossaryViolationError;
      expect(e.message).toMatch(/TYPES v5\.2/);
      expect(e.message).toMatch(/mrx_/);
      // Original value appears in the error message for grep-ability
      expect(e.message).toMatch(/rx_invalid/);
    }
  });

  it('case-sensitivity — MRX_ uppercase is NOT accepted (canonical prefix is lowercase)', () => {
    // Pinning current strict-prefix behavior. If a future change adds
    // case-insensitive prefix matching, this test fails and the change
    // is deliberate.
    expect(() => asMedicationRequestId('MRX_01HXY12345ABCDEFG')).toThrow(GlossaryViolationError);
  });
});

// ---------------------------------------------------------------------------
// 2. asTenantId
// ---------------------------------------------------------------------------

describe('asTenantId — Telecheck-{Country} format + forbidden-alias enforcement', () => {
  it('accepts canonical "Telecheck-US"', () => {
    expect(asTenantId('Telecheck-US')).toBe('Telecheck-US');
  });

  it('accepts canonical "Telecheck-Ghana"', () => {
    expect(asTenantId('Telecheck-Ghana')).toBe('Telecheck-Ghana');
  });

  it('accepts test-style "Telecheck-T<XX>"', () => {
    expect(asTenantId('Telecheck-Tab')).toBe('Telecheck-Tab');
  });

  it('REJECTS bare "Heros"', () => {
    expect(() => asTenantId('Heros')).toThrow(GlossaryViolationError);
  });

  it('REJECTS "Heros-Health" (bare consumer DBA used as tenant)', () => {
    expect(() => asTenantId('Heros-Health')).toThrow(GlossaryViolationError);
  });

  it('REJECTS "Heros-Health-US" (consumer-DBA-style, not operating tenant)', () => {
    expect(() => asTenantId('Heros-Health-US')).toThrow(GlossaryViolationError);
  });

  it('REJECTS bare "customer"', () => {
    expect(() => asTenantId('customer')).toThrow(GlossaryViolationError);
  });

  it('REJECTS "telecheck-us" (lowercase prefix)', () => {
    // Format regex requires "Telecheck-" capitalized.
    expect(() => asTenantId('telecheck-us')).toThrow(GlossaryViolationError);
  });

  it('REJECTS "Telecheck-us" (lowercase country first letter)', () => {
    // Format requires country first letter uppercase per regex /^Telecheck-[A-Z][A-Za-z]+$/
    expect(() => asTenantId('Telecheck-us')).toThrow(GlossaryViolationError);
  });

  it('REJECTS empty string', () => {
    expect(() => asTenantId('')).toThrow(GlossaryViolationError);
  });

  it('REJECTS "Telecheck-" (empty country)', () => {
    expect(() => asTenantId('Telecheck-')).toThrow(GlossaryViolationError);
  });

  it('REJECTS "Telecheck-1US" (digit in country)', () => {
    // Regex requires [A-Z] start + [A-Za-z]+ rest — digits not allowed.
    expect(() => asTenantId('Telecheck-1US')).toThrow(GlossaryViolationError);
  });

  it('REJECTS "Telecheck-U" (single character country — regex requires [A-Z][A-Za-z]+)', () => {
    // Regex requires [A-Z] PLUS at least one more [A-Za-z], so single
    // letter doesn't match. Pinning this.
    expect(() => asTenantId('Telecheck-U')).toThrow(GlossaryViolationError);
  });

  it('error message cites Master PRD §17 + offending value', () => {
    try {
      asTenantId('Heros-Ghana');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GlossaryViolationError);
      const e = err as GlossaryViolationError;
      expect(e.message).toMatch(/Master PRD/);
      expect(e.message).toMatch(/Heros-Ghana/);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. assertCanonicalTerm — runtime case-insensitive forbidden-alias detection
// ---------------------------------------------------------------------------

describe('assertCanonicalTerm — case-insensitive forbidden-alias detection', () => {
  it('throws on canonical forbidden aliases (every documented value)', () => {
    const forbidden = [
      'prescription',
      'prescriptionid',
      'chatbot',
      'customer',
      'heros',
      'heros-health',
      'ai_mode_1',
      'ai_mode_2',
    ];
    for (const term of forbidden) {
      expect(() => assertCanonicalTerm(term)).toThrow(GlossaryViolationError);
    }
  });

  it('case-insensitivity — UPPERCASE / Mixed forms also throw', () => {
    const forbiddenVariants = [
      'PRESCRIPTION',
      'Prescription',
      'CHATBOT',
      'ChatBot',
      'CUSTOMER',
      'HEROS',
      'Heros',
      'AI_MODE_1',
      'AI_MODE_2',
    ];
    for (const term of forbiddenVariants) {
      expect(() => assertCanonicalTerm(term)).toThrow(GlossaryViolationError);
    }
  });

  it('passes through canonical replacements', () => {
    const canonical = [
      'medication_request',
      'conversational_assistant',
      'protocol_execution',
      'tenant',
      'Telecheck-US',
      'Telecheck-Ghana',
    ];
    for (const term of canonical) {
      expect(() => assertCanonicalTerm(term)).not.toThrow();
    }
  });

  it('passes through arbitrary non-forbidden strings', () => {
    expect(() => assertCanonicalTerm('hello')).not.toThrow();
    expect(() => assertCanonicalTerm('foo_bar')).not.toThrow();
    expect(() => assertCanonicalTerm('')).not.toThrow();
  });

  it('error message includes the optional context when provided', () => {
    try {
      assertCanonicalTerm('prescription', 'forms_template.field_label');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GlossaryViolationError);
      const e = err as GlossaryViolationError;
      expect(e.message).toMatch(/forms_template\.field_label/);
      expect(e.message).toMatch(/Forbidden alias/);
    }
  });

  it('error message cites Contracts Pack v5.2 GLOSSARY for replacement guidance', () => {
    try {
      assertCanonicalTerm('chatbot');
      expect.fail('expected throw');
    } catch (err) {
      const e = err as GlossaryViolationError;
      expect(e.message).toMatch(/Contracts Pack v5\.2 GLOSSARY/);
    }
  });

  it('PINS that "tenant" is canonical (not flagged as forbidden customer-replacement)', () => {
    // The whole point of the canonical/forbidden split — anything in the
    // target column passes. If "tenant" ever lands in the FORBIDDEN_RUNTIME_ALIASES
    // set by mistake, this test trips loudly.
    expect(() => assertCanonicalTerm('tenant')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. isTenantIdFormat — non-throwing predicate
// ---------------------------------------------------------------------------

describe('isTenantIdFormat — non-throwing format predicate', () => {
  it('returns true for canonical Telecheck-{Country} formats', () => {
    expect(isTenantIdFormat('Telecheck-US')).toBe(true);
    expect(isTenantIdFormat('Telecheck-Ghana')).toBe(true);
    expect(isTenantIdFormat('Telecheck-Test')).toBe(true);
  });

  it('returns false for non-matching formats', () => {
    expect(isTenantIdFormat('telecheck-us')).toBe(false);
    expect(isTenantIdFormat('Telecheck-')).toBe(false);
    expect(isTenantIdFormat('Telecheck-1US')).toBe(false);
    expect(isTenantIdFormat('Telecheck-U')).toBe(false);
    expect(isTenantIdFormat('')).toBe(false);
  });

  // SPEC ISSUE candidate / current-behavior pin:
  // isTenantIdFormat is FORMAT-ONLY. It does NOT check the additional
  // forbidden-alias guard that asTenantId enforces (bare Heros / customer).
  // Strings like 'Heros-Health' return FALSE here (because they don't
  // match the regex), but for entities that DO accidentally pass the
  // regex (none today, but hypothetically), the predicate would return
  // true even if asTenantId would throw on the alias guard. Pinning this
  // distinction so callers know to prefer asTenantId for full validation.
  it('is FORMAT-only, NOT alias-aware (Heros-Health is rejected by regex anyway, but for documentary clarity)', () => {
    // Heros-Health doesn't match Telecheck- prefix → regex rejects.
    expect(isTenantIdFormat('Heros-Health')).toBe(false);
    // Sanity counterpart — asTenantId would also throw, by both gates.
    expect(() => asTenantId('Heros-Health')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. GlossaryViolationError — class identity discipline
// ---------------------------------------------------------------------------

describe('GlossaryViolationError — class identity discipline', () => {
  it('has name === "GlossaryViolationError"', () => {
    try {
      asTenantId('Heros');
      expect.fail('expected throw');
    } catch (err) {
      expect((err as Error).name).toBe('GlossaryViolationError');
    }
  });

  it('is instanceof GlossaryViolationError AND of generic Error', () => {
    try {
      asTenantId('Heros');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GlossaryViolationError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('message is prefixed with "Glossary violation [I-014]"', () => {
    try {
      assertCanonicalTerm('chatbot');
      expect.fail('expected throw');
    } catch (err) {
      const e = err as GlossaryViolationError;
      expect(e.message.startsWith('Glossary violation [I-014]')).toBe(true);
    }
  });

  it('message includes the offending term verbatim', () => {
    try {
      assertCanonicalTerm('PRESCRIPTION');
      expect.fail('expected throw');
    } catch (err) {
      const e = err as GlossaryViolationError;
      // Term is preserved as-passed (uppercase here, not lowercased)
      expect(e.message).toMatch(/PRESCRIPTION/);
    }
  });
});
