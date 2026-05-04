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
 *   4. UNBOUNDED-DEPTH PHI redaction — PHI fields are removed at any
 *      nesting depth via the recursive walker `redactPhiRecursive()`
 *      installed as pino's `formatters.log` hook. Tests exercise
 *      depths 0..6 + arrays + mixed containers; the walker has no
 *      depth limit. Direct walker unit tests cover edge cases (Error
 *      instances not walked, primitives no-op, etc.).
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
  PHI_FIELDS,
  buildPinoOptions,
  createChildLogger,
  logger as singletonLogger,
  redactPhiRecursive,
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

describe('ALWAYS_REDACTED — credential paths contract pin', () => {
  it('contains every documented credential path (fixed-depth req.* shape)', () => {
    // Codex logger-r2 closure 2026-05-04: PHI redaction has moved from
    // wildcard paths in `redact.paths` to a recursive walker via
    // `formatters.log` (see PHI_FIELDS pin below). ALWAYS_REDACTED now
    // covers ONLY the 4 credential paths that have stable Fastify-
    // controlled shapes; recursive PHI walking handles arbitrary nesting.
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

  it('has exactly 4 credential entries (no accidental additions)', () => {
    // Tighter bound now that PHI moved out — credentials should be
    // exactly the 4 documented paths. Adding a new credential pattern
    // requires updating both the constant and this test (deliberate).
    expect(ALWAYS_REDACTED.length).toBe(4);
  });

  it('contains no obviously-suspect duplicates (set-equality with itself)', () => {
    const set = new Set(ALWAYS_REDACTED);
    expect(set.size).toBe(ALWAYS_REDACTED.length);
  });
});

describe('PHI_FIELDS — recursive-walker field set contract pin', () => {
  it('contains every documented PHI field name', () => {
    // The set the recursive walker (redactPhiRecursive) deletes at any
    // depth. Adding a new PHI field requires adding to PHI_FIELDS and
    // updating this test deliberately; dropping any field is a privacy
    // regression and trips this test loudly.
    const requiredFields = [
      'ssn',
      'dob',
      'medical_record_number',
      'date_of_birth',
      'social_security_number',
      'national_id',
      'ai_input_text',
      'ai_output_text',
    ];
    for (const f of requiredFields) {
      expect(PHI_FIELDS).toContain(f);
    }
  });

  it('has exactly 8 entries (current PHI floor count)', () => {
    expect(PHI_FIELDS.length).toBe(8);
  });

  it('contains no duplicates', () => {
    expect(new Set(PHI_FIELDS).size).toBe(PHI_FIELDS.length);
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

  it('redacts every PHI field at depth-1 (one key under root) — covers all 8 fields in one fixture', () => {
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
// 4. UNBOUNDED-DEPTH PHI redaction (Codex logger-r2 HIGH closure)
//
// PHI fields are now redacted at ANY nesting depth via the recursive
// walker `redactPhiRecursive()` installed as pino's `formatters.log`
// hook. The tests below exercise depths 0 through 6 to confirm the
// walker has no fixed-depth limit, plus arrays-of-PHI-bearing-objects
// to confirm the walker handles array containers.
// ---------------------------------------------------------------------------

describe('logger redaction — unbounded PHI depth (recursive walker)', () => {
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

  it('redacts ssn at depth 4 (was the r1 leak boundary; now closed)', () => {
    const cap = makeCapture();
    const log = buildLoggerWithProductionOptionsButCapturedDest(cap);
    log.info({ a: { b: { c: { d: { ssn: 'depth-4-ssn-marker' } } } } }, 'depth-4');
    const line = lastLogLine(cap);
    expect(JSON.stringify(line)).not.toContain('depth-4-ssn-marker');
  });

  it('redacts ssn at depth 5 (proves the walker has no depth limit)', () => {
    const cap = makeCapture();
    const log = buildLoggerWithProductionOptionsButCapturedDest(cap);
    log.info({ a: { b: { c: { d: { e: { ssn: 'depth-5-ssn-marker' } } } } } }, 'depth-5');
    const line = lastLogLine(cap);
    expect(JSON.stringify(line)).not.toContain('depth-5-ssn-marker');
  });

  it('redacts ssn at depth 6 (further confirmation; arbitrary depth)', () => {
    const cap = makeCapture();
    const log = buildLoggerWithProductionOptionsButCapturedDest(cap);
    log.info({ a: { b: { c: { d: { e: { f: { ssn: 'depth-6-ssn-marker' } } } } } } }, 'depth-6');
    const line = lastLogLine(cap);
    expect(JSON.stringify(line)).not.toContain('depth-6-ssn-marker');
  });

  it('redacts medical_record_number at depth 4 (different field; arbitrary depth)', () => {
    const cap = makeCapture();
    const log = buildLoggerWithProductionOptionsButCapturedDest(cap);
    log.info(
      {
        a: { b: { c: { d: { medical_record_number: 'MRN-DEPTH4-LEAK-MARKER' } } } },
      },
      'depth-4-mrn',
    );
    const line = lastLogLine(cap);
    expect(JSON.stringify(line)).not.toContain('MRN-DEPTH4-LEAK-MARKER');
  });

  it('redacts PHI inside an ARRAY of objects (walker handles array containers)', () => {
    const cap = makeCapture();
    const log = buildLoggerWithProductionOptionsButCapturedDest(cap);
    log.info(
      {
        users: [
          { name: 'Alice', ssn: 'arr-ssn-1' },
          { name: 'Bob', ssn: 'arr-ssn-2', medical_record_number: 'arr-mrn-2' },
        ],
      },
      'array-phi',
    );
    const line = lastLogLine(cap);
    const serialized = JSON.stringify(line);
    expect(serialized).not.toContain('arr-ssn-1');
    expect(serialized).not.toContain('arr-ssn-2');
    expect(serialized).not.toContain('arr-mrn-2');
    // Sanity: non-PHI siblings preserved
    expect(serialized).toContain('Alice');
    expect(serialized).toContain('Bob');
  });

  it('redacts PHI nested inside an array nested inside an object (mixed containers)', () => {
    const cap = makeCapture();
    const log = buildLoggerWithProductionOptionsButCapturedDest(cap);
    log.info(
      {
        request: {
          patients: [{ encounter: { ssn: 'mixed-arr-obj-ssn-leak-marker' } }],
        },
      },
      'mixed-containers',
    );
    const line = lastLogLine(cap);
    expect(JSON.stringify(line)).not.toContain('mixed-arr-obj-ssn-leak-marker');
  });
});

// ---------------------------------------------------------------------------
// 4b. redactPhiRecursive — direct walker unit tests
// ---------------------------------------------------------------------------

describe('redactPhiRecursive — direct walker unit tests', () => {
  it('removes top-level PHI keys', () => {
    const obj: Record<string, unknown> = { ssn: 'x', name: 'Alice' };
    redactPhiRecursive(obj);
    expect(obj).not.toHaveProperty('ssn');
    expect(obj['name']).toBe('Alice');
  });

  it('removes nested PHI keys at multiple depths', () => {
    const obj: Record<string, unknown> = {
      a: { ssn: 'x', b: { dob: 'y', c: { medical_record_number: 'z' } } },
    };
    redactPhiRecursive(obj);
    const a = obj['a'] as Record<string, unknown>;
    expect(a).not.toHaveProperty('ssn');
    const b = a['b'] as Record<string, unknown>;
    expect(b).not.toHaveProperty('dob');
    const c = b['c'] as Record<string, unknown>;
    expect(c).not.toHaveProperty('medical_record_number');
  });

  it('handles arrays of objects (walks each element)', () => {
    const obj: Record<string, unknown> = {
      users: [
        { ssn: 'a', name: 'Alice' },
        { ssn: 'b', national_id: 'nid-b' },
      ],
    };
    redactPhiRecursive(obj);
    const users = obj['users'] as Array<Record<string, unknown>>;
    expect(users[0]).not.toHaveProperty('ssn');
    expect(users[0]?.['name']).toBe('Alice');
    expect(users[1]).not.toHaveProperty('ssn');
    expect(users[1]).not.toHaveProperty('national_id');
  });

  it('does NOT walk into class instances (Error/Date — pino has its own serializers for those)', () => {
    // Plain-object detection: only walk values whose prototype is
    // Object.prototype (or null). A non-plain Error/Date instance with
    // a property named `ssn` should be left untouched.
    const err = new Error('boom');
    (err as unknown as Record<string, unknown>)['ssn'] = 'should-not-be-walked';
    const obj: Record<string, unknown> = { err };
    redactPhiRecursive(obj);
    // The err's ssn property remains because we don't walk into Error
    // instances (pino's err serializer handles them).
    expect((err as unknown as Record<string, unknown>)['ssn']).toBe('should-not-be-walked');
  });

  it('handles null and primitive leaves without throwing', () => {
    const obj: Record<string, unknown> = {
      n: null,
      s: 'string',
      i: 42,
      b: true,
      arr: [1, 'two', null, undefined],
    };
    expect(() => redactPhiRecursive(obj)).not.toThrow();
    // Sanity: non-PHI fields preserved.
    expect(obj['s']).toBe('string');
    expect(obj['i']).toBe(42);
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
