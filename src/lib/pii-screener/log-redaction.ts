/**
 * pii-screener/log-redaction.ts — Layer 3 log redaction (Sprint 1.2a).
 *
 * Layer 3 is the last line of defense on the LOGGING path. Layers 1 and 2
 * gate ingress and egress; this one assumes both were bypassed and scrubs
 * whatever is about to be written to the log stream.
 *
 * ## Why a whole-line pass rather than more `redact.paths` entries
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
 * The obvious hook is WRONG here, for two reasons found in Codex review
 * of the first implementation:
 *
 *   - **It runs BEFORE pino's serializers.** Fastify's `req`/`res`
 *     serializers turn request objects into log records after the hook
 *     has already run, so anything a serializer produces (notably the
 *     request URL + query string) is never seen by a `logMethod` pass.
 *   - **Rebuilding objects there corrupts them.** Fastify request
 *     properties (`method`, `url`, `headers`, `host`, `ip`) are
 *     prototype getters. `Object.entries()` does not copy prototype
 *     getters, so cloning the request into a plain object hands the
 *     downstream serializer a structurally damaged input and produces
 *     empty or incomplete request records — deleting exactly the
 *     diagnostics an incident needs.
 *
 * Redacting at the destination stream avoids both: the line is already
 * fully serialized (serializer output, child bindings, and message all
 * present), and no live object is ever touched.
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
 * ## Identifier preservation — BOTH the key name and the value shape
 *
 * A blanket string scrub has a real false-positive mode: `us_ssn` also
 * matches any bare 9-digit run, and a ULID (26 chars of Crockford
 * base32) can by chance contain exactly nine consecutive digits.
 * Redacting a ULID mid-incident would break correlation.
 *
 * So a narrow carve-out exists — but it requires **two** conditions,
 * not one:
 *
 *   1. the enclosing KEY names an identifier (`*_id` / `*Id`, or a
 *      member of `IDENTIFIER_KEYS`), AND
 *   2. the VALUE is shaped like an identifier (a UUID or a ULID)
 *
 * Key name alone is not sufficient and was a deterministic bypass in an
 * earlier draft: `{"request_id":"person@example.com"}` and
 * `{"patient_id":"123-45-6789"}` were copied verbatim purely because of
 * the key. For a layer whose whole premise is that the earlier controls
 * failed, trusting a caller-influenced or mistakenly-populated field on
 * its name is exactly the wrong instinct. See `isPreservableIdentifier`.
 *
 * The key set also excludes client-influenced fields. `url` was in the
 * first draft and was a genuine leak (query strings are
 * caller-controlled); it has been removed, so request URLs ARE scrubbed.
 * Only server-generated names remain.
 *
 * Nor does the carve-out propagate into containers: it applies only to a
 * string that is the DIRECT value of an object property. Array frames
 * reset it, so `{"request_id":[["<pii>"]]}` is screened normally.
 *
 * ## Numeric losslessness — why a token scanner, not JSON.parse
 *
 * The line pass rewrites ONLY string tokens, copying every number,
 * boolean, null and structural character through byte-for-byte. A
 * `JSON.parse` → walk → `JSON.stringify` round trip would be lossy, and
 * silently so: parse coerces every number to an IEEE-754 double, so a
 * 64-bit id or nanosecond timestamp is rounded on the way out. Parsing
 * succeeds, so no failure sentinel fires — the value is just quietly
 * wrong. Corrupting an identifier inside the redaction layer would
 * destroy the correlation evidence an incident depends on.
 *
 * The scanner is also a single O(n) pass with an explicit stack, so the
 * depth bound that an earlier recursive implementation needed is gone
 * entirely rather than merely tuned.
 *
 * Spec references:
 *   - docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md §Layer 3
 *   - AUDIT_EVENTS v5.2 PHI redaction discipline
 *   - SI-010 nonce-as-secret discipline (request_nonce must stay redacted)
 */

import { Transform } from 'node:stream';

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
 * Canonical identifier VALUE shapes.
 *
 * The carve-out requires a match here in addition to an identifier key
 * name. Key name alone is not sufficient — see `isPreservableIdentifier`.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Crockford base32, 26 chars — excludes I, L, O, U by design. */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * True when a string may be preserved verbatim under an identifier key.
 *
 * ## Why the key name alone is NOT enough
 *
 * An earlier version exempted any string under an `*_id` / `*Id` key.
 * Codex correctly rejected that: it is a deterministic bypass. Records
 * like `{"request_id":"person@example.com"}` or
 * `{"patient_id":"123-45-6789"}` would be copied verbatim purely
 * because of the key's name. For a layer whose entire premise is that
 * the earlier controls were bypassed, trusting a caller-influenced or
 * mistakenly-populated field on its name is exactly the wrong instinct.
 *
 * So the carve-out now requires the VALUE to look like an identifier
 * too — and only two shapes qualify: a UUID or a ULID.
 *
 * ## Why exactly these two, and why NOT "pure digits"
 *
 * The carve-out only ever MATTERS for values that would otherwise be
 * redacted — i.e. values matching a high-confidence PII pattern.
 * Ordinary identifiers that match no pattern (`Telecheck-US`,
 * `/v0/ai/chat`, `GET`, the 5-digit `23505`) pass through
 * `redactString` untouched and never needed an exemption at all.
 *
 * The one genuine collision is a **ULID that happens to contain exactly
 * nine consecutive digits**, which `us_ssn` matches. UUIDs cannot
 * collide (their hex runs are hyphen-separated at lengths that never
 * expose a bounded 9-digit run) but are included for symmetry and
 * future-proofing.
 *
 * A `^\d+$` shape was in an earlier draft and has been REMOVED. It let
 * `{"trace_id":"4111111111111111"}` preserve a Luhn-valid card number,
 * and it would equally have preserved a 9-digit SSN written into an id
 * field. Since no identifier in this codebase is a long pure-digit
 * string — ids are ULIDs and UUIDs, and short numeric codes survive
 * without any exemption — dropping it costs nothing real and closes
 * both holes.
 *
 * The residual is now narrow: a value must be a syntactically valid
 * UUID or ULID to be exempted, and neither shape can encode an email,
 * a phone number, a hyphenated SSN, or a card number.
 */
export function isPreservableIdentifier(value: string): boolean {
  return UUID_RE.test(value) || ULID_RE.test(value);
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
 * Redact a single serialized log line.
 *
 * ## Why a string-token scanner and NOT `JSON.parse` → walk → `JSON.stringify`
 *
 * The obvious implementation round-trips the record through
 * `JSON.parse`/`JSON.stringify`. That is **lossy**, and silently so:
 * `JSON.parse` coerces every JSON number to an IEEE-754 double, so any
 * integer beyond `Number.MAX_SAFE_INTEGER` (2^53−1) — a 64-bit id, a
 * BigInt-backed counter, a nanosecond timestamp — is rounded on the way
 * out. Parsing succeeds, so no failure sentinel fires; the value is just
 * quietly wrong. Corrupting an identifier inside the redaction layer
 * would destroy exactly the correlation evidence an incident needs.
 *
 * So this scans the serialized text instead and rewrites **only string
 * tokens**. Every number, boolean, null, and structural character is
 * copied through byte-for-byte. Numeric precision is preserved because
 * numeric lexemes are never interpreted.
 *
 * The scanner also tracks the enclosing key for each string value, which
 * is what gives identifier-key preservation. The carve-out applies ONLY
 * to a string that is the direct value of an object property; anything
 * inside an array or nested container is screened normally.
 *
 * Recursion is gone too: this is a single O(n) pass with an explicit
 * stack, so the depth bound that guarded the recursive walker is not
 * needed on this path at all.
 *
 * Fallback: if the line is not JSON (a pretty-print transport, a partial
 * chunk, a non-JSON warning), apply the whole-line regex instead. This
 * FAILS SAFE — an unparseable line is still scrubbed, it just loses the
 * identifier carve-out.
 */
export function redactLogLine(line: string): string {
  const trimmed = line.trimEnd();
  const newline = line.slice(trimmed.length);
  if (trimmed.length === 0) return line;

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    // Validate BEFORE scanning. `JSON.parse` is used purely as a
    // grammar check and its result is discarded — the scanner still
    // does the rewriting, so numeric lexemes are never interpreted and
    // precision is preserved.
    //
    // This validation is load-bearing, not belt-and-braces. The scanner
    // recognises quoted tokens but does not verify delimiters, balance,
    // or unquoted content, so without it a line like
    // `{email:real.person@example.com}` — which starts with `{` but is
    // not JSON — would be copied through verbatim, with the unquoted
    // email never reaching `redactString`.
    let valid = true;
    try {
      JSON.parse(trimmed);
    } catch {
      valid = false;
    }
    if (valid) {
      const scanned = redactJsonStringTokens(trimmed);
      if (scanned !== null) return scanned + newline;
    }
    // Not valid JSON — fall through to the whole-line pass.
  }
  return redactString(trimmed) + newline;
}

/**
 * Scan serialized JSON and redact only its string tokens, preserving
 * every other lexeme verbatim.
 *
 * @returns the rewritten JSON text, or `null` if the input is not
 *   well-formed enough to scan (caller falls back to a whole-line pass).
 */
function redactJsonStringTokens(text: string): string | null {
  let out = '';
  let i = 0;
  // Enclosing key per nesting level. An array pushes its own enclosing
  // key so its elements inherit it.
  const keyStack: Array<string | null> = [null];

  while (i < text.length) {
    const ch = text[i]!;

    if (ch === '"') {
      const token = readJsonString(text, i);
      if (token === null) return null;
      const { raw, decoded, next } = token;

      // A string is a KEY when the next non-whitespace char is ':'.
      let j = next;
      while (j < text.length && /\s/.test(text[j] ?? '')) j++;
      const isKey = text[j] === ':';

      if (isKey) {
        // Classify the carve-out on the ORIGINAL decoded key…
        keyStack[keyStack.length - 1] = decoded;
        // …but EMIT a redacted key.
        //
        // Property names are caller-shaped too. An earlier version
        // appended `raw` here, so a valid record like
        // `{"person@example.com":true}` wrote the email verbatim —
        // the same defect class already fixed in the `audit_bound`
        // payload walker (Sprint 1.1d), reintroduced here.
        //
        // Redacting keys is safe for the identifier keys we care about:
        // `consult_id`, `tenant_id`, `route` and friends match no
        // high-confidence pattern, so they pass through unchanged.
        const redactedKey = redactString(decoded);
        out += redactedKey === decoded ? raw : JSON.stringify(redactedKey);
      } else {
        // Preserve verbatim ONLY when BOTH hold: the enclosing key
        // names an identifier AND the value actually looks like one.
        // Key name alone is a deterministic bypass — see
        // `isPreservableIdentifier`.
        const enclosingKey = keyStack[keyStack.length - 1] ?? null;
        const preserve =
          enclosingKey !== null &&
          isIdentifierKey(enclosingKey) &&
          isPreservableIdentifier(decoded);
        out += preserve ? raw : JSON.stringify(redactString(decoded));
      }
      i = next;
      continue;
    }

    if (ch === '{') {
      keyStack.push(null);
      out += ch;
      i++;
      continue;
    }

    if (ch === '[') {
      // Array elements do NOT inherit the enclosing key.
      //
      // An earlier version pushed the current key so `notes: ["<pii>"]`
      // resolved under `notes`. That was wrong in the dangerous
      // direction: it also propagated IDENTIFIER keys into array
      // frames, and nested arrays kept re-inheriting, so
      // `{"request_id":[["person@example.com"]]}` preserved the email
      // verbatim — recreating the nested-subtree bypass the carve-out
      // is supposed to exclude.
      //
      // The carve-out is now strictly what it claims to be: it applies
      // only to a string that is the DIRECT value of an object
      // property. Anything inside a container is screened normally.
      // The cost is that a genuine id inside an array (an unusual
      // shape) gets scrubbed; that is the right side to err on.
      keyStack.push(null);
      out += ch;
      i++;
      continue;
    }

    if (ch === '}' || ch === ']') {
      if (keyStack.length > 1) keyStack.pop();
      out += ch;
      i++;
      continue;
    }

    // Numbers, booleans, null, whitespace, ':' and ',' — verbatim.
    // Numeric lexemes are deliberately never parsed.
    out += ch;
    i++;
  }

  return out;
}

/**
 * Read one JSON string token starting at `start` (which must index the
 * opening quote).
 *
 * @returns the raw token text (quotes + escapes intact), its decoded
 *   value, and the index just past the closing quote — or `null` if the
 *   token is unterminated or contains an invalid escape.
 */
function readJsonString(
  text: string,
  start: number,
): { raw: string; decoded: string; next: number } | null {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"') {
      const raw = text.slice(start, i + 1);
      try {
        const decoded = JSON.parse(raw) as string;
        if (typeof decoded !== 'string') return null;
        return { raw, decoded, next: i + 1 };
      } catch {
        return null;
      }
    }
    i++;
  }
  return null;
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
  // Carry-over buffer for a trailing line that arrived without its
  // terminating newline.
  //
  // ## Why this buffer is load-bearing, not an optimisation
  //
  // Transform streams do NOT guarantee that chunks align with
  // newline-delimited records. An earlier version treated every chunk
  // as line-complete, which meant a value split across a chunk boundary
  // — `real.person@ex` + `ample.com` — matched the regex in NEITHER
  // fragment. Both were forwarded unredacted and the destination
  // reassembled the original PII. A last-line defense that depends on
  // favourable chunking is not a defense.
  //
  // So only COMPLETE newline-terminated records are redacted and
  // emitted; any trailing partial line is held until its newline
  // arrives, and `flush` handles whatever remains at stream end.
  let carry = '';

  /**
   * Hard cap on the carry buffer. If a producer never emits a newline
   * we must not grow without bound. On overflow the buffer is redacted
   * and flushed as-is — fail-safe: the content is still scrubbed, it
   * just loses the guarantee that it was a complete record.
   */
  const MAX_CARRY_BYTES = 1_048_576; // 1 MiB

  const toText = (chunk: unknown): string =>
    typeof chunk === 'string'
      ? chunk
      : Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : String(chunk);

  const transform = new Transform({
    // Chunks are pino NDJSON text.
    decodeStrings: false,

    transform(chunk: unknown, _encoding, callback): void {
      try {
        carry += toText(chunk);

        const lastNewline = carry.lastIndexOf('\n');
        if (lastNewline === -1) {
          // No complete record yet. Hold — unless the buffer has grown
          // past the cap, in which case flush it scrubbed.
          if (carry.length > MAX_CARRY_BYTES) {
            const overflow = carry;
            carry = '';
            callback(null, redactChunk(overflow));
            return;
          }
          callback();
          return;
        }

        const complete = carry.slice(0, lastNewline + 1);
        carry = carry.slice(lastNewline + 1);
        callback(null, redactChunk(complete));
      } catch (err) {
        // Never let a redaction failure kill the log stream — that
        // would cost the operational record. Forward a sentinel line
        // instead so the loss is visible rather than silent.
        carry = '';
        callback(null, `{"level":50,"msg":"${LOG_REDACTION_FAILURE_SENTINEL}"}\n`);
        void err;
      }
    },

    flush(callback): void {
      try {
        if (carry.length === 0) {
          callback();
          return;
        }
        const remainder = carry;
        carry = '';
        callback(null, redactChunk(remainder));
      } catch (err) {
        carry = '';
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
