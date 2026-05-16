/**
 * config.ts — direct integration coverage on the env-validation singleton.
 *
 * Until this commit `src/lib/config.ts` had ZERO direct test coverage.
 * Every exercise was indirect — `tests/integration/logger-env-extension.test.ts`
 * touches config to verify LOG_REDACT_PATHS, but no other test pins the
 * production-fail-closed gates, the feature-flag enforcement, the URL
 * validation, the enum bounds, or the RESUME_TOKEN_SECRET dev/test
 * deterministic-default path.
 *
 * Why this matters:
 *   `config.ts` is the single startup gate for every env-derived setting
 *   that downstream code uses. A regression that loosens validation
 *   (e.g., letting RESUME_TOKEN_SECRET=undefined slip through in
 *   production, or letting ENABLE_AUTONOMOUS_AGENT=true bypass the
 *   reject) ships a misconfigured production app — the kind of failure
 *   that doesn't surface until token-forgery or unauthorized
 *   AI-workload activation is already underway. Direct tests catch the
 *   regression at startup time, before any other module loads.
 *
 * Coverage in this file (12 sections):
 *
 *   §1 Required-var enforcement (DATABASE_URL + REDIS_URL throw on missing)
 *   §2 URL validation on DATABASE_URL / REDIS_URL
 *   §3 NODE_ENV enum validation (development/test/production only)
 *   §4 LOG_LEVEL enum validation
 *   §5 DATABASE_SSL_MODE enum validation (disable/require only)
 *   §6 PORT coercion + range
 *   §7 DB_POOL_MAX coercion + range (1..200)
 *   §8 LOG_REDACT_PATHS parsing — empty, whitespace, dedupe (parity with
 *      logger-env-extension.test.ts but probing config.logRedactPaths
 *      directly, not via pino)
 *   §9 Feature-flag enforcement — every reserved flag MUST be false at
 *      v1.0; 'true' throws with a successor-ADR-citation message
 *   §10 RESUME_TOKEN_SECRET production gate (throw on <32 chars)
 *   §11 RESUME_TOKEN_SECRET dev/test deterministic default
 *   §12 RESEARCH_DATA_PARTNERSHIP_ACTIVE enum + boolean projection
 *
 * Test pattern: stub env, reset modules, dynamic import. Same pattern
 * as `logger-env-extension.test.ts` so future maintainers have one
 * canonical reference for env-load tests.
 *
 * Spec references:
 *   - WORKLOAD_TAXONOMY v5.2 §3 (reserved flags MUST default false)
 *   - AUTONOMY_LEVELS v5.2 §3
 *   - ADR-029 (workload activation conditions)
 *   - Slice PRD v2.1 §8 (resume token HMAC; secret integrity)
 *   - I-023 (no plaintext secrets in production logs / config)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helper — load a fresh `config.ts` after env stubs are applied.
// vi.resetModules() is required because the singleton is evaluated at
// module-load time. The static imports at the top of this test file are
// NOT affected; only the dynamic import inside the test sees the stubs.
// ---------------------------------------------------------------------------

interface FreshConfigModule {
  config: {
    nodeEnv: string;
    port: number;
    logLevel: string;
    logRedactPaths: ReadonlyArray<string>;
    databaseUrl: string;
    dbPoolMax: number;
    dbSslMode: string;
    redisUrl: string;
    tenantKmsLocalDevKey?: string;
    aws: { region: string; drRegion: string; bedrockRegion: string };
    featureFlags: Readonly<Record<string, false>>;
    researchDataPartnershipActive: boolean;
    resumeTokenSecret: string;
  };
}

/**
 * The CI workflow injects DATABASE_URL + REDIS_URL + NODE_ENV at the env
 * level. Use this as the BASELINE — every test ADDS or OVERRIDES on top.
 * vi.stubEnv is per-key, so we don't need to wholesale-reset the env.
 */
function applyBaseline(): void {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgres://x:y@localhost:5432/z');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  // Match the CI workflow value so kms.ts deriveTenantKey doesn't
  // surface here; the kms test file owns that contract.
  vi.stubEnv('TENANT_KMS_LOCAL_DEV_KEY', 'dev-only-not-for-production-32-chars');
}

async function loadFreshConfig(): Promise<FreshConfigModule> {
  vi.resetModules();
  return (await import('../../src/lib/config.ts')) as unknown as FreshConfigModule;
}

/**
 * Helper for "loading config should throw" cases. The throw happens at
 * module-evaluation time, so we await the dynamic import inside an
 * `expect(...).rejects.toThrow(...)` matcher.
 */
async function expectLoadConfigToThrow(pattern: RegExp): Promise<void> {
  vi.resetModules();
  await expect(import('../../src/lib/config.ts')).rejects.toThrow(pattern);
}

/**
 * `vi.stubEnv(key, undefined)` does NOT actually unset a process.env
 * key in Vitest 2.x — it leaves the underlying env intact. CI ships
 * NODE_ENV=test, DATABASE_URL=..., REDIS_URL=..., etc. as concrete
 * values, so a "missing var" test must DELETE the key from
 * process.env directly. This helper records the original value and
 * the afterEach handler restores it.
 *
 * (Codex config-test-r0 closure 2026-05-04 — initial test version
 * relied on `vi.unstubAllEnvs()` which restores the original CI env;
 * "missing DATABASE_URL" tests passed validation against the real
 * CI value and the load-throws assertions resolved instead of
 * rejecting.)
 */
const _envSnapshots = new Map<string, string | undefined>();
function deleteEnv(key: string): void {
  if (!_envSnapshots.has(key)) {
    _envSnapshots.set(key, process.env[key]);
  }
  delete process.env[key];
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const [key, value] of _envSnapshots) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  _envSnapshots.clear();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// §1 — Required-var enforcement
// ---------------------------------------------------------------------------

describe('config — required vars', () => {
  it('§1a throws when DATABASE_URL is missing', async () => {
    deleteEnv('DATABASE_URL');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    await expectLoadConfigToThrow(/DATABASE_URL/);
  });

  it('§1b throws when REDIS_URL is missing', async () => {
    deleteEnv('REDIS_URL');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATABASE_URL', 'postgres://x:y@localhost:5432/z');
    await expectLoadConfigToThrow(/REDIS_URL/);
  });

  it('§1c throws with both DATABASE_URL and REDIS_URL absent (multi-error path)', async () => {
    deleteEnv('DATABASE_URL');
    deleteEnv('REDIS_URL');
    vi.stubEnv('NODE_ENV', 'test');
    // Aggregate Zod error contains both field names.
    await expectLoadConfigToThrow(/Configuration validation failed/);
  });
});

// ---------------------------------------------------------------------------
// §2 — URL validation on DATABASE_URL / REDIS_URL
// ---------------------------------------------------------------------------

describe('config — URL validation', () => {
  it('§2a throws on malformed DATABASE_URL (not a URL)', async () => {
    applyBaseline();
    vi.stubEnv('DATABASE_URL', 'not-a-url-at-all');
    await expectLoadConfigToThrow(/DATABASE_URL/);
  });

  it('§2b throws on malformed REDIS_URL (not a URL)', async () => {
    applyBaseline();
    vi.stubEnv('REDIS_URL', 'not-a-url-at-all');
    await expectLoadConfigToThrow(/REDIS_URL/);
  });

  it('§2c accepts a syntactically-valid postgres:// DATABASE_URL', async () => {
    applyBaseline();
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@host.example:5432/db');
    const fresh = await loadFreshConfig();
    expect(fresh.config.databaseUrl).toBe('postgres://user:pass@host.example:5432/db');
  });
});

// ---------------------------------------------------------------------------
// §3 — NODE_ENV enum
// ---------------------------------------------------------------------------

describe('config — NODE_ENV enum', () => {
  it('§3a accepts "development", "test", and "production"', async () => {
    for (const env of ['development', 'test', 'production'] as const) {
      applyBaseline();
      vi.stubEnv('NODE_ENV', env);
      // Production also requires a >=32-char RESUME_TOKEN_SECRET,
      // DATABASE_SSL_MODE=require, JWT_SIGNING_KEY, AND
      // BIND_ACTOR_CONTEXT_DATABASE_URL (SI-010 trust anchor per
      // Codex R1 closure on PR #158) to pass — each is enforced as
      // a procedural check at config-load time per the production
      // fail-closed gates.
      if (env === 'production') {
        vi.stubEnv('RESUME_TOKEN_SECRET', 'a'.repeat(40));
        vi.stubEnv('DATABASE_SSL_MODE', 'require');
        vi.stubEnv('JWT_SIGNING_KEY', 'a'.repeat(40));
        vi.stubEnv(
          'BIND_ACTOR_CONTEXT_DATABASE_URL',
          'postgres://bind_actor_context_role:x@localhost:5432/z',
        );
      }
      const fresh = await loadFreshConfig();
      expect(fresh.config.nodeEnv).toBe(env);
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('§3b rejects an invalid NODE_ENV value (e.g., "staging")', async () => {
    applyBaseline();
    vi.stubEnv('NODE_ENV', 'staging');
    await expectLoadConfigToThrow(/NODE_ENV/);
  });

  it('§3c defaults NODE_ENV to "development" when unset', async () => {
    deleteEnv('NODE_ENV');
    vi.stubEnv('DATABASE_URL', 'postgres://x:y@localhost:5432/z');
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    const fresh = await loadFreshConfig();
    expect(fresh.config.nodeEnv).toBe('development');
  });
});

// ---------------------------------------------------------------------------
// §4 — LOG_LEVEL enum
// ---------------------------------------------------------------------------

describe('config — LOG_LEVEL enum', () => {
  it('§4a accepts every documented level', async () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
      applyBaseline();
      vi.stubEnv('LOG_LEVEL', level);
      const fresh = await loadFreshConfig();
      expect(fresh.config.logLevel).toBe(level);
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('§4b rejects an invalid log level', async () => {
    applyBaseline();
    vi.stubEnv('LOG_LEVEL', 'verbose-not-a-pino-level');
    await expectLoadConfigToThrow(/LOG_LEVEL/);
  });

  it('§4c defaults LOG_LEVEL to "info" when unset', async () => {
    applyBaseline();
    // No LOG_LEVEL stub.
    const fresh = await loadFreshConfig();
    expect(fresh.config.logLevel).toBe('info');
  });
});

// ---------------------------------------------------------------------------
// §5 — DATABASE_SSL_MODE enum
// ---------------------------------------------------------------------------

describe('config — DATABASE_SSL_MODE enum', () => {
  it('§5a accepts "disable"', async () => {
    applyBaseline();
    vi.stubEnv('DATABASE_SSL_MODE', 'disable');
    const fresh = await loadFreshConfig();
    expect(fresh.config.dbSslMode).toBe('disable');
  });

  it('§5b accepts "require"', async () => {
    applyBaseline();
    vi.stubEnv('DATABASE_SSL_MODE', 'require');
    const fresh = await loadFreshConfig();
    expect(fresh.config.dbSslMode).toBe('require');
  });

  it('§5c rejects "verify-full" (per the schema, that\'s a connection-string concern)', async () => {
    applyBaseline();
    vi.stubEnv('DATABASE_SSL_MODE', 'verify-full');
    await expectLoadConfigToThrow(/DATABASE_SSL_MODE/);
  });

  it('§5d defaults DATABASE_SSL_MODE to "disable" when unset', async () => {
    applyBaseline();
    const fresh = await loadFreshConfig();
    expect(fresh.config.dbSslMode).toBe('disable');
  });

  // §5e..§5g — production fail-closed gate. Codex config-test-r1 HIGH
  // closure 2026-05-04: the prior coverage left the production-DB-SSL
  // boundary unenforced — `DATABASE_SSL_MODE` was a generic enum without
  // a NODE_ENV cross-field invariant. A production deploy with the env
  // unset (default 'disable') would start with unencrypted DB transport
  // and CI would stay green. Now enforced + tested.

  it('§5e production + DATABASE_SSL_MODE unset (defaults disable) → throws', async () => {
    applyBaseline();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('RESUME_TOKEN_SECRET', 'a'.repeat(40));
    // Don't stub DATABASE_SSL_MODE — defaults to 'disable'.
    await expectLoadConfigToThrow(/DATABASE_SSL_MODE.*production/);
  });

  it('§5f production + DATABASE_SSL_MODE=disable (explicit) → throws', async () => {
    applyBaseline();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('RESUME_TOKEN_SECRET', 'a'.repeat(40));
    vi.stubEnv('DATABASE_SSL_MODE', 'disable');
    await expectLoadConfigToThrow(/DATABASE_SSL_MODE.*production/);
  });

  it('§5g production + DATABASE_SSL_MODE=require → accepted', async () => {
    applyBaseline();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('RESUME_TOKEN_SECRET', 'a'.repeat(40));
    vi.stubEnv('DATABASE_SSL_MODE', 'require');
    vi.stubEnv('JWT_SIGNING_KEY', 'a'.repeat(40));
    vi.stubEnv(
      'BIND_ACTOR_CONTEXT_DATABASE_URL',
      'postgres://bind_actor_context_role:x@localhost:5432/z',
    );
    const fresh = await loadFreshConfig();
    expect(fresh.config.dbSslMode).toBe('require');
    expect(fresh.config.nodeEnv).toBe('production');
  });

  it('§5h non-production + DATABASE_SSL_MODE=disable → accepted (dev/test parity)', async () => {
    // Pin that the production-only enforcement does NOT extend to
    // dev/test — those environments commonly run against a Postgres
    // service without TLS termination.
    for (const env of ['development', 'test'] as const) {
      applyBaseline();
      vi.stubEnv('NODE_ENV', env);
      vi.stubEnv('DATABASE_SSL_MODE', 'disable');
      const fresh = await loadFreshConfig();
      expect(fresh.config.dbSslMode).toBe('disable');
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

// ---------------------------------------------------------------------------
// §6 — PORT coercion + range
// ---------------------------------------------------------------------------

describe('config — PORT', () => {
  it('§6a coerces string "8080" to number 8080', async () => {
    applyBaseline();
    vi.stubEnv('PORT', '8080');
    const fresh = await loadFreshConfig();
    expect(fresh.config.port).toBe(8080);
  });

  it('§6b defaults to 3000', async () => {
    applyBaseline();
    const fresh = await loadFreshConfig();
    expect(fresh.config.port).toBe(3000);
  });

  it('§6c rejects negative port', async () => {
    applyBaseline();
    vi.stubEnv('PORT', '-1');
    await expectLoadConfigToThrow(/PORT/);
  });

  it('§6d rejects zero port', async () => {
    applyBaseline();
    vi.stubEnv('PORT', '0');
    await expectLoadConfigToThrow(/PORT/);
  });

  it('§6e rejects non-numeric port', async () => {
    applyBaseline();
    vi.stubEnv('PORT', 'eighty-eighty');
    await expectLoadConfigToThrow(/PORT/);
  });
});

// ---------------------------------------------------------------------------
// §7 — DB_POOL_MAX coercion + range
// ---------------------------------------------------------------------------

describe('config — DB_POOL_MAX', () => {
  it('§7a coerces "20" to number 20', async () => {
    applyBaseline();
    vi.stubEnv('DB_POOL_MAX', '20');
    const fresh = await loadFreshConfig();
    expect(fresh.config.dbPoolMax).toBe(20);
  });

  it('§7b defaults to 10', async () => {
    applyBaseline();
    const fresh = await loadFreshConfig();
    expect(fresh.config.dbPoolMax).toBe(10);
  });

  it('§7c rejects 0 (below min=1)', async () => {
    applyBaseline();
    vi.stubEnv('DB_POOL_MAX', '0');
    await expectLoadConfigToThrow(/DB_POOL_MAX/);
  });

  it('§7d rejects 201 (above max=200)', async () => {
    applyBaseline();
    vi.stubEnv('DB_POOL_MAX', '201');
    await expectLoadConfigToThrow(/DB_POOL_MAX/);
  });
});

// ---------------------------------------------------------------------------
// §8 — LOG_REDACT_PATHS parsing
// ---------------------------------------------------------------------------

describe('config — LOG_REDACT_PATHS parsing', () => {
  it('§8a empty/unset → empty array', async () => {
    applyBaseline();
    const fresh = await loadFreshConfig();
    expect(fresh.config.logRedactPaths).toEqual([]);
  });

  it('§8b single-path env → single-element array', async () => {
    applyBaseline();
    vi.stubEnv('LOG_REDACT_PATHS', 'ctx.tenant_secret');
    const fresh = await loadFreshConfig();
    expect(fresh.config.logRedactPaths).toEqual(['ctx.tenant_secret']);
  });

  it('§8c whitespace around comma entries is trimmed', async () => {
    applyBaseline();
    vi.stubEnv('LOG_REDACT_PATHS', '  a.b  ,   c.d  ,e.f');
    const fresh = await loadFreshConfig();
    expect(fresh.config.logRedactPaths).toEqual(['a.b', 'c.d', 'e.f']);
  });

  it('§8d empty entries between commas are filtered out', async () => {
    applyBaseline();
    vi.stubEnv('LOG_REDACT_PATHS', 'a,,b,,c,');
    const fresh = await loadFreshConfig();
    expect(fresh.config.logRedactPaths).toEqual(['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// §9 — Feature-flag enforcement (reserved flags MUST be false)
// ---------------------------------------------------------------------------

describe('config — feature-flag enforcement (WORKLOAD_TAXONOMY + AUTONOMY_LEVELS reserved)', () => {
  const RESERVED_FLAGS = [
    'ENABLE_AUTONOMOUS_AGENT',
    'ENABLE_MULTI_AGENT_SUPERVISOR',
    'ENABLE_TOOL_USING_AGENT',
    'ENABLE_ACTION_WITH_AUDIT_ONLY',
    'ENABLE_FULLY_AUTONOMOUS',
  ] as const;

  for (const flag of RESERVED_FLAGS) {
    it(`§9 ${flag}=true throws with successor-ADR citation`, async () => {
      applyBaseline();
      vi.stubEnv(flag, 'true');
      // Each flag's error message names a different successor-ADR
      // requirement; the umbrella regex catches the canonical
      // "Feature flag validation failed" header from config.ts.
      await expectLoadConfigToThrow(
        /Feature flag validation failed|requires ADR-030|requires ADR-031|requires ADR-033|successor invariant/,
      );
    });
  }

  it('§9 every reserved flag DEFAULTS to false (unset → false)', async () => {
    applyBaseline();
    const fresh = await loadFreshConfig();
    for (const flag of RESERVED_FLAGS) {
      expect(fresh.config.featureFlags[flag]).toBe(false);
    }
  });

  it('§9 every reserved flag explicitly set to "false" passes (not just absence)', async () => {
    applyBaseline();
    for (const flag of RESERVED_FLAGS) {
      vi.stubEnv(flag, 'false');
    }
    const fresh = await loadFreshConfig();
    for (const flag of RESERVED_FLAGS) {
      expect(fresh.config.featureFlags[flag]).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// §10 — RESUME_TOKEN_SECRET production gate
// ---------------------------------------------------------------------------

describe('config — RESUME_TOKEN_SECRET production gate', () => {
  it('§10a production + missing secret → throws', async () => {
    applyBaseline();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_SSL_MODE', 'require');
    // EXPLICITLY delete RESUME_TOKEN_SECRET from process.env. CI doesn't
    // set it, but a developer shell or future CI might inject it; without
    // deleteEnv this test would pass for ambient reasons rather than for
    // product behavior. Codex config-test-r1 MED closure 2026-05-04.
    deleteEnv('RESUME_TOKEN_SECRET');
    await expectLoadConfigToThrow(/RESUME_TOKEN_SECRET/);
  });

  it('§10b production + 31-char secret → throws (boundary)', async () => {
    applyBaseline();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_SSL_MODE', 'require');
    vi.stubEnv('RESUME_TOKEN_SECRET', 'a'.repeat(31));
    await expectLoadConfigToThrow(/RESUME_TOKEN_SECRET.*at least 32/);
  });

  it('§10c production + 32-char secret → accepted (boundary)', async () => {
    applyBaseline();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_SSL_MODE', 'require');
    vi.stubEnv('RESUME_TOKEN_SECRET', 'a'.repeat(32));
    vi.stubEnv('JWT_SIGNING_KEY', 'a'.repeat(40));
    vi.stubEnv(
      'BIND_ACTOR_CONTEXT_DATABASE_URL',
      'postgres://bind_actor_context_role:x@localhost:5432/z',
    );
    const fresh = await loadFreshConfig();
    expect(fresh.config.resumeTokenSecret).toBe('a'.repeat(32));
  });

  it('§10d production + long secret → accepted, value preserved', async () => {
    applyBaseline();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_SSL_MODE', 'require');
    vi.stubEnv('RESUME_TOKEN_SECRET', 'a'.repeat(64));
    vi.stubEnv('JWT_SIGNING_KEY', 'a'.repeat(40));
    vi.stubEnv(
      'BIND_ACTOR_CONTEXT_DATABASE_URL',
      'postgres://bind_actor_context_role:x@localhost:5432/z',
    );
    const fresh = await loadFreshConfig();
    expect(fresh.config.resumeTokenSecret.length).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// §11 — RESUME_TOKEN_SECRET dev/test deterministic default
// ---------------------------------------------------------------------------

describe('config — RESUME_TOKEN_SECRET dev/test default', () => {
  it('§11a development + missing secret → deterministic default applied', async () => {
    applyBaseline();
    vi.stubEnv('NODE_ENV', 'development');
    // Same deleteEnv discipline as §10a — the default-applied branch must
    // be entered ONLY when the env genuinely lacks the secret, not because
    // CI happens not to set it.
    deleteEnv('RESUME_TOKEN_SECRET');
    const fresh = await loadFreshConfig();
    // The default is documented in config.ts; pin the exact value so a
    // future change requires explicit acknowledgement (the dev/test
    // suite re-issues + verifies tokens with this seed).
    expect(fresh.config.resumeTokenSecret).toBe(
      'dev-resume-token-secret-not-for-production-use-32chars-min-padding-padding',
    );
  });

  it('§11b test + missing secret → deterministic default applied', async () => {
    applyBaseline(); // NODE_ENV=test
    deleteEnv('RESUME_TOKEN_SECRET');
    const fresh = await loadFreshConfig();
    expect(fresh.config.resumeTokenSecret.length).toBeGreaterThanOrEqual(32);
  });

  it('§11c development + custom secret → custom value preserved', async () => {
    applyBaseline();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RESUME_TOKEN_SECRET', 'custom-dev-secret-' + 'x'.repeat(20));
    const fresh = await loadFreshConfig();
    expect(fresh.config.resumeTokenSecret).toBe('custom-dev-secret-' + 'x'.repeat(20));
  });
});

// ---------------------------------------------------------------------------
// §12 — RESEARCH_DATA_PARTNERSHIP_ACTIVE
// ---------------------------------------------------------------------------

describe('config — RESEARCH_DATA_PARTNERSHIP_ACTIVE', () => {
  it('§12a "active" → true', async () => {
    applyBaseline();
    vi.stubEnv('RESEARCH_DATA_PARTNERSHIP_ACTIVE', 'active');
    const fresh = await loadFreshConfig();
    expect(fresh.config.researchDataPartnershipActive).toBe(true);
  });

  it('§12b "inactive" → false', async () => {
    applyBaseline();
    vi.stubEnv('RESEARCH_DATA_PARTNERSHIP_ACTIVE', 'inactive');
    const fresh = await loadFreshConfig();
    expect(fresh.config.researchDataPartnershipActive).toBe(false);
  });

  it('§12c default (unset) → false (Stage 2 gate is closed by default)', async () => {
    applyBaseline();
    const fresh = await loadFreshConfig();
    expect(fresh.config.researchDataPartnershipActive).toBe(false);
  });

  it('§12d invalid value (e.g., "yes") → throws', async () => {
    applyBaseline();
    vi.stubEnv('RESEARCH_DATA_PARTNERSHIP_ACTIVE', 'yes');
    await expectLoadConfigToThrow(/RESEARCH_DATA_PARTNERSHIP_ACTIVE/);
  });
});

// ---------------------------------------------------------------------------
// §13 — AWS region defaults (ADR-026)
// ---------------------------------------------------------------------------

describe('config — AWS region defaults (ADR-026 us-east-1 primary)', () => {
  it('§13a defaults AWS_REGION to "us-east-1"', async () => {
    applyBaseline();
    const fresh = await loadFreshConfig();
    expect(fresh.config.aws.region).toBe('us-east-1');
  });

  it('§13b defaults AWS_DR_REGION to "us-west-2"', async () => {
    applyBaseline();
    const fresh = await loadFreshConfig();
    expect(fresh.config.aws.drRegion).toBe('us-west-2');
  });

  it('§13c custom AWS_REGION is respected', async () => {
    applyBaseline();
    vi.stubEnv('AWS_REGION', 'eu-west-1');
    const fresh = await loadFreshConfig();
    expect(fresh.config.aws.region).toBe('eu-west-1');
  });
});
