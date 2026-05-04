/**
 * logger.ts — Pino logger factory with PHI redaction.
 *
 * Purpose:
 *   Creates a pino logger instance with mandatory PHI-field redaction paths.
 *   Production emits structured JSON for ingestion by the audit + observability
 *   pipeline. Development uses pino-pretty for human-readable output.
 *
 * Spec references:
 *   - AUDIT_EVENTS v5.2 PHI handling discipline: never log authorization
 *     headers, passwords, tokens, or PHI fields in application logs.
 *   - I-003 (audit append-only): application logs are NOT the audit trail;
 *     audit events go to the append-only audit store via audit.ts.
 *   - I-023 (tenant isolation): logs must never co-mingle PHI across tenants;
 *     PHI field redaction prevents accidental tenant-cross-contamination in
 *     centralized log aggregators.
 *
 * PHI redaction strategy:
 *   Always-redacted paths (hardcoded floor, non-overridable):
 *     - req.headers.authorization
 *     - req.body.password
 *     - req.body.token
 *     - *.ssn
 *     - *.dob
 *     - *.medical_record_number
 *   Additional paths come from LOG_REDACT_PATHS env var (comma-separated).
 *   The union of both sets is applied at logger construction time.
 *
 * Open questions for Engineering Lead:
 *   - pino-pretty is a devDependency only; if pino-pretty is missing in dev,
 *     the transport silently falls back to JSON. Acceptable?
 *   - Should we add a redact path for `*.patient_id` in logs? Currently
 *     patient_id in traces is allowed (needed for correlation); PHI is the
 *     sensitive concern, not the ID itself. Engineering Lead to confirm.
 */

import pino, { type Logger, type TransportSingleOptions } from 'pino';

import { config } from './config.js';

// ---------------------------------------------------------------------------
// Always-redacted PHI paths (non-overridable floor)
//
// Exported so test suites can pin the contract (every path in this list MUST
// continue to redact) and so any future code that needs to add a defense-in-
// depth log redaction can extend the same canonical list rather than
// duplicating it in a parallel constant. The list is intentionally `readonly`
// at the type level so callers can't mutate it post-import; pino consumes it
// once at logger-construction time.
// ---------------------------------------------------------------------------

/**
 * PHI fields whose values must NEVER appear in application logs at ANY
 * nesting depth. The `redactPhiRecursive()` formatter (installed via
 * pino's `formatters.log` option) walks every log object and removes
 * any key matching this set, regardless of how deeply nested. This is
 * the unbounded-depth defense — `redact.paths` covers the fixed-depth
 * credential paths under `req.*`, but PHI fields can show up under any
 * structured envelope (request.context.event.patient.*, etc.) so they
 * need a recursive walker.
 *
 * (Codex logger-r2 HIGH closure 2026-05-04 — prior implementation
 * enumerated depths 0..3 explicitly via wildcard paths but pinned a
 * known leak at depth >= 4. Switching to a recursive walker via
 * formatters.log removes the depth limit entirely.)
 */
const PHI_FIELDS = [
  'ssn',
  'dob',
  'medical_record_number',
  'date_of_birth',
  'social_security_number',
  'national_id',
  // AI inference inputs/outputs that may contain patient text
  'ai_input_text',
  'ai_output_text',
] as const;

const PHI_FIELD_SET: ReadonlySet<string> = new Set(PHI_FIELDS);

/**
 * Recursively walk `value` and DELETE any object key matching a PHI
 * field name. Mutates in place (pino's `formatters.log` accepts the
 * mutated/returned object as the merge target for serialization). Walks
 * arrays + plain objects; scalar leaves and null are no-ops; class
 * instances (Error, Date, etc.) are NOT walked — they're handled by
 * pino's built-in serializers and class-instance traversal could mutate
 * shared library objects.
 */
function walkAndDeletePhi(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walkAndDeletePhi(item);
    return;
  }
  // Skip non-plain objects (Error, Date, Buffer, etc.). Plain objects
  // have Object.prototype as their immediate prototype.
  const proto = Object.getPrototypeOf(value as object);
  if (proto !== Object.prototype && proto !== null) return;

  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (PHI_FIELD_SET.has(key)) {
      delete obj[key];
    } else {
      walkAndDeletePhi(obj[key]);
    }
  }
}

/**
 * pino `formatters.log` hook — mutates the merge object before
 * serialization to remove PHI keys at any depth. Combined with the
 * fixed-path `redact.paths` config (for credentials under `req.*`),
 * gives unbounded-depth PHI redaction without enumerating per-depth
 * wildcards.
 */
function redactPhiRecursive(obj: Record<string, unknown>): Record<string, unknown> {
  walkAndDeletePhi(obj);
  return obj;
}

/**
 * The `ALWAYS_REDACTED` set covers ONLY the fixed-depth credential
 * paths under Fastify's req shape. PHI field redaction has moved to
 * the recursive `redactPhiRecursive()` formatter (logger-r2 HIGH
 * closure 2026-05-04) so PHI is removed at any nesting depth. The
 * separation:
 *
 *   - Credentials (this list)        → fixed `req.*` paths, 4 entries.
 *     Handled by pino `redact.paths` because the request body shape
 *     is Fastify-controlled and stable.
 *
 *   - PHI fields (PHI_FIELDS above)  → recursive walker via
 *     `formatters.log`. Handles arbitrary nesting depth, arrays of
 *     PHI-bearing objects, etc.
 *
 * The two mechanisms are independent and additive — both fire on every
 * log call.
 */
export const ALWAYS_REDACTED: readonly string[] = [
  'req.headers.authorization',
  'req.body.password',
  'req.body.token',
  'req.body.confirmPassword',
] as const;

/** Re-export of the recursive PHI walker for direct test coverage. */
export { redactPhiRecursive, PHI_FIELDS };

// ---------------------------------------------------------------------------
// Logger factory
// ---------------------------------------------------------------------------

/**
 * Construct the pino options that the singleton logger uses. Exported so
 * tests can directly assert the production wiring: that `redact.paths`
 * is the full union of `ALWAYS_REDACTED` + `config.logRedactPaths`, that
 * `redact.remove === true` (no '[Redacted]' sentinel leaking field
 * presence), and that the dev-only pino-pretty transport is gated on
 * `config.nodeEnv === 'development'`.
 *
 * Black-box-testing the singleton's destination directly is not feasible
 * (pino caches its destination at construction time), so this exported
 * options-builder is the proxy the test suite uses to assert what was
 * passed into pino at startup. The singleton itself is constructed via
 * `pino(buildPinoOptions())` immediately below; any future change that
 * paths logger construction through a different options object MUST
 * also keep this exported function in sync.
 */
export function buildPinoOptions(): pino.LoggerOptions {
  const additionalPaths = config.logRedactPaths;

  // Merge always-redacted with env-configured paths, deduplicated
  const allRedactPaths = Array.from(new Set([...ALWAYS_REDACTED, ...additionalPaths]));

  const options: pino.LoggerOptions = {
    level: config.logLevel,
    redact: {
      paths: allRedactPaths,
      remove: true, // remove the field entirely; do not replace with '[Redacted]'
    },
    // Recursive PHI walker — removes any PHI field at any nesting depth
    // before serialization. Combined with `redact.paths` above (which
    // handles the fixed-depth credential paths under req.*), this gives
    // unbounded-depth redaction. Closed 2026-05-04 per Codex logger-r2
    // HIGH (prior implementation enumerated depths 0..3 only and pinned
    // a known depth-4 leak; the recursive walker removes the depth
    // limit entirely).
    formatters: {
      log: redactPhiRecursive,
    },
    // Serializers: remove any raw error stack in production to avoid
    // leaking internal implementation details per I-025 spirit.
    serializers:
      config.nodeEnv === 'production'
        ? {
            err: (err: unknown) => {
              if (err instanceof Error) {
                return {
                  type: err.constructor.name,
                  message: err.message,
                  // No stack in production logs — use trace_id for correlation
                };
              }
              return err;
            },
          }
        : {},
  };

  if (config.nodeEnv === 'development') {
    const transport: TransportSingleOptions = {
      target: 'pino-pretty',
      options: {
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
        colorize: true,
      },
    };
    options.transport = transport;
  }

  return options;
}

// ---------------------------------------------------------------------------
// Singleton logger instance
// ---------------------------------------------------------------------------

export const logger: Logger = pino(buildPinoOptions());

/**
 * createChildLogger — creates a pino child logger with bound context.
 * Used by modules to attach module-level context (e.g., `{ module: 'audit' }`).
 * PHI redaction is inherited from the parent logger.
 */
export function createChildLogger(context: Record<string, string | number | boolean>): Logger {
  return logger.child(context);
}
