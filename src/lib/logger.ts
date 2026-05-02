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
// ---------------------------------------------------------------------------

const ALWAYS_REDACTED: readonly string[] = [
  'req.headers.authorization',
  'req.body.password',
  'req.body.token',
  'req.body.confirmPassword',
  // PHI field paths — applied wherever they appear in any log object
  '*.ssn',
  '*.dob',
  '*.medical_record_number',
  '*.date_of_birth',
  '*.social_security_number',
  '*.national_id',
  // AI inference inputs/outputs that may contain patient text
  '*.ai_input_text',
  '*.ai_output_text',
] as const;

// ---------------------------------------------------------------------------
// Logger factory
// ---------------------------------------------------------------------------

function buildPinoOptions(): pino.LoggerOptions {
  const additionalPaths = config.logRedactPaths;

  // Merge always-redacted with env-configured paths, deduplicated
  const allRedactPaths = Array.from(
    new Set([...ALWAYS_REDACTED, ...additionalPaths]),
  );

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
