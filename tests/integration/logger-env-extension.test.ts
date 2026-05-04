/**
 * Logger LOG_REDACT_PATHS env-extension contract — focused test.
 *
 * Closes a specific gap raised by Codex r0 on the logger redaction batch
 * (commit f0fcb25): the original test file proved the env-extension
 * contract via a HELPER (`buildLoggerWithCapture(cap, extraPaths)`) that
 * hard-coded the union semantics (`new Set([...ALWAYS_REDACTED, ...extraPaths])`).
 * That validated the test helper, not the production code: a regression
 * in `src/lib/logger.ts` that read `config.logRedactPaths` as a
 * REPLACEMENT for `ALWAYS_REDACTED` (instead of a union extension)
 * could have passed because the test never set the env var and observed
 * the real logger under that configuration.
 *
 * The verify-r1 commit (dbc90c3) closed the bulk of that finding by
 * exercising `buildPinoOptions()` directly, but it did NOT test that
 * the LOG_REDACT_PATHS env var actually flows through `config.ts` →
 * `buildPinoOptions().redact.paths` → the singleton at module-load
 * time. This file fills that gap end-to-end:
 *
 *   1. Stub `process.env.LOG_REDACT_PATHS` with a comma-separated
 *      list of custom paths.
 *   2. Reset the module cache so config.ts + logger.ts re-evaluate.
 *   3. Dynamically import logger.ts.
 *   4. Assert the freshly-loaded `buildPinoOptions().redact.paths`
 *      includes BOTH the env-extended paths AND the canonical
 *      `ALWAYS_REDACTED` floor.
 *   5. Cleanup with `vi.unstubAllEnvs()` + `vi.resetModules()` so
 *      subsequent tests see the unmodified logger.
 *
 * Why a separate test file:
 *   `vi.resetModules()` only affects subsequent dynamic imports. The
 *   existing logger.test.ts has STATIC top-of-file imports of the
 *   logger singleton; mixing module-cache reset behaviour into that
 *   file would risk poisoning its other tests' references. Isolating
 *   env-extension into its own file keeps the two coverage paths
 *   independent.
 *
 * Spec references:
 *   - I-014 (canonical vocabulary — extension paths must NOT replace
 *     the documented floor; doing so would silently drop
 *     credential/PHI redaction).
 *   - logger.ts ALWAYS_REDACTED contract: the env var is ADDITIVE.
 */

import { Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helper — load a fresh `logger.ts` after env var is stubbed
// ---------------------------------------------------------------------------

interface FreshLoggerModule {
  ALWAYS_REDACTED: readonly string[];
  buildPinoOptions: () => { redact?: { paths?: string[]; remove?: boolean } } & Record<
    string,
    unknown
  >;
}

/**
 * Force-reload `src/lib/logger.ts` (and the `src/lib/config.ts` it
 * transitively depends on) so the freshly-loaded module re-reads
 * `process.env.LOG_REDACT_PATHS`. The static imports at the top of
 * this test file are NOT affected — only the dynamic import inside
 * the test sees the reset modules.
 */
async function loadFreshLogger(): Promise<FreshLoggerModule> {
  vi.resetModules();
  return (await import('../../src/lib/logger.ts')) as unknown as FreshLoggerModule;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  // Always restore env + reset modules + clear mocks so subsequent
  // tests (in any file) see an unstubbed environment, the canonical
  // singleton, and the unmocked pino default export.
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock('pino');
});

// ---------------------------------------------------------------------------
// 1. Custom env paths flow through to redact.paths (additive contract)
// ---------------------------------------------------------------------------

describe('LOG_REDACT_PATHS env-extension — additive contract', () => {
  it('paths from LOG_REDACT_PATHS appear in buildPinoOptions().redact.paths', async () => {
    vi.stubEnv('LOG_REDACT_PATHS', 'ctx.tenant_secret,operations.internal_token');
    const fresh = await loadFreshLogger();
    const opts = fresh.buildPinoOptions();
    const redactPaths = (opts.redact as { paths: string[] }).paths;
    expect(redactPaths).toContain('ctx.tenant_secret');
    expect(redactPaths).toContain('operations.internal_token');
  });

  it('floor (ALWAYS_REDACTED) entries STILL appear when env var is set (extension, not replacement)', async () => {
    vi.stubEnv('LOG_REDACT_PATHS', 'ctx.tenant_secret');
    const fresh = await loadFreshLogger();
    const opts = fresh.buildPinoOptions();
    const redactPaths = (opts.redact as { paths: string[] }).paths;
    // Every floor entry MUST still be in resolved paths. A regression
    // that read logRedactPaths as REPLACEMENT for ALWAYS_REDACTED
    // would silently drop credential paths and pass the previous test
    // above; this assertion is what closes that gap.
    for (const floorPath of fresh.ALWAYS_REDACTED) {
      expect(redactPaths).toContain(floorPath);
    }
  });

  it('redact.remove === true is preserved when env var is set (semantic unchanged)', async () => {
    vi.stubEnv('LOG_REDACT_PATHS', 'ctx.tenant_secret');
    const fresh = await loadFreshLogger();
    const opts = fresh.buildPinoOptions();
    const redact = opts.redact as { remove: boolean };
    expect(redact.remove).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Env var parsing edge cases
// ---------------------------------------------------------------------------

describe('LOG_REDACT_PATHS env-extension — parsing edge cases', () => {
  it('empty env var yields no extension (resolved paths == ALWAYS_REDACTED only)', async () => {
    vi.stubEnv('LOG_REDACT_PATHS', '');
    const fresh = await loadFreshLogger();
    const opts = fresh.buildPinoOptions();
    const redactPaths = (opts.redact as { paths: string[] }).paths;
    // Floor is exhaustive when env var is empty.
    for (const floorPath of fresh.ALWAYS_REDACTED) {
      expect(redactPaths).toContain(floorPath);
    }
    // Resolved length == floor length (no extras).
    expect(redactPaths).toHaveLength(fresh.ALWAYS_REDACTED.length);
  });

  it('whitespace around comma-separated entries is trimmed', async () => {
    // The Zod transform in config.ts trims whitespace and filters
    // empty strings. Pin that the trim happens (a regression that
    // emitted `' ctx.foo'` with a leading space would silently fail
    // pino's path matching since pino expects exact dot-paths).
    vi.stubEnv('LOG_REDACT_PATHS', '  ctx.foo  ,   ctx.bar  ');
    const fresh = await loadFreshLogger();
    const opts = fresh.buildPinoOptions();
    const redactPaths = (opts.redact as { paths: string[] }).paths;
    expect(redactPaths).toContain('ctx.foo');
    expect(redactPaths).toContain('ctx.bar');
    // No leading/trailing whitespace versions present.
    expect(redactPaths).not.toContain(' ctx.foo ');
    expect(redactPaths).not.toContain('  ctx.foo  ');
  });

  it('empty entries between commas are dropped', async () => {
    // Defense against a malformed env var like 'a,,b' where the
    // empty middle entry should NOT become a path. Pino with an
    // empty-string path could crash or match unexpectedly.
    vi.stubEnv('LOG_REDACT_PATHS', 'ctx.first,,ctx.second,');
    const fresh = await loadFreshLogger();
    const opts = fresh.buildPinoOptions();
    const redactPaths = (opts.redact as { paths: string[] }).paths;
    expect(redactPaths).toContain('ctx.first');
    expect(redactPaths).toContain('ctx.second');
    expect(redactPaths).not.toContain('');
  });

  it('duplicate paths between env var and floor are deduplicated', async () => {
    // The floor includes 'req.body.password'. If a deployer's env
    // includes the same path again, the union should deduplicate
    // (otherwise pino would warn or behave unpredictably).
    vi.stubEnv('LOG_REDACT_PATHS', 'req.body.password,ctx.something_new');
    const fresh = await loadFreshLogger();
    const opts = fresh.buildPinoOptions();
    const redactPaths = (opts.redact as { paths: string[] }).paths;
    const passwordCount = redactPaths.filter((p) => p === 'req.body.password').length;
    expect(passwordCount).toBe(1);
    expect(redactPaths).toContain('ctx.something_new');
  });
});

// ---------------------------------------------------------------------------
// 3. End-to-end: env-extended paths actually redact at runtime
// ---------------------------------------------------------------------------

describe('LOG_REDACT_PATHS env-extension — end-to-end redaction', () => {
  it('a path added via LOG_REDACT_PATHS is actually redacted from emitted log lines', async () => {
    vi.stubEnv('LOG_REDACT_PATHS', 'ctx.deployment_secret');
    const fresh = await loadFreshLogger();

    // Build a pino logger with the freshly-loaded production options +
    // a captured destination.
    const { default: pino } = await import('pino');
    const buf: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer | string, _enc, cb): void {
        buf.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        cb();
      },
    });
    const opts = fresh.buildPinoOptions();
    const { transport: _ignore, ...optionsWithoutTransport } = opts as Record<string, unknown>;
    const log = pino(optionsWithoutTransport, stream);

    // Log a payload with the env-extended path populated. The path
    // MUST be redacted (field gone, value not in serialized line).
    const secretMarker = 'env-extension-leak-marker-DO-NOT-LOG';
    log.info({ ctx: { deployment_secret: secretMarker } }, 'env-extension-test');

    expect(buf.length).toBeGreaterThan(0);
    const lines = buf
      .join('')
      .split('\n')
      .filter((s) => s.length > 0);
    const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    const ctx = last['ctx'] as Record<string, unknown>;
    expect(ctx).not.toHaveProperty('deployment_secret');
    expect(JSON.stringify(last)).not.toContain(secretMarker);
  });

  it('floor entries STILL redact when env var is set (no regression on baseline)', async () => {
    // The defense-in-depth countercase to the previous test: even
    // when the env var is providing extension paths, the canonical
    // floor (e.g., req.headers.authorization) still redacts.
    vi.stubEnv('LOG_REDACT_PATHS', 'ctx.deployment_secret');
    const fresh = await loadFreshLogger();

    const { default: pino } = await import('pino');
    const buf: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer | string, _enc, cb): void {
        buf.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        cb();
      },
    });
    const opts = fresh.buildPinoOptions();
    const { transport: _ignore, ...optionsWithoutTransport } = opts as Record<string, unknown>;
    const log = pino(optionsWithoutTransport, stream);

    log.info({ req: { headers: { authorization: 'Bearer floor-still-redacts' } } }, 'floor-test');

    const lines = buf
      .join('')
      .split('\n')
      .filter((s) => s.length > 0);
    const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    expect(JSON.stringify(last)).not.toContain('Bearer floor-still-redacts');
  });
});

// ---------------------------------------------------------------------------
// 4. Singleton wiring — observe options the EXPORTED logger was built with
//    (Codex r0 MED closure 2026-05-04)
//
// The §3 end-to-end tests above build a SEPARATE pino instance from
// fresh.buildPinoOptions(). That proves the options-builder is wired
// correctly but does NOT prove the EXPORTED singleton (`logger` from
// logger.ts) was actually constructed with those same options. A
// future regression where logger.ts changes the singleton construction
// path (calls pino with different args, or builds the singleton before
// config is reloaded) would silently let production logs emit
// unredacted env-extension fields while these §3 tests still passed.
//
// To close that gap we vi.doMock('pino') with a wrapper that records
// every call to pino's default export, then dynamically import
// logger.ts so its `export const logger = pino(buildPinoOptions())`
// goes through the wrapper. The recorded options ARE what the
// singleton was constructed with, so we can assert they include both
// env-extended paths AND the canonical floor.
// ---------------------------------------------------------------------------

describe('LOG_REDACT_PATHS env-extension — singleton wiring observed', () => {
  it('singleton was constructed with options.redact.paths containing BOTH env paths and ALWAYS_REDACTED', async () => {
    // Mock pino BEFORE the dynamic import so logger.ts's
    // `pino(buildPinoOptions())` call goes through the wrapper.
    // Records the (options) arg and delegates to actual pino so the
    // singleton is still functional.
    // Pino's d.ts uses `export = pino`; vi.importActual returns the
    // module's namespace object, which under esModuleInterop is
    // sometimes the callable function and sometimes an object with
    // .default. We type the wrapper as a generic factory accepting
    // unknown args and returning unknown — the contract under test is
    // the recorded options, not pino's API surface.
    const recordedOptions: unknown[] = [];
    type PinoFactory = (opts?: unknown, dest?: unknown) => unknown;
    vi.doMock('pino', async () => {
      const actualMod: unknown = await vi.importActual('pino');
      const actualPino: PinoFactory =
        typeof actualMod === 'function'
          ? (actualMod as PinoFactory)
          : (actualMod as { default: PinoFactory }).default;
      const wrapped: PinoFactory = (opts, dest) => {
        recordedOptions.push(opts);
        if (dest === undefined) return actualPino(opts);
        return actualPino(opts, dest);
      };
      return { default: wrapped };
    });

    vi.stubEnv('LOG_REDACT_PATHS', 'ctx.singleton_secret,deep.nested_credential');

    // Dynamic import → triggers `export const logger = pino(buildPinoOptions())`
    // inside logger.ts → goes through our mocked pino wrapper.
    const fresh = await loadFreshLogger();

    // pino was called at least once during module evaluation (the
    // singleton construction). We assert the FIRST recorded call
    // received options whose redact.paths include both extension
    // paths and the canonical floor.
    expect(recordedOptions.length).toBeGreaterThan(0);
    const firstCallOpts = recordedOptions[0] as {
      redact?: { paths?: string[]; remove?: boolean };
    };
    expect(firstCallOpts.redact).toBeDefined();
    const paths = firstCallOpts.redact!.paths!;

    // Env-extended paths present.
    expect(paths).toContain('ctx.singleton_secret');
    expect(paths).toContain('deep.nested_credential');

    // EVERY canonical floor entry present (the regression-guard
    // assertion: a REPLACEMENT-not-extension regression would drop
    // these and pass the previous assertion).
    for (const floorPath of fresh.ALWAYS_REDACTED) {
      expect(paths).toContain(floorPath);
    }

    // remove: true preserved on the singleton's actual options object.
    expect(firstCallOpts.redact!.remove).toBe(true);
  });

  it('singleton-construction options match the buildPinoOptions() output verbatim (no divergence)', async () => {
    // A future regression where logger.ts builds the singleton via a
    // different code path than buildPinoOptions() would silently mean
    // the §1/§2 tests on buildPinoOptions() prove nothing about the
    // exported singleton. Pin that the call to pino() during module
    // evaluation receives the SAME options object that buildPinoOptions
    // returns — i.e., the documented wiring `logger = pino(buildPinoOptions())`
    // holds.
    const recordedOptions: unknown[] = [];
    type PinoFactory = (opts?: unknown, dest?: unknown) => unknown;
    vi.doMock('pino', async () => {
      const actualMod: unknown = await vi.importActual('pino');
      const actualPino: PinoFactory =
        typeof actualMod === 'function'
          ? (actualMod as PinoFactory)
          : (actualMod as { default: PinoFactory }).default;
      const wrapped: PinoFactory = (opts, dest) => {
        recordedOptions.push(opts);
        if (dest === undefined) return actualPino(opts);
        return actualPino(opts, dest);
      };
      return { default: wrapped };
    });

    vi.stubEnv('LOG_REDACT_PATHS', 'ctx.divergence_check');
    const fresh = await loadFreshLogger();

    // Build a control-options object via the exported builder and
    // compare its redact.paths set to what the singleton actually
    // received. They MUST be the same set (order-insensitive — pino
    // doesn't depend on path order) since the documented wiring is
    // pino(buildPinoOptions()).
    const controlOpts = fresh.buildPinoOptions();
    const controlPaths = new Set((controlOpts.redact as { paths: string[] }).paths);

    expect(recordedOptions.length).toBeGreaterThan(0);
    const singletonOpts = recordedOptions[0] as { redact: { paths: string[] } };
    const singletonPaths = new Set(singletonOpts.redact.paths);

    expect(singletonPaths).toEqual(controlPaths);
  });
});
