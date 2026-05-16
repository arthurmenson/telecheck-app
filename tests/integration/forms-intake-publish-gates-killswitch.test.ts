/**
 * Forms/Intake publish-gates bypass kill-switch — unit tests.
 *
 * Exercises the SI-011 kill-switch defense-in-depth layers 1 + 2:
 *
 *   - Layer 1: boot-hook (`assertNoPublishGateBypassAtBoot`) called from
 *     `buildApp()` BEFORE Fastify is constructed. Throws if any
 *     FORMS_PUBLISH_GATES_BYPASS or FORMS_PUBLISH_GATES_TEST_OVERRIDE_*
 *     env var is present in NODE_ENV !== 'test'.
 *   - Layer 2: runtime check (`checkPublishGateBypassAtRuntime`) called
 *     from `publishVersion()` AFTER actor resolution, BEFORE any DB
 *     read. Same predicate, caught at request time as defense-in-depth
 *     against post-boot env-var injection.
 *
 * Spec reference: docs/SI-011-Forms-Publish-Governance-Gates.md
 * §"Production environment guard (kill-switch)".
 *
 * These are PURE-FUNCTION tests — they don't need a DB or a Fastify
 * instance. The kill-switch module takes the env as a parameter so we
 * fuzz it without mutating real process.env (parallel-test safety).
 */

import { describe, expect, it } from 'vitest';

import {
  assertNoPublishGateBypassAtBoot,
  checkPublishGateBypassAtRuntime,
  FORBIDDEN_PUBLISH_GATE_BYPASS_PREFIX,
  FORBIDDEN_PUBLISH_GATE_BYPASS_VARS,
  isPublishRouteUrl,
  PUBLISH_GATES_BYPASS_IN_PRODUCTION,
  scanPublishGateBypassEnv,
} from '../../src/modules/forms-intake/internal/services/publish-gates-killswitch.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function envOf(record: Record<string, string>): NodeJS.ProcessEnv {
  return record as NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// scanPublishGateBypassEnv — pure predicate
// ---------------------------------------------------------------------------

describe('scanPublishGateBypassEnv — NODE_ENV=test is the only allow-all branch', () => {
  it('allows any FORMS_PUBLISH_GATES_BYPASS value when NODE_ENV=test', () => {
    const result = scanPublishGateBypassEnv(
      envOf({
        NODE_ENV: 'test',
        FORMS_PUBLISH_GATES_BYPASS: 'unsafe-test-only',
      }),
    );
    expect(result.mode).toBe('allowed');
  });

  it('allows any FORMS_PUBLISH_GATES_TEST_OVERRIDE_* var when NODE_ENV=test', () => {
    const result = scanPublishGateBypassEnv(
      envOf({
        NODE_ENV: 'test',
        FORMS_PUBLISH_GATES_TEST_OVERRIDE_L3_DUAL_CONTROL: '1',
        FORMS_PUBLISH_GATES_TEST_OVERRIDE_I030_ANALYSIS: '1',
        FORMS_PUBLISH_GATES_TEST_OVERRIDE_MARKETING_COPY: '1',
        FORMS_PUBLISH_GATES_TEST_OVERRIDE_MODE_2_CONTRACT: '1',
      }),
    );
    expect(result.mode).toBe('allowed');
  });

  it('allows the all-clear case in NODE_ENV=production', () => {
    const result = scanPublishGateBypassEnv(envOf({ NODE_ENV: 'production' }));
    expect(result.mode).toBe('allowed');
  });
});

describe('scanPublishGateBypassEnv — forbidden vars in NODE_ENV !== test', () => {
  for (const nodeEnv of ['production', 'staging', 'dev', 'development', '']) {
    it(`flags FORMS_PUBLISH_GATES_BYPASS when NODE_ENV=${nodeEnv || '(empty)'}`, () => {
      const result = scanPublishGateBypassEnv(
        envOf({
          NODE_ENV: nodeEnv,
          FORMS_PUBLISH_GATES_BYPASS: 'unsafe-test-only',
        }),
      );
      expect(result.mode).toBe('forbidden');
      if (result.mode === 'forbidden') {
        expect(result.forbiddenVars).toEqual(['FORMS_PUBLISH_GATES_BYPASS']);
        expect(result.nodeEnv).toBe(nodeEnv);
      }
    });
  }

  it('flags FORMS_PUBLISH_GATES_BYPASS in the absence of NODE_ENV (unset)', () => {
    const result = scanPublishGateBypassEnv(
      envOf({
        FORMS_PUBLISH_GATES_BYPASS: 'unsafe-test-only',
      }),
    );
    expect(result.mode).toBe('forbidden');
    if (result.mode === 'forbidden') {
      expect(result.nodeEnv).toBeUndefined();
    }
  });

  it('flags FORMS_PUBLISH_GATES_BYPASS regardless of its VALUE (presence is the predicate)', () => {
    for (const val of ['', 'true', 'false', '0', 'anything', 'unsafe-test-only']) {
      const result = scanPublishGateBypassEnv(
        envOf({ NODE_ENV: 'production', FORMS_PUBLISH_GATES_BYPASS: val }),
      );
      expect(result.mode).toBe('forbidden');
    }
  });

  it('flags every enumerated FORMS_PUBLISH_GATES_TEST_OVERRIDE_*', () => {
    for (const name of FORBIDDEN_PUBLISH_GATE_BYPASS_VARS) {
      const result = scanPublishGateBypassEnv(envOf({ NODE_ENV: 'production', [name]: '1' }));
      expect(result.mode).toBe('forbidden');
      if (result.mode === 'forbidden') {
        expect(result.forbiddenVars).toContain(name);
      }
    }
  });

  it('flags FUTURE prefix-matched vars NOT in the enumerated list (deny-list glob)', () => {
    // A future per-gate override not yet enumerated must still fail closed.
    const futureName = `${FORBIDDEN_PUBLISH_GATE_BYPASS_PREFIX}FUTURE_GATE_X`;
    const result = scanPublishGateBypassEnv(envOf({ NODE_ENV: 'production', [futureName]: '1' }));
    expect(result.mode).toBe('forbidden');
    if (result.mode === 'forbidden') {
      expect(result.forbiddenVars).toContain(futureName);
    }
  });

  it('flags ALL forbidden vars when multiple are present (not just first)', () => {
    const result = scanPublishGateBypassEnv(
      envOf({
        NODE_ENV: 'production',
        FORMS_PUBLISH_GATES_BYPASS: '1',
        FORMS_PUBLISH_GATES_TEST_OVERRIDE_L3_DUAL_CONTROL: '1',
        FORMS_PUBLISH_GATES_TEST_OVERRIDE_FUTURE_X: '1',
      }),
    );
    expect(result.mode).toBe('forbidden');
    if (result.mode === 'forbidden') {
      // Sorted output (canonicalized).
      expect(result.forbiddenVars).toEqual([
        'FORMS_PUBLISH_GATES_BYPASS',
        'FORMS_PUBLISH_GATES_TEST_OVERRIDE_FUTURE_X',
        'FORMS_PUBLISH_GATES_TEST_OVERRIDE_L3_DUAL_CONTROL',
      ]);
    }
  });

  it('does NOT confuse unrelated env vars that share a substring', () => {
    const result = scanPublishGateBypassEnv(
      envOf({
        NODE_ENV: 'production',
        // similarly-named but not a kill-switch var
        FORMS_PUBLISH_GATES_AUDIT_LEVEL: 'verbose',
        // unrelated app vars
        FORMS_PUBLISH_TIMEOUT_MS: '5000',
        SOME_OTHER_VAR: 'value',
      }),
    );
    expect(result.mode).toBe('allowed');
  });
});

// ---------------------------------------------------------------------------
// assertNoPublishGateBypassAtBoot — layer 1
// ---------------------------------------------------------------------------

describe('assertNoPublishGateBypassAtBoot — boot-hook guard', () => {
  it('returns without throwing when NODE_ENV=test and a bypass is set', () => {
    expect(() =>
      assertNoPublishGateBypassAtBoot(
        envOf({
          NODE_ENV: 'test',
          FORMS_PUBLISH_GATES_BYPASS: 'unsafe-test-only',
        }),
      ),
    ).not.toThrow();
  });

  it('returns without throwing in production when no bypass is set', () => {
    expect(() => assertNoPublishGateBypassAtBoot(envOf({ NODE_ENV: 'production' }))).not.toThrow();
  });

  it('throws the canonical sentinel when FORMS_PUBLISH_GATES_BYPASS is set in production', () => {
    expect(() =>
      assertNoPublishGateBypassAtBoot(
        envOf({
          NODE_ENV: 'production',
          FORMS_PUBLISH_GATES_BYPASS: 'unsafe-test-only',
        }),
      ),
    ).toThrow(PUBLISH_GATES_BYPASS_IN_PRODUCTION);
  });

  it('error message names the specific forbidden var(s) detected', () => {
    try {
      assertNoPublishGateBypassAtBoot(
        envOf({
          NODE_ENV: 'production',
          FORMS_PUBLISH_GATES_BYPASS: '1',
          FORMS_PUBLISH_GATES_TEST_OVERRIDE_L3_DUAL_CONTROL: '1',
        }),
      );
      expect.fail('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain(PUBLISH_GATES_BYPASS_IN_PRODUCTION);
      expect(msg).toContain('FORMS_PUBLISH_GATES_BYPASS');
      expect(msg).toContain('FORMS_PUBLISH_GATES_TEST_OVERRIDE_L3_DUAL_CONTROL');
      expect(msg).toContain('NODE_ENV=production');
    }
  });

  it('error message indicates (unset) when NODE_ENV is missing', () => {
    try {
      assertNoPublishGateBypassAtBoot(envOf({ FORMS_PUBLISH_GATES_BYPASS: '1' }));
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('NODE_ENV=(unset)');
    }
  });
});

// ---------------------------------------------------------------------------
// checkPublishGateBypassAtRuntime — layer 2
// ---------------------------------------------------------------------------

describe('checkPublishGateBypassAtRuntime — runtime defense-in-depth', () => {
  it('returns allowed in NODE_ENV=test even with bypass set', () => {
    const result = checkPublishGateBypassAtRuntime(
      envOf({
        NODE_ENV: 'test',
        FORMS_PUBLISH_GATES_BYPASS: 'unsafe-test-only',
      }),
    );
    expect(result.mode).toBe('allowed');
  });

  it('returns forbidden in production when bypass is set', () => {
    const result = checkPublishGateBypassAtRuntime(
      envOf({
        NODE_ENV: 'production',
        FORMS_PUBLISH_GATES_BYPASS: 'unsafe-test-only',
      }),
    );
    expect(result.mode).toBe('forbidden');
    if (result.mode === 'forbidden') {
      expect(result.forbiddenVars).toContain('FORMS_PUBLISH_GATES_BYPASS');
    }
  });

  it('is the same predicate as scanPublishGateBypassEnv (delegation contract)', () => {
    const env = envOf({
      NODE_ENV: 'staging',
      FORMS_PUBLISH_GATES_TEST_OVERRIDE_MODE_2_CONTRACT: '1',
    });
    expect(checkPublishGateBypassAtRuntime(env)).toEqual(scanPublishGateBypassEnv(env));
  });
});

// ---------------------------------------------------------------------------
// Enumerated-vars × prefix contract
// ---------------------------------------------------------------------------

describe('FORBIDDEN_PUBLISH_GATE_BYPASS_VARS — enumeration contract', () => {
  it('includes the all-gates bypass', () => {
    expect(FORBIDDEN_PUBLISH_GATE_BYPASS_VARS).toContain('FORMS_PUBLISH_GATES_BYPASS');
  });

  it("enumerates exactly the four per-gate overrides spec'd in SI-011", () => {
    const expected = [
      'FORMS_PUBLISH_GATES_TEST_OVERRIDE_L3_DUAL_CONTROL',
      'FORMS_PUBLISH_GATES_TEST_OVERRIDE_I030_ANALYSIS',
      'FORMS_PUBLISH_GATES_TEST_OVERRIDE_MARKETING_COPY',
      'FORMS_PUBLISH_GATES_TEST_OVERRIDE_MODE_2_CONTRACT',
    ];
    for (const name of expected) {
      expect(FORBIDDEN_PUBLISH_GATE_BYPASS_VARS).toContain(name);
    }
  });

  it('every per-gate override matches the prefix glob', () => {
    for (const name of FORBIDDEN_PUBLISH_GATE_BYPASS_VARS) {
      if (name === 'FORMS_PUBLISH_GATES_BYPASS') continue;
      expect(name.startsWith(FORBIDDEN_PUBLISH_GATE_BYPASS_PREFIX)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// isPublishRouteUrl — layer 2a route-scope predicate
// ---------------------------------------------------------------------------

describe('isPublishRouteUrl — publish route URL pattern matching', () => {
  it('matches the canonical publish URL shape', () => {
    expect(
      isPublishRouteUrl(
        '/v0/forms/templates/tmpl_01HV9X8K7R4T3F2Q1Z6Y5W4V3U/versions/tmpl_01HV9X8K7R4T3F2Q1Z6Y5W4V3U/publish',
      ),
    ).toBe(true);
  });

  it('matches with a trailing slash', () => {
    expect(isPublishRouteUrl('/v0/forms/templates/abc/versions/def/publish/')).toBe(true);
  });

  it('matches with a query string', () => {
    expect(isPublishRouteUrl('/v0/forms/templates/abc/versions/def/publish?dryRun=1')).toBe(true);
  });

  it('does NOT match other forms-intake routes', () => {
    const nonPublish = [
      '/v0/forms/templates',
      '/v0/forms/templates/abc',
      '/v0/forms/templates/abc/versions/def', // missing /publish suffix
      '/v0/forms/deployments',
      '/v0/forms/submissions',
      '/v0/forms/variants',
    ];
    for (const url of nonPublish) {
      expect(isPublishRouteUrl(url)).toBe(false);
    }
  });

  it('does NOT match unrelated /v0 routes', () => {
    const unrelated = [
      '/v0/identity/health',
      '/v0/pharmacy/prescriptions',
      '/v0/async-consult/consults/123/intake',
      '/health',
      '/',
    ];
    for (const url of unrelated) {
      expect(isPublishRouteUrl(url)).toBe(false);
    }
  });

  it('does NOT match URLs that share /publish elsewhere in the path', () => {
    // Defense against accidental over-matching: only the canonical
    // forms-intake publish route should fire layer 2a.
    expect(isPublishRouteUrl('/v0/forms/publish/abc')).toBe(false);
    expect(isPublishRouteUrl('/publish')).toBe(false);
    expect(isPublishRouteUrl('/v0/forms/templates/abc/publish')).toBe(false);
  });

  it('matches case-insensitively (Fastify normalizes URLs)', () => {
    expect(isPublishRouteUrl('/V0/FORMS/TEMPLATES/abc/VERSIONS/def/PUBLISH')).toBe(true);
  });
});
