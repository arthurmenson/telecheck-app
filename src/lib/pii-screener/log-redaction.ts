/**
 * pii-screener/log-redaction.ts — Layer 3 log redaction (Sprint 1.2a).
 *
 * Layer 3 is the last line of defense on the LOGGING path. Layers 1 and 2
 * gate ingress and egress; this one assumes both were bypassed and scrubs
 * whatever is about to be serialized into the log stream.
 *
 * ## Why a whole-payload pass rather than more `redact.paths` entries
 *
 * pino's built-in `redact.paths` is an ALLOWLIST of known field paths.
 * It is exact and cheap, and it stays configured (`LOG_REDACT_PATHS`).
 * But it can only cover paths someone thought of in advance. The Sprint
 * 1.2a log-surface audit found the codebase's logging discipline is
 * already good — every merge-object key across the 38 log call sites is
 * an identifier, a status, a count, or a pattern-id list; none is raw
 * user free-text. The residual risk is therefore NOT a forgotten field
 * name. It is:
 *
 *   1. **Error objects.** Four call sites log `err`. An `Error.message`
 *      is caller-shaped: a Postgres error can echo a offending value, a
 *      driver can interpolate a parameter, a future `throw new
 *      Error(\`bad input: ${x}\`)` can carry anything.
 *   2. **Future call sites.** A path allowlist protects the code that
 *      exists today; the next handler someone writes is unprotected
 *      until somebody remembers to extend the list.
 *
 * Both are structural, so the mitigation has to be structural: run the
 * detector over the whole payload, whatever shape it has.
 *
 * ## Regex-only — NER is deliberately NOT used here
 *
 * Layers 1 and 2 run regex + local NER. Layer 3 runs regex ONLY:
 *
 *   - **Cost.** NER is model inference. Logs are high-volume and on the
 *     hot path; paying inference per log line is not viable.
 *   - **Precision.** NER's PERSON/GPE/ORG classes would fire on the
 *     operational vocabulary that logs are made of — role names, tenant
 *     identifiers, provider names, module names. Redacting those would
 *     destroy debuggability while protecting nothing.
 *   - **Value.** What actually shows up in a leaked log line is
 *     STRUCTURED identifiers — an SSN, an email, a phone, a card number.
 *     That is precisely regex's strength.
 *
 * ## Identifier-key preservation
 *
 * A naive value-scrub is worse than useless: the `us_ssn` pattern also
 * matches any bare 9-digit run, and logs are full of legitimate numeric
 * identifiers. Redacting `consult_id` or `tenant_id` would blind the
 * operator during exactly the incident the logs exist for.
 *
 * So values under keys that are structurally identifiers (`*_id`, plus
 * an explicit safe set) are PRESERVED verbatim. This is a deliberate,
 * narrow carve-out — it applies to the KEY NAME, not the value's
 * content, so it cannot be steered by user input.
 *
 * Spec references:
 *   - docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md §Layer 3
 *   - AUDIT_EVENTS v5.2 PHI redaction discipline
 *   - SI-010 nonce-as-secret discipline (request_nonce must stay redacted)
 */

import { PII_PATTERNS } from './patterns.js';

/**
 * Replacement token written in place of a detected value. Deliberately
 * carries the pattern label so an operator reading the log knows WHAT
 * was scrubbed without seeing the value.
 */
function redactionToken(label: string): string {
  return `[REDACTED:${label}]`;
}

/**
 * Keys whose values are preserved verbatim because they are structural
 * identifiers, not free-text. Matched case-insensitively, exact.
 *
 * The `*_id` / `*Id` suffix rule below covers most of these generatively;
 * this set catches the ones that do not carry the suffix.
 */
const IDENTIFIER_KEYS: ReadonlySet<string> = new Set([
  'tenant',
  'tenantid',
  'actor',
  'route',
  'method',
  'url',
  'status',
  'statuscode',
  'code',
  'pg_sqlstate',
  'level',
  'time',
  'pid',
  'hostname',
  'reqid',
  'responsetime',
  'node_env',
  'node_env_observed',
  'layer',
  'gate',
  'event',
  'purpose',
  'reason',
  'provider',
  'model',
  'severity',
  'detector_version',
]);

/**
 * True when a key names a structural identifier whose value must be
 * preserved for debuggability.
 *
 * Rule: an exact match in IDENTIFIER_KEYS, or a `_id` / `Id` suffix
 * (`consult_id`, `turnId`, `ai_chat_session_id`, …).
 */
function isIdentifierKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (IDENTIFIER_KEYS.has(lower)) return true;
  return lower.endsWith('_id') || lower.endsWith('id');
}

/**
 * Apply the high-confidence regex patterns to a single string, replacing
 * every match with its redaction token.
 *
 * Only `high_confidence` patterns run here. Low-confidence patterns
 * (IPv4, IPv6, the context-bound passport form) are the ones most likely
 * to collide with legitimate operational values in a log line — an IP
 * address in a log is usually infrastructure, not PII, and scrubbing it
 * would remove genuinely useful diagnostic signal.
 */
export function redactString(value: string): string {
  let out = value;
  for (const pattern of PII_PATTERNS) {
    if (pattern.confidence !== 'high_confidence') continue;
    // Fresh regex per call: PII_PATTERNS entries carry /g, and sharing
    // lastIndex across invocations would make redaction order-dependent.
    const re = new RegExp(pattern.regex.source, pattern.regex.flags);
    out = out.replace(re, (match) => {
      if (pattern.validate && !pattern.validate(match)) return match;
      return redactionToken(pattern.label);
    });
  }
  return out;
}

/**
 * Recursively redact a log payload of arbitrary shape.
 *
 * Handles: strings, arrays, plain objects, Error instances, Maps, Sets.
 * Leaves numbers / booleans / null / undefined untouched (they cannot
 * carry a regex-detectable identifier).
 *
 * Depth-bounded. Unlike the `audit_bound` payload walker — which FAILS
 * CLOSED by rejecting an unscreenable payload — this one fails OPEN at
 * the bound, returning the value unredacted. That asymmetry is
 * deliberate and worth stating plainly:
 *
 *   - Rejecting an over-deep AUDIT payload costs one API call and
 *     protects append-only, purge-exempt storage.
 *   - Throwing from inside a LOGGER would break logging itself — the
 *     failure mode is losing the operational record during an incident,
 *     which is strictly worse than a deeply-nested log object going
 *     unscrubbed. Logs are also purgeable; audit rows are not.
 *
 * The bound is set high (32) so realistic log payloads never reach it.
 */
export function redactLogPayload(value: unknown, depth = 0): unknown {
  if (depth > 32) return value;

  if (typeof value === 'string') {
    return redactString(value);
  }

  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map((v) => redactLogPayload(v, depth + 1));
  }

  if (value instanceof Error) {
    // Errors are the highest-value target here — `message` and `stack`
    // are the fields most likely to have interpolated a user value.
    // Return a plain object rather than mutating the Error (mutating a
    // shared error object would corrupt it for other consumers).
    const scrubbed: Record<string, unknown> = {
      name: value.name,
      message: redactString(value.message),
    };
    if (typeof value.stack === 'string') {
      scrubbed['stack'] = redactString(value.stack);
    }
    // Preserve any enumerable own props (pg errors carry `code`,
    // `detail`, `constraint`, …) — scrubbed the same way.
    for (const [k, v] of Object.entries(value)) {
      if (k === 'name' || k === 'message' || k === 'stack') continue;
      scrubbed[k] = isIdentifierKey(k) ? v : redactLogPayload(v, depth + 1);
    }
    return scrubbed;
  }

  if (value instanceof Map) {
    const out = new Map<unknown, unknown>();
    for (const [k, v] of value.entries()) {
      out.set(k, redactLogPayload(v, depth + 1));
    }
    return out;
  }

  if (value instanceof Set) {
    return new Set([...value].map((v) => redactLogPayload(v, depth + 1)));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // Identifier keys keep their values verbatim so the operator can
      // still correlate the log line during an incident.
      out[k] = isIdentifierKey(k) ? v : redactLogPayload(v, depth + 1);
    }
    return out;
  }

  return value;
}

/**
 * pino `hooks.logMethod` implementation.
 *
 * pino calls this in place of the underlying log method, giving access
 * to BOTH the merge object and the message string before serialization —
 * which `formatters.log` alone does not provide (it never sees the
 * message).
 *
 * Wire it in `defaultLoggerConfig()`:
 *
 *   hooks: { logMethod: piiRedactingLogMethod }
 *
 * This composes with — does not replace — pino's `redact.paths`. Those
 * run first and use `remove: true`, so an explicitly-listed path is
 * dropped entirely; this pass then scrubs whatever survived.
 */
export function piiRedactingLogMethod(
  this: { [k: string]: unknown },
  args: unknown[],
  method: (...a: unknown[]) => void,
): void {
  const redacted = args.map((arg) =>
    typeof arg === 'string' || (arg !== null && typeof arg === 'object')
      ? redactLogPayload(arg)
      : arg,
  );
  method.apply(this, redacted);
}
