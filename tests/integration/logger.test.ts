/**
 * Logger PHI redaction — direct integration tests.
 *
 * Covers `src/lib/logger.ts` (`logger`, `createChildLogger`,
 * `ALWAYS_REDACTED`, `buildPinoOptions`). Until this commit had only
 * indirect mentions in other tests and ZERO direct coverage of the
 * redaction-floor contract.
 *
 * Why this matters:
 *   `ALWAYS_REDACTED` is the LAST defense for PHI escaping into
 *   centralized log aggregators. A regression that drops `*.ssn`,
 *   `*.medical_record_number`, or any other path on the floor list is a
 *   HIPAA-relevant incident — once log lines reach a third-party
 *   aggregator, the only recovery is auditing every consumer of those
 *   logs. The redaction MUST be active by default and MUST NOT be
 *   disable-able via config (the env-var only EXTENDS the floor; it
 *   cannot remove a floor entry).
 *
 * Coverage in this file:
 *   1. ALWAYS_REDACTED contract pin — required paths present, count
 *      floor, no duplicates.
 *   2. PRODUCTION WIRING via `buildPinoOptions()` — directly asserts
 *      that the options the singleton was constructed with carry the
 *      full union (ALWAYS_REDACTED ∪ config.logRedactPaths), that
 *      `remove: true` is active, and that the singleton's options
 *      object reflects what's exported. (Codex r0 closure: previous
 *      version only asserted parallel-pino behavior.)
 *   3. Redaction behavior end-to-end — using the SAME options object
 *      that built the singleton, route a fresh pino instance to a
 *      captured stream and verify each floor path actually redacts.
 *   4. Wildcard depth coverage (root + 1/2/3-deep) — each PHI field is
 *      enumerated at depths 0..3 in `ALWAYS_REDACTED` because pino's
 *      `fast-redact` doesn't support recursive `**` patterns. Tests
 *      verify each documented depth redacts; depth >= 4 is intentionally
 *      out of scope and pinned as such.
 *   5. createChildLogger — children inherit the parent's redaction
 *      paths (parallel-logger demonstration via pino's `child()`).
 *   6. Bindings — child loggers carry the bound context fields on every
 *      emitted line.
 *   7. Singleton sanity — the exported `logger` exists and has pino's
 *      standard methods. (The redact-symbol probe from r0 is demoted
 *      to optional diagnostic per Codex r0 LOW.)
 *
 * Spec references:
 *   - AUDIT_EVENTS v5.2 PHI handling discipline (no PHI in app logs).
 *   - I-003 (audit append-only — application logs are NOT the audit
 *     trail; they MUST not contain PHI that the audit chain holds
 *     under tenant_id-scoped controls).
 *   - I-023 (tenant isolation — log aggregators are cross-tenant by
 *     definition; redaction prevents accidental tenant cross-
 *     contamination there).
 */

import { Writable } from 'node:stream';

import pino, { type Logger } from 'pino';
import { describe, expect, it } from 'vitest';

import { config } from '../../src/lib/config.ts';
import {
  ALWAYS_REDACTED,
  buildPinoOptions,
  createChildLogger,
  logger as singletonLogger,
} from '../../src/lib/logger.ts';

// ---------------------------------------------------------------------------
// Capture helper — pipe pino output to an in-memory buffer
// ---------------------------------------------------------------------------

interface Capture {
  buf: string[];
  stream: Writable;
}

function makeCapture(): Capture {
  const buf: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      buf.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
  return { buf, stream };
}

/**
 * Build a pino logger using the EXACT same options the singleton was
 * constructed with, but routed to a captured stream. This is the closest
 * we can get to black-box testing the singleton without spawning a
 * separate Node process — it tests the actual `buildPinoOptions()`
 * output, not a hand-rolled mirror of the contract.
 *
 * IMPORTANT: drops `transport` from the options because pino-pretty
 * (used in development) is a worker-thread transport that bypasses our
 * captured destination. The redaction config under `redact:{paths,remove}`
 * is what we're testing, and that property is preserved.
 */
function buildLoggerWithProductionOptionsButCapturedDest(capture: Capture): Logger {
  const options = buildPinoOptions();
  // Strip transport so output goes to our captured stream synchronously.
  // The redaction config (the contract under test) is unchanged.
  const { transport: _ignore, ...optionsWithoutTransport } = options;
  return pino(optionsWithoutTransport, capture.stream);
}

/** Concatenate all captured chunks and return the parsed JSON of the last log line. */
function lastLogLine(capture: Capture): Record<string, unknown> {
  expect(capture.buf.length).toBeGreaterThan(0);
  const lines = capture.buf
    .join('')
    .split('\n')
    .filter((s) => s.length > 0);
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. ALWAYS_REDACTED contract pin
// ---------------------------------------------------------------------------

describe('ALWAYS_REDACTED — contract pin (defense-in-depth floor)', () => {
  it('contains every documented credential path', () => {
    // Credentials are fixed-depth paths under Fastify's req shape.
    const credentialPaths = [
      'req.headers.authorization',
      'req.body.password',
      'req.body.token',
      'req.body.confirmPassword',
    ];
    for (const p of credentialPaths) {
      expect(ALWAYS_REDACTED).toContain(p);
    }
  });

  it('contains every documented PHI field at depths 0..3 (root + 1-deep + 2-deep + 3-deep)', () => {
    // Closed 2026-05-04 per Codex logger-r1 HIGH: each PHI field name
    // expands to a 4-element wildcard set so pino fast-redact catches
    // the field at root and at any 1/2/3-key nesting under root.
    // Adding a new field requires adding 4 entries; dropping a depth
    // for any field is a privacy regression and trips this test.
    const phiFields = [
      'ssn',
      'dob',
      'medical_record_number',
      'date_of_birth',
      'social_security_number',
      'national_id',
      'ai_input_text',
      'ai_output_text',
    ];
    for (const field of phiFields) {
      expect(ALWAYS_REDACTED).toContain(field); // depth 0 (root)
      expect(ALWAYS_REDACTED).toContain(`*.${field}`); // depth 1
      expect(ALWAYS_REDACTED).toContain(`*.*.${field}`); // depth 2
      expect(ALWAYS_REDACTED).toContain(`*.*.*.${field}`); // depth 3
    }
  });

  it('has at least 36 entries (4 credential + 8 PHI fields × 4 depths)', () => {
    // 4 credential paths + (8 PHI fields × 4 depths) = 36 minimum.
    // Pinning the count separately so an addition that fails to update
    // the rosters above also trips here.
    expect(ALWAYS_REDACTED.length).toBeGreaterThanOrEqual(36);
  });

  it('contains no obviously-suspect duplicates (set-equality with itself)', () => {
    const set = new Set(ALWAYS_REDACTED);
    expect(set.size).toBe(ALWAYS_REDACTED.length);
  });
});

// ---------------------------------------------------------------------------
// 2. PRODUCTION WIRING — assert against buildPinoOptions() directly
//    (Codex r0 HIGH closure: tests now exercise the actual production
//     options object, not a hand-rolled mirror of the contract.)
// ---------------------------------------------------------------------------

describe('buildPinoOptions — production wiring', () => {
  it('redact.paths is the union of ALWAYS_REDACTED and config.logRedactPaths', () => {
    const opts = buildPinoOptions();
    expect(opts.redact).toBeDefined();
    const redact = opts.redact as { paths: string[]; remove: boolean };
    // Every floor path MUST be in opts.redact.paths.
    for (const p of ALWAYS_REDACTED) {
      expect(redact.paths).toContain(p);
    }
    // Every env-extended path (if any are configured) MUST also be present.
    for (const p of config.logRedactPaths) {
      expect(redact.paths).toContain(p);
    }
    // The total length is at most ALWAYS_REDACTED + logRedactPaths
    // (deduped). Pinning the upper bound catches a regression that
    // accidentally added extras silently.
    const expectedMax = ALWAYS_REDACTED.length + config.logRedactPaths.length;
    expect(redact.paths.length).toBeLessThanOrEqual(expectedMax);
  });

  it('redact.remove === true (no [Redacted] sentinel; field presence not leaked)', () => {
    const opts = buildPinoOptions();
    const redact = opts.redact as { remove: boolean };
    expect(redact.remove).toBe(true);
  });

  it('ENV EXTENDS contract — env-configured paths are ADDITIVE to ALWAYS_REDACTED, never a replacement', () => {
    // Codex r0 MED closure: the env-extension contract is that
    // configured paths must EXTEND the floor, not replace it. Any
    // regression that read config.logRedactPaths as REPLACEMENT for
    // ALWAYS_REDACTED would drop the floor; assert that every floor
    // path remains present in the resolved options regardless of what
    // logRedactPaths contains.
    const opts = buildPinoOptions();
    const redact = opts.redact as { paths: string[] };
    // Sanity: ALWAYS_REDACTED is non-empty (otherwise this test is vacuous).
    expect(ALWAYS_REDACTED.length).toBeGreaterThan(0);
    // Every floor path is in the resolved paths.
    for (const floorPath of ALWAYS_REDACTED) {
      expect(redact.paths).toContain(floorPath);
    }
  });

  it('options carry a level (pinned to config.logLevel)', () => {
    const opts = buildPinoOptions();
    expect(opts.level).toBe(config.logLevel);
  });

  it('production-mode err serializer drops stack traces (per I-025 spirit)', () => {
    // Direct unit-test on the err serializer when nodeEnv is production.
    // Since config.nodeEnv depends on env at module-load time, we can't
    // toggle it inside this test cleanly. Instead, inspect the
    // serializer directly when present and confirm its shape — if
    // nodeEnv was 'production' the serializer is set; otherwise it's
    // absent (test-mode CI runs as nodeEnv='test', so we expect absent).
    const opts = buildPinoOptions();
    if (config.nodeEnv === 'production') {
      const serializers = opts.serializers as { err: (e: unknown) => unknown };
      expect(serializers).toBeDefined();
      expect(serializers.err).toBeDefined();
      const err = new Error('boom');
      const serialized = serializers.err(err) as { type: string; message: string };
      expect(serialized.type).toBe('Error');
      expect(serialized.message).toBe('boom');
      expect(serialized).not.toHaveProperty('stack');
    } else {
      // Non-production: serializers is `{}` per the source.
      expect(opts.serializers).toEqual({});
    }
  });

  it('dev-mode pino-pretty transport gated on config.nodeEnv === "development"', () => {
    const opts = buildPinoOptions();
    if (config.nodeEnv === 'development') {
      expect(opts.transport).toBeDefined();
      const transport = opts.transport as { target: string };
      expect(transport.target).toBe('pino-pretty');
    } else {
      // test / production / staging: no transport.
      expect(opts.transport).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Redaction BEHAVIOR — using the SAME options object that built the
//    singleton, prove every floor path actually removes the value from
//    the emitted JSON. (Codex r0 HIGH closure.)
// ---------------------------------------------------------------------------

describe('logger redaction — behavior (production options + captured destination)', () => {
  it('redacts req.headers.authorization', () => {
    const cap = makeCapture();
    const log = buildLoggerWithProductionOptionsButCapturedDest(cap);
    log.info({ req: { headers: { authorization: 'Bearer secret-token-xyz' } } }, 'request');
    const line = lastLogLine(cap);
    const reqLogged = line['req'] as Record<string, unknown>;
    const headersLogged = reqLogged['headers'] as Record<string, unknown>;
    expect(headersLogged).not.toHaveProperty('authorization');
    expect(JSON.stringify(line)).not.toContain('Bearer secret-token-xyz');
  });

  it('redacts req.body.password / req.body.token / req.body.confirmPassword', () => {
    const cap = makeCapture();
    const log = buildLoggerWithProductionOptionsButCapturedDest(cap);
    log.info(
      {
        req: {
          body: {
            password: 'hunter2',
            token: 'jwt-token-here',
            confirmPassword: 'hunter2',
            email: 'alice@example.com',
          },
        },
      },
      'login',
    );
    const line = lastLogLine(cap);
    const reqLogged = line['req'] as Record<string, unknown>;
    const bodyLogged = reqLogged['body'] as Record<string, unknown>;
    expect(bodyLogged).not.toHaveProperty('password');
    expect(bodyLogged).not.toHaveProperty('token');
    expect(bodyLogged).not.toHaveProperty('confirmPassword');
    expect(bodyLogged['email']).toBe('alice@example.com');
    const serialized = JSON.stringify(line);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('jwt-token-here');
  });

  it('redacts every *.<phi-field> wildcard path at depth-1 (one key under root)', () => {
    const cap = makeCapture();
    const log = buildLoggerWithProductionOptionsButCapturedDest(cap);
    log.info(
      {
        user: {
          ssn: '123-45-6789',
          dob: '1980-01-01',
          medical_record_number: 'MRN-987',
          date_of_birth: '1980-01-01',
          social_security_number: '123-45-6789',
          national_id: 'NID-12345',
          ai_input_text: 'patient said something private',
          ai_output_text: 'AI replied something private',
          name: 'Alice', // sanity passthrough
        },
      },
      'user-payload',
    );
    const line = lastLogLine(cap);
    const userLogged = line['user'] as Record<string, unknown>;
    const phiKeys = [
      'ssn',
      'dob',
      'medical_record_number',
      'date_of_birth',
      'social_security_number',
      'national_id',
      'ai_input_text',
      'ai_output_text',
    ];
    for (const k of phiKeys) {
      expect(userLogged).not.toHaveProperty(k);
    }
    expect(userLogged['name']).toBe('Alice');
    const serialized = JSON.stringify(line);
    const phiValues = [
      '123-45-6789',
      '1980-01-01',
      'MRN-987',
      'NID-12345',
      'patient said something private',
      'AI replied something private',
    ];
    for (const v of phiValues) {
      expect(serialized).not.toContain(v);
    }
  });

  it('remove:true semantics — fields are GONE, not replaced with [Redacted] sentinel', () => {
    const cap = makeCapture();
    const log = buildLoggerWithProductionOptionsButCapturedDest(cap);
    log.info({ user: { ssn: '999-88-7777', name: 'Bob' } }, 'remove-pin');
    const line = lastLogLine(cap);
    const userLogged = line['user'] as Record<string, unknown>;
    expect(userLogged).not.toHaveProperty('ssn');
    expect(userLogged['name']).toBe('Bob');
    expect(JSON.stringify(line)).not.toContain('[Redacted]');
  });
});

// ---------------------------------------------------------------------------
// 4. WILDCARD DEPTH — depths 0..3 covered (Codex r1 HIGH closure)
//
// Pino's `fast-redact` doesn't support recursive `**` wildcards, so
// each PHI field is enumerated at depths 0..3 in `ALWAYS_REDACTED`.
// The tests below verify redaction works at every depth in the floor.
//
// Depth >= 4 is intentionally OUT OF SCOPE — empirically deeper than
// any structured-log envelope the platform produces. If a future log
// emits PHI at depth 4+, that's a code-review-blocking violation
// regardless of whether redaction would catch it (the discipline is:
// don't log nested PHI at all; the floor here is defense-in-depth
// against accidental leaks at sane depths).
// ---------------------------------------------------------------------------

describe('logger redaction — wildcard depth coverage (root + 1/2/3-deep)', () => {
  it('redacts ssn at depth 0 (bare root key)', () => {
    const cap = makeCapture();
    const log = buildLoggerWithProductionOptionsButCapturedDest(cap);
    log.info({ ssn: '000-11-2222' }, 'depth-0');
    const line = lastLogLine(cap);
    expect(line).not.toHaveProperty('ssn');
    expect(JSON.stringify(line)).not.toContain('000-11-2222');
  });

  it('redacts ssn at depth 1 (one key under root)', () => {
    const cap = makeCapture();
    const log = buildLoggerWithProductionOptionsButCapturedDest(cap);
    log.info({ user: { ssn: '111-22-3333' } }, 'depth-1');
    const line = lastLogLine(cap);
    const userLogged = line['user'] as Record<string, unknown>;
    expect(userLogged).not.toHaveProperty('ssn');
    expect(JSON.stringify(line)).not.toContain('111-22-3333');
  });

  it('redacts ssn at depth 2 (encounter.patient.ssn)', () => {
    const cap = makeCapture();
    const log = buildLoggerWithProductionOptionsButCapturedDest(cap);
    log.info({ encounter: { patient: { ssn: 'depth-2-ssn-value' } } }, 'depth-2');
    const line = lastLogLine(cap);
    const encounter = line['encounter'] as Record<string, unknown>;
    const patient = encounter['patient'] as Record<string, unknown>;
    expect(patient).not.toHaveProperty('ssn');
    expect(JSON.stringify(line)).not.toContain('depth-2-ssn-value');
  });

  it('redacts ssn at depth 3 (request.context.encounter.ssn)', () => {
    const cap = makeCapture();
    const log = buildLoggerWithProductionOptionsButCapturedDest(cap);
    log.info({ request: { context: { encounter: { ssn: 'depth-3-ssn-value' } } } }, 'depth-3');
    const line = lastLogLine(cap);
    const request = line['request'] as Record<string, unknown>;
    const context = request['context'] as Record<string, unknown>;
    const encounter = context['encounter'] as Record<string, unknown>;
    expect(encounter).not.toHaveProperty('ssn');
    expect(JSON.stringify(line)).not.toContain('depth-3-ssn-value');
  });

  it('redacts ai_input_text at depth 2 (general — not ssn-specific)', () => {
    const cap = makeCapture();
    const log = buildLoggerWithProductionOptionsButCapturedDest(cap);
    log.info(
      { request: { context: { ai_input_text: 'depth-2-ai-input-leak-marker' } } },
      'depth-2-ai',
    );
    const line = lastLogLine(cap);
    expect(JSON.stringify(line)).not.toContain('depth-2-ai-input-leak-marker');
  });

  it('redacts medical_record_number at depth 3 (general — not ssn-specific)', () => {
    const cap = makeCapture();
    const log = buildLoggerWithProductionOptionsButCapturedDest(cap);
    log.info(
      { event: { ctx: { patient: { medical_record_number: 'MRN-DEPTH3-001' } } } },
      'depth-3-mrn',
    );
    const line = lastLogLine(cap);
    expect(JSON.stringify(line)).not.toContain('MRN-DEPTH3-001');
  });

  it('PIN: depth >= 4 is intentionally not covered by the floor', () => {
    // Pinning the documented depth limit. If a future change adds depth-4
    // coverage (e.g., bumping pino to a version with recursive `**`),
    // this test fails — flagging the deliberate scope expansion. If the
    // test continues to pass, the depth limit holds and the floor is
    // honest about its boundary.
    const cap = makeCapture();
    const log = buildLoggerWithProductionOptionsButCapturedDest(cap);
    const marker = 'depth-4-ssn-leak-marker-not-covered';
    log.info({ a: { b: { c: { d: { ssn: marker } } } } }, 'depth-4');
    const line = lastLogLine(cap);
    // Current behavior: depth 4 leaks. The contract says "don't log
    // PHI that deep"; this test pins the boundary. If a code path
    // legitimately needs deeper logging in the future, the floor must
    // be extended explicitly (not by accident).
    expect(JSON.stringify(line)).toContain(marker);
  });
});

// ---------------------------------------------------------------------------
// 5. createChildLogger — context binding + redaction inheritance
// ---------------------------------------------------------------------------

describe('createChildLogger — bindings + inherited redaction', () => {
  it('returns a Logger object with .info/.error/.child methods', () => {
    const child = createChildLogger({ module: 'forms-intake' });
    expect(typeof child.info).toBe('function');
    expect(typeof child.error).toBe('function');
    expect(typeof child.child).toBe('function');
  });

  it('child binding fields appear on emitted lines (parallel-logger demo via captured destination)', () => {
    const cap = makeCapture();
    const parent = buildLoggerWithProductionOptionsButCapturedDest(cap);
    const child = parent.child({ module: 'forms-intake', request_id: 'req-001' });
    child.info('hello from child');
    const line = lastLogLine(cap);
    expect(line['module']).toBe('forms-intake');
    expect(line['request_id']).toBe('req-001');
    expect(line['msg']).toBe('hello from child');
  });

  it('child INHERITS redaction — PHI fields redacted on child output', () => {
    const cap = makeCapture();
    const parent = buildLoggerWithProductionOptionsButCapturedDest(cap);
    const child = parent.child({ module: 'forms-intake' });
    child.info({ user: { ssn: '888-77-6666', name: 'Carol' } }, 'child-with-phi');
    const line = lastLogLine(cap);
    expect(line['module']).toBe('forms-intake');
    const userLogged = line['user'] as Record<string, unknown>;
    expect(userLogged).not.toHaveProperty('ssn');
    expect(userLogged['name']).toBe('Carol');
    expect(JSON.stringify(line)).not.toContain('888-77-6666');
  });
});

// ---------------------------------------------------------------------------
// 6. Singleton sanity — exists + has pino's standard surface
// ---------------------------------------------------------------------------

describe('logger singleton — sanity', () => {
  it('the exported singleton is a pino Logger with standard methods', () => {
    expect(singletonLogger).toBeDefined();
    expect(typeof singletonLogger.info).toBe('function');
    expect(typeof singletonLogger.error).toBe('function');
    expect(typeof singletonLogger.child).toBe('function');
    expect(typeof singletonLogger.level).toBe('string');
  });

  it('singleton level matches config.logLevel (proves construction-time wiring landed)', () => {
    expect(singletonLogger.level).toBe(config.logLevel);
  });

  // Diagnostic-only — pino's internal symbol layout is not part of its
  // stable API. Demoted from a contract assertion (which it was in r0)
  // because the production-options assertions above (§2) are the
  // authoritative proof. Kept as a low-cost smoke check that the
  // singleton has SOME redact-related plumbing installed.
  it('DIAGNOSTIC: singleton has at least one redact-related internal symbol', () => {
    const redactSymbols = Object.getOwnPropertySymbols(singletonLogger).filter((s) =>
      s.toString().toLowerCase().includes('redact'),
    );
    // At least one redact-related symbol present. If pino renames its
    // internals and this fails, demote to .skip — the §2 buildPinoOptions
    // assertions are the contract.
    expect(redactSymbols.length).toBeGreaterThan(0);
  });
});
