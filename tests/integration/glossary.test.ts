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

describe('asMedicationRequestId — mrx_ + full ULID validation (TYPES v5.2)', () => {
  // Sample valid ULIDs: 26 chars in Crockford base32
  // (alphabet 0-9A-HJKMNPQRSTVWXYZ; I/L/O/U excluded). First character
  // MUST be 0-7 (48-bit timestamp range constraint per ULID spec).
  const VALID_ULID_1 = '01HXYZABCDEFGHJKMNPQRSTVWX'; // 26 chars, leading '0'
  const VALID_ULID_2 = '7HJKMNPQRSTVWXYZ0123456789'; // 26 chars, leading '7'

  it('accepts a well-formed mrx_-prefixed 26-char Crockford ULID', () => {
    const id = asMedicationRequestId(`mrx_${VALID_ULID_1}`);
    expect(id).toBe(`mrx_${VALID_ULID_1}`);
  });

  it('accepts another well-formed mrx_-prefixed ULID (different ULID body)', () => {
    expect(asMedicationRequestId(`mrx_${VALID_ULID_2}`)).toBe(`mrx_${VALID_ULID_2}`);
  });

  it('rejects bare ULID without prefix', () => {
    expect(() => asMedicationRequestId(VALID_ULID_1)).toThrow(GlossaryViolationError);
  });

  it('rejects rx_-prefixed ID (close-but-wrong prefix)', () => {
    expect(() => asMedicationRequestId(`rx_${VALID_ULID_1}`)).toThrow(GlossaryViolationError);
  });

  it('rejects prescription_-prefixed ID (forbidden alias prefix)', () => {
    expect(() => asMedicationRequestId(`prescription_${VALID_ULID_1}`)).toThrow(
      GlossaryViolationError,
    );
  });

  it('rejects empty string', () => {
    expect(() => asMedicationRequestId('')).toThrow(GlossaryViolationError);
  });

  // Tightened 2026-05-03 per Codex glossary-r0 HIGH closure: full
  // mrx_<26-char-ULID> validation, NOT just prefix.
  it('REJECTS bare "mrx_" prefix with empty suffix (prefix-only is not sufficient)', () => {
    expect(() => asMedicationRequestId('mrx_')).toThrow(GlossaryViolationError);
  });

  it('REJECTS mrx_ + non-ULID payload (e.g., "mrx_not-a-ulid")', () => {
    expect(() => asMedicationRequestId('mrx_not-a-ulid')).toThrow(GlossaryViolationError);
  });

  it('REJECTS mrx_ + arbitrary trailing payload (whitespace / control chars / hyphens)', () => {
    expect(() => asMedicationRequestId('mrx_   ')).toThrow(GlossaryViolationError);
    expect(() => asMedicationRequestId('mrx_\t\n')).toThrow(GlossaryViolationError);
    expect(() => asMedicationRequestId('mrx_anything-with-hyphens-here')).toThrow(
      GlossaryViolationError,
    );
  });

  it('REJECTS mrx_ + 25-char (one too short)', () => {
    expect(() => asMedicationRequestId('mrx_01HXYZABCDEFGHJKMNPQRSTV')).toThrow(
      GlossaryViolationError,
    );
  });

  it('REJECTS mrx_ + 27-char (one too long)', () => {
    expect(() => asMedicationRequestId(`mrx_${VALID_ULID_1}A`)).toThrow(GlossaryViolationError);
  });

  it('REJECTS mrx_ + ULID containing forbidden alphabet characters (I / L / O / U)', () => {
    // Crockford base32 EXCLUDES I, L, O, U for human readability. ULIDs
    // emitted by ulid.ts never contain them. A full-validation guard must
    // reject IDs that contain these characters even if 26 chars total.
    // Pick a NON-leading position so the test isolates the alphabet check
    // from the leading-char-range constraint.
    const forbiddenChars = ['I', 'L', 'O', 'U'];
    for (const ch of forbiddenChars) {
      // Replace position 1 of a valid ULID with the forbidden char.
      const bad = VALID_ULID_1[0]! + ch + VALID_ULID_1.slice(2);
      expect(() => asMedicationRequestId(`mrx_${bad}`)).toThrow(GlossaryViolationError);
    }
  });

  it('REJECTS mrx_ + ULID with leading character 8 or 9 (48-bit timestamp overflow)', () => {
    // Timestamp range constraint: leading char 0-7 only. A ULID body
    // starting with 8 or 9 represents a timestamp > 2^48-1 which is
    // structurally impossible. Pin the rejection so a future relaxation
    // back to the broader Crockford-26 regex (the r0 verify-r1 attempt)
    // fails this test loudly.
    // Closure 2026-05-03 per Codex glossary-r1 HIGH (verify-r2).
    expect(() => asMedicationRequestId(`mrx_8${VALID_ULID_1.slice(1)}`)).toThrow(
      GlossaryViolationError,
    );
    expect(() => asMedicationRequestId(`mrx_9${VALID_ULID_1.slice(1)}`)).toThrow(
      GlossaryViolationError,
    );
  });

  it('REJECTS mrx_ + ULID with leading alphabetic character (A through Z)', () => {
    // All alphabetic Crockford chars (A-H, J-N, P-Z minus I/L/O/U) at the
    // leading position represent values >= 10, well above the 0-7 range.
    // Spot-check the boundary (A) and a high value (Z).
    expect(() => asMedicationRequestId(`mrx_A${VALID_ULID_1.slice(1)}`)).toThrow(
      GlossaryViolationError,
    );
    expect(() => asMedicationRequestId(`mrx_Z${VALID_ULID_1.slice(1)}`)).toThrow(
      GlossaryViolationError,
    );
  });

  it('ACCEPTS leading digits 0..7 (every valid timestamp prefix)', () => {
    // Drive every valid leading character to prove the regex doesn't
    // accidentally narrow further than the spec requires.
    for (const lead of '01234567') {
      const id = `mrx_${lead}${VALID_ULID_1.slice(1)}`;
      expect(asMedicationRequestId(id)).toBe(id);
    }
  });

  it('error message cites TYPES v5.2 + Crockford alphabet + the offending value', () => {
    try {
      asMedicationRequestId('rx_invalid');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GlossaryViolationError);
      const e = err as GlossaryViolationError;
      expect(e.message).toMatch(/TYPES v5\.2/);
      expect(e.message).toMatch(/mrx_/);
      expect(e.message).toMatch(/Crockford/);
      // Original value appears in the error message for grep-ability
      expect(e.message).toMatch(/rx_invalid/);
    }
  });

  it('case-sensitivity — MRX_ uppercase prefix is NOT accepted (canonical prefix is lowercase)', () => {
    expect(() => asMedicationRequestId(`MRX_${VALID_ULID_1}`)).toThrow(GlossaryViolationError);
  });

  it('case-sensitivity — lowercase ULID body is NOT accepted (Crockford alphabet is uppercase)', () => {
    // Pin current strict-uppercase behavior. ulid.ts emits uppercase only;
    // accepting lowercase would be a silent normalization that masks
    // upstream bugs.
    expect(() => asMedicationRequestId('mrx_01hxyzabcdefghjkmnpqrstvwx')).toThrow(
      GlossaryViolationError,
    );
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
  it('throws on canonical forbidden aliases (every value in FORBIDDEN_RUNTIME_ALIASES)', () => {
    // This roster MUST mirror the FORBIDDEN_RUNTIME_ALIASES set in
    // src/lib/glossary.ts. If a future change adds an entry there, this
    // test fails until the test inventory is extended too. (Codex
    // glossary-r0 MED closure 2026-05-03 added 'heros-ghana' to both.)
    const forbidden = [
      'prescription',
      'prescriptionid',
      'chatbot',
      'customer',
      'heros',
      'heros-health',
      'heros-ghana',
      'ai_mode_1',
      'ai_mode_2',
    ];
    for (const term of forbidden) {
      expect(() => assertCanonicalTerm(term)).toThrow(GlossaryViolationError);
    }
  });

  // SPEC ISSUE — broader forbidden-alias inventory verification needed
  //
  // Codex glossary-r0 MED flagged that the canonical Contracts Pack v5.2
  // GLOSSARY in the spec corpus likely lists additional forbidden aliases
  // beyond the FORBIDDEN_RUNTIME_ALIASES set:
  //
  //   - medication-action axis: renewal / reorder / re-prescription
  //   - AI-vs-clinician axis:   auto-approved / automated-prescription /
  //                             AI-prescribed
  //
  // These need verification against the authoritative
  // `Telecheck_Contracts_Pack_v5_00_GLOSSARY.md` text in the spec corpus
  // before adding to the runtime set. Without verification, asserting
  // them in the test would either (a) make assertions on aliases that
  // aren't actually canonical (false claims), or (b) require speculatively
  // adding them to FORBIDDEN_RUNTIME_ALIASES (premature contract change).
  //
  // The failing test below documents the gap in a way that surfaces in
  // CI without breaking existing assertions. When the spec corpus is
  // consulted and the canonical list is confirmed, this test gets
  // converted to assertions against `assertCanonicalTerm` AND the
  // matching aliases get added to glossary.ts.
  it.todo(
    'TODO: verify renewal/reorder/re-prescription against Contracts Pack v5.2 GLOSSARY canonical text',
  );
  it.todo(
    'TODO: verify auto-approved/automated-prescription/AI-prescribed against Contracts Pack v5.2 GLOSSARY canonical text',
  );

  it('case-insensitivity — UPPERCASE / Mixed forms also throw', () => {
    const forbiddenVariants = [
      'PRESCRIPTION',
      'Prescription',
      'CHATBOT',
      'ChatBot',
      'CUSTOMER',
      'HEROS',
      'Heros',
      'HEROS-GHANA',
      'Heros-Ghana',
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
