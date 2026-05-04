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
 * PHI fields whose values must NEVER appear in application logs at any
 * realistic nesting depth. Each entry is expanded into multiple
 * wildcard paths below (depths 0–3) because pino's underlying
 * `fast-redact` engine does NOT support recursive `**` matching — it
 * supports wildcards only at single-segment positions, so each depth
 * must be enumerated explicitly. (Closed 2026-05-04 per Codex
 * logger-r1 HIGH — depth-2 PHI was previously leaking.)
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

/**
 * Expand a PHI field name to a depth-0..3 wildcard set. Depth 0 covers
 * the bare root key (`{ ssn: '…' }`); depths 1–3 cover progressively
 * deeper nesting (`patient.ssn`, `encounter.patient.ssn`,
 * `request.context.encounter.ssn`). Three-level depth is empirically
 * deep enough for the structured-log envelopes the platform produces;
 * deeper PHI in logs is a code-review-blocking violation regardless of
 * whether redaction would catch it.
 */
function expandPhiPaths(field: string): string[] {
  return [field, `*.${field}`, `*.*.${field}`, `*.*.*.${field}`];
}

export const ALWAYS_REDACTED: readonly string[] = [
  // Credentials — fixed-depth paths controlled by Fastify's req shape
  'req.headers.authorization',
  'req.body.password',
  'req.body.token',
  'req.body.confirmPassword',
  // PHI field paths at depth 0–3 (root, 1-deep, 2-deep, 3-deep) for
  // each field — pino fast-redact requires explicit per-depth
  // wildcards.
  ...PHI_FIELDS.flatMap(expandPhiPaths),
] as const;

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
