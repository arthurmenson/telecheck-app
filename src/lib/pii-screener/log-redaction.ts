/**
 * pii-screener/log-redaction.ts — Layer 3 log redaction (Sprint 1.2a).
 *
 * Layer 3 is the last line of defense on the LOGGING path. Layers 1 and 2
 * gate ingress and egress; this one assumes both were bypassed and scrubs
 * whatever is about to be written to the log stream.
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
 *      is caller-shaped: a Postgres error can echo an offending value, a
 *      driver can interpolate a parameter, a future `throw new
 *      Error(\`bad input: ${x}\`)` can carry anything.
 *   2. **Serializer output.** Fastify's automatic request logging
 *      serializes `req` — including the URL WITH ITS QUERY STRING, which
 *      is entirely client-controlled. `/?email=real.person@example.com`
 *      is a live leak vector.
 *   3. **Future call sites.** A path allowlist protects the code that
 *      exists today; the next handler someone writes is unprotected
 *      until somebody remembers to extend the list.
 *
 * All three are structural, so the mitigation has to be structural.
 *
 * ## Why the redaction runs at the STREAM, not at `hooks.logMethod`
 *
 * The obvious hook — `hooks.logMethod` — is WRONG here, for two reasons
 * found in Codex review of the first implementation:
 *
 *   - **It runs BEFORE pino's serializers.** Fastify's `req`/`res`
 *     serializers turn request objects into log records after the hook
 *     has already run, so anything a serializer produces (notably the
 *     request URL + query string) is never seen by a `logMethod` pass.
 *   - **Recursively rebuilding objects there corrupts them.** Fastify
 *     request properties (`method`, `url`, `headers`, `host`, `ip`) are
 *     prototype getters. `Object.entries()` does not copy prototype
 *     getters, so cloning the request into a plain object hands the
 *     downstream serializer a structurally damaged input and produces
 *     empty or incomplete request records — deleting exactly the
 *     diagnostics an incident needs.
 *
 * Redacting at the destination stream avoids both problems: the line is
 * already fully serialized (serializer output, child bindings, and the
 * message are all present), and no live object is ever touched or
 * rebuilt.
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
 * ## Identifier-key preservation, and why it keys on the KEY only
 *
 * A blanket string scrub has a real false-positive mode: `us_ssn` also
 * matches any bare 9-digit run. Most identifiers in this codebase are
 * safe from it — UUIDs never expose a 9-digit run bounded by non-digits,
 * and short codes like `pg_sqlstate` are too short — but a ULID
 * (26 chars of Crockford base32) can by chance contain exactly nine
 * consecutive digits, and redacting a ULID mid-incident would break
 * correlation.
 *
 * So values under keys that are structurally identifiers are preserved
 * verbatim. **The carve-out is deliberately narrow and keys ONLY on the
 * key name**, never the value's content.
 *
 * Critically, it does NOT include client-influenced fields. `url` was in
 * the first draft and was a genuine leak (query strings are
 * caller-controlled); it has been removed, so request URLs ARE scrubbed.
 * Only server-generated names remain.
 *
 * ## Depth handling — fails CLOSED via sentinel
 *
 * Past the depth bound the subtree is replaced with a fixed
 * `[REDACTED:DEPTH_LIMIT]` sentinel rather than returned as-is. The
 * first implementation returned the raw subtree, which let 33 nested
 * containers followed by an email deterministically bypass Layer 3.
 * Substituting a sentinel keeps the logger available (no throw) while
 * still refusing to emit unscreened content — so unlike the
 * `audit_bound` walker, this fails closed WITHOUT sacrificing the
 * operational record.
 *
 * Spec references:
 *   - docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md §Layer 3
 *   - AUDIT_EVENTS v5.2 PHI redaction discipline
 *   - SI-010 nonce-as-secret discipline (request_nonce must stay redacted)
 */

import { Transform } from 'node:stream';

import { PII_PATTERNS } from './patterns.js';

/** Sentinel written in place of a subtree that exceeded the depth bound. */
export const DEPTH_LIMIT_SENTINEL = '[REDACTED:DEPTH_LIMIT]';

/** Maximum nesting depth walked before the sentinel is substituted. */
export const LOG_REDACTION_MAX_DEPTH = 32;

/**
 * Replacement token written in place of a detected value. Deliberately
 * carries the pattern label so an operator reading the log knows WHAT
 * was scrubbed without seeing the value.
 */
function redactionToken(label: string): string {
  return `[REDACTED:${label}]`;
}

/**
 * Keys whose values are preserved verbatim because they are
 * SERVER-GENERATED structural identifiers, not free-text and not
 * client-influenced. Matched case-insensitively, exact.
 *
 * The `*_id` / `*Id` suffix rule below covers most identifiers
 * generatively; this set catches the ones that do not carry the suffix.
 *
 * DELIBERATELY ABSENT: `url`, `path`, `query`, `params`, `body`,
 * `headers`, `host`, `referer`, `user_agent` — all caller-influenced.
 * Their values ARE scrubbed.
 *
 * ALSO DELIBERATELY ABSENT: `hostname`. It is ambiguous — pino's base
 * bindings use it for the OS hostname (server-generated, safe), but
 * Fastify's `req` serializer uses the SAME key for the request's Host
 * header (client-controlled). A name-based carve-out cannot tell the
 * two apart, so the key is excluded. Scrubbing an OS hostname is
 * harmless (it will not match a high-confidence pattern anyway); NOT
 * scrubbing a caller-supplied Host header would be a leak.
 *
 * This ambiguity is the general hazard of name-based carve-outs, and
 * the reason the set is kept deliberately small: a key earns a place
 * here only when EVERY writer of that key is server-side.
 */
const IDENTIFIER_KEYS: ReadonlySet<string> = new Set([
  'tenant',
  'tenantid',
  'route', // Fastify route PATTERN (e.g. '/v0/ai/chat'), server-defined
  'method',
  'status',
  'statuscode',
  'code',
  'pg_sqlstate',
  'level',
  'time',
  'pid',
  'reqid',
  'responsetime',
  'node_env',
  'node_env_observed',
  'layer',
  'gate',
  'event',
  'purpose',
  'provider',
  'model',
  'severity',
  'detector_version',
  'name', // Error.name
]);

/**
 * True when a key names a server-generated structural identifier whose
 * value must be preserved for debuggability.
 *
 * Rule: an exact match in IDENTIFIER_KEYS, or a `_id` / `Id` suffix
 * (`consult_id`, `turnId`, `ai_chat_session_id`, …).
 */
export function isIdentifierKey(key: string): boolean {
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
 * Recursively redact an already-PARSED log record.
 *
 * Operates on plain JSON values only (the output of `JSON.parse`), so
 * there are no prototype getters, class instances, or live framework
 * objects to damage — that hazard is structurally impossible here
 * because this only ever runs on post-serialization data.
 *
 * Past `LOG_REDACTION_MAX_DEPTH` the subtree is replaced with
 * `DEPTH_LIMIT_SENTINEL` (fails closed; see module header).
 */
export function redactParsedRecord(value: unknown, depth = 0): unknown {
  if (depth > LOG_REDACTION_MAX_DEPTH) return DEPTH_LIMIT_SENTINEL;

  if (typeof value === 'string') return redactString(value);
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((v) => redactParsedRecord(v, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    // Identifier keys keep their values verbatim so the operator can
    // still correlate the log line during an incident. Only applies
    // when the value is a scalar — a nested object under an identifier
    // key is still walked, since the carve-out is about ID values, not
    // about exempting whole subtrees.
    out[k] =
      isIdentifierKey(k) && (typeof v !== 'object' || v === null)
        ? v
        : redactParsedRecord(v, depth + 1);
  }
  return out;
}

/**
 * Redact a single serialized log line.
 *
 * Fast path: the line is pino NDJSON, so parse it, walk it with
 * key-awareness, and re-serialize. That gives identifier-key
 * preservation without a false-positive risk on ULIDs.
 *
 * Fallback: if the line is not parseable JSON (a transport wrote
 * pretty-printed output, a partial chunk, a non-JSON warning), apply the
 * whole-line regex instead. This FAILS SAFE — an unparseable line is
 * still scrubbed, it just loses the identifier carve-out.
 */
export function redactLogLine(line: string): string {
  const trimmed = line.trimEnd();
  const newline = line.slice(trimmed.length);
  if (trimmed.length === 0) return line;

  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return JSON.stringify(redactParsedRecord(parsed)) + newline;
    } catch {
      // Not valid JSON after all — fall through to the string pass.
    }
  }
  return redactString(trimmed) + newline;
}

/**
 * Redact every line in a (possibly batched) chunk, preserving the
 * chunk's exact line framing.
 *
 * pino batches multiple newline-delimited records under load, so a
 * chunk is not necessarily one record.
 */
export function redactChunk(chunk: string): string {
  if (chunk.length === 0) return chunk;
  const parts = chunk.split('\n');
  return parts
    .map((part, i) =>
      // The final element after a trailing '\n' is an empty string;
      // leave it alone so join() reproduces the original framing.
      i === parts.length - 1 && part === '' ? part : redactLogLine(part),
    )
    .join('\n');
}

/**
 * Build a Transform stream that applies Layer 3 redaction to everything
 * written through it, then forwards to `dest`.
 *
 * Wire it in `defaultLoggerConfig()`:
 *
 *   stream: createRedactingStream(process.stdout)
 *
 * ## Why a real `Transform` and not a `{ write }` duck-type
 *
 * A plain `{ write(chunk) }` object works for `process.stdout`, but it
 * silently drops every other stream method. That matters because the
 * destination may be a pino transport (`pino.transport({ target:
 * 'pino-pretty' })`), which is a worker-backed stream whose `flush`,
 * `end`, and event plumbing pino and the process-exit path rely on.
 * A `Transform` is a real stream, so composition with a transport works
 * and nothing is lost.
 *
 * ## Interaction with pino's `transport` option
 *
 * pino REFUSES to accept both `options.transport` and a destination
 * stream — `lib/tools.js` throws `'only one of option.transport or
 * stream can be specified'`. So a config that wants pretty-printing
 * AND redaction must NOT set `transport`; it must build the transport
 * stream itself and pass the redacting wrapper around it as `stream`.
 * `defaultLoggerConfig()` does exactly that.
 *
 * This composes with — does not replace — pino's `redact.paths`. Those
 * run during serialization with `remove: true`, so an explicitly-listed
 * path is dropped entirely; this pass then scrubs whatever survived,
 * INCLUDING serializer-generated content such as the request URL.
 */
export function createRedactingStream(dest: NodeJS.WritableStream): Transform {
  const transform = new Transform({
    // Chunks are pino NDJSON text.
    decodeStrings: false,
    transform(chunk: unknown, _encoding, callback): void {
      try {
        const text =
          typeof chunk === 'string'
            ? chunk
            : Buffer.isBuffer(chunk)
              ? chunk.toString('utf8')
              : String(chunk);
        callback(null, redactChunk(text));
      } catch (err) {
        // Never let a redaction failure kill the log stream — that
        // would cost the operational record. Forward a sentinel line
        // instead so the loss is visible rather than silent.
        callback(null, `{"level":50,"msg":"${LOG_REDACTION_FAILURE_SENTINEL}"}\n`);
        void err;
      }
    },
  });
  transform.pipe(dest);
  return transform;
}

/**
 * Emitted in place of a chunk whose redaction threw. Visible failure
 * beats silent loss — and beats emitting the unredacted chunk.
 */
export const LOG_REDACTION_FAILURE_SENTINEL = 'log-redaction-failed:chunk-dropped';
