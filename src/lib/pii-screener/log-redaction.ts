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
 * ## No shape-based trust for strings
 *
 * EVERY string value and property name is screened. There is no
 * identifier carve-out on the string path.
 *
 * Earlier drafts had one — first keyed on the key NAME alone, then on
 * key name plus a UUID/ULID value SHAPE. Codex found a bypass in each.
 * The second is instructive: a 26-character Crockford string containing
 * a nine-digit run is a syntactically valid ULID, so shape-based trust
 * emitted it verbatim.
 *
 * The deeper lesson is that inferring trust from shape is the wrong
 * instinct for a layer whose premise is that Layers 1 and 2 already
 * failed. Each carve-out was one more thing to get right, and each was
 * gotten wrong.
 *
 * Removing it costs little. Real identifiers do not match the
 * high-confidence patterns and survive untouched with no exemption:
 * `Telecheck-US`, `/v0/ai/chat`, `23505`, and any UUID (whose hex runs
 * are hyphen-separated at lengths that never expose a bounded
 * nine-digit run). The only casualty is the rare ULID that happens to
 * contain nine consecutive digits — roughly one in two thousand.
 *
 * NUMBERS keep the one remaining carve-out, because pino writes a
 * 13-digit ms epoch on every line and screening it mangled `time` on
 * ~10% of records. It is an explicit closed allowlist — see
 * NUMERIC_PRESERVE_RULES — requiring BOTH an exact case-sensitive
 * root-relative path AND a value inside that field's real domain. Both
 * halves are load-bearing: the path closes nested key shadowing, and
 * the domain closes a merge object colliding with a root field name.
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
import { StringDecoder } from 'node:string_decoder';

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
 * Record positions whose NUMERIC values are preserved verbatim.
 *
 * This is the ONLY carve-out left anywhere in the redactor. Strings have
 * none — every string value and property name is screened. Numbers keep
 * one because pino emits `"time":<13-digit ms epoch>` on every single
 * line, and 13 digits sits inside the credit-card pattern's 13–19 digit
 * range, so roughly one timestamp in ten is Luhn-valid by chance.
 * Screening numbers with no carve-out mangled `time` on ~10% of lines.
 *
 * It is a small, closed, explicit set — never a generative `*_id` rule.
 * A generative rule would let `{"patient_id":123456789}` preserve a bare
 * SSN and `{"trace_id":4111111111111111}` a Luhn-valid card.
 *
 * ## Position AND value, because position alone is not provenance
 *
 * Preservation requires BOTH an exact root-relative path AND a value
 * inside that field's real domain.
 *
 * Position was added first, to close nested shadowing: a bare key set is
 * depth-blind, so `{"payload":{"time":3125551212}}` preserved a phone
 * number because the inner key spelled `time`.
 *
 * But position alone still trusts location rather than origin. The
 * scanner sees serialized bytes and cannot tell whether pino wrote a
 * root field or an application merge object collided with the name, so
 * `logger.info({ time: 3125551212 }, 'x')` put a phone number at root
 * `time` and it was preserved.
 *
 * Value validation is what actually closes that, and it is available
 * here precisely because these fields are machine-written with narrow
 * domains — a ms epoch, a PID, a log level, an HTTP status, a duration.
 * Nothing matching `us_ssn` (9 digits) or `us_phone` (10 digits) fits
 * any of them.
 *
 * Paths are matched CASE-SENSITIVELY. pino and Fastify write these names
 * in exactly one spelling, so accepting `Time` or `STATUSCODE` only
 * widens the surface.
 *
 * ## Known residual, and why it is the floor
 *
 * A 13-digit Luhn-valid integer inside the epoch window is preserved at
 * `time`. That is not closable: a legitimate ms epoch IS a 13-digit
 * integer in that window, and about one in ten is Luhn-valid by chance.
 * Distinguishing it from a 13-digit card number is impossible from the
 * value alone, and screening it is what mangled `time` on ~10% of lines
 * in the first place. Every other field's domain excludes every
 * high-confidence pattern outright.
 */
interface NumericPreserveRule {
  /** Exact root-relative path, case-sensitive. */
  readonly path: string;
  /**
   * Domain test for the value. Receives the parsed number — safe because
   * the RAW lexeme is what gets emitted, so this parse only informs a
   * boolean and can never round-trip a value into the output.
   */
  readonly accepts: (value: number) => boolean;
}

const NUMERIC_PRESERVE_RULES: readonly NumericPreserveRule[] = [
  {
    // pino's ms epoch. Bounded to 2010-01-01 .. 2100-01-01, which is
    // 13 digits throughout — so a 9-digit SSN or 10-digit phone placed
    // here falls outside and is screened.
    //
    // Deliberately NOT widened to accept epoch SECONDS. A 10-digit
    // seconds epoch is indistinguishable from a bare phone number, and
    // admitting that range would reopen the hole. If pino is ever
    // reconfigured to seconds, timestamps get redacted — loud, safe, and
    // immediately noticeable.
    path: 'time',
    accepts: (v) => Number.isInteger(v) && v >= 1_262_304_000_000 && v <= 4_102_444_800_000,
  },
  {
    // Linux caps PID at 2^22; 7 digits max excludes every pattern.
    path: 'pid',
    accepts: (v) => Number.isInteger(v) && v >= 1 && v <= 4_194_304,
  },
  {
    // pino levels run 10..70; custom levels are permitted, so allow a
    // little headroom while staying far below any pattern's digit count.
    path: 'level',
    accepts: (v) => Number.isInteger(v) && v >= 0 && v <= 100,
  },
  {
    // Fastify duration in ms, fractional. Capped at 24h — well below the
    // 9-digit floor of the shortest high-confidence numeric pattern.
    path: 'responseTime',
    accepts: (v) => Number.isFinite(v) && v >= 0 && v < 86_400_000,
  },
  // HTTP status. Root-level under some configurations, under pino's
  // default `res` serializer in others; both fixed positions are listed
  // rather than allowing the key at any depth.
  {
    path: 'statusCode',
    accepts: (v) => Number.isInteger(v) && v >= 100 && v <= 599,
  },
  {
    path: 'res.statusCode',
    accepts: (v) => Number.isInteger(v) && v >= 100 && v <= 599,
  },
];

const NUMERIC_PRESERVE_BY_PATH: ReadonlyMap<string, NumericPreserveRule> = new Map(
  NUMERIC_PRESERVE_RULES.map((rule) => [rule.path, rule]),
);

/**
 * Resolve the root-relative path of the value currently being scanned.
 *
 * `keyStack[0]` is the pre-root sentinel and is dropped. A `null` frame
 * means an ARRAY is somewhere in the path; array elements have no key,
 * so no allowlist entry can legitimately describe them and the path is
 * reported as unresolvable (never preserved).
 */
function resolveNumericPath(keyStack: ReadonlyArray<string | null>): string | null {
  if (keyStack.length < 2) return null;
  const parts: string[] = [];
  for (let i = 1; i < keyStack.length; i++) {
    const frame = keyStack[i];
    if (frame == null) return null;
    parts.push(frame);
  }
  return parts.join('.');
}

/**
 * Decide whether a numeric lexeme may be emitted verbatim.
 *
 * Requires an exact path match AND a value inside that field's domain.
 * The raw lexeme is always what gets emitted; `Number(raw)` here only
 * feeds the boolean.
 */
function shouldPreserveNumber(keyStack: ReadonlyArray<string | null>, raw: string): boolean {
  const path = resolveNumericPath(keyStack);
  if (path === null) return false;
  const rule = NUMERIC_PRESERVE_BY_PATH.get(path);
  if (rule === undefined) return false;
  const value = Number(raw);
  if (Number.isNaN(value)) return false;
  return rule.accepts(value);
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
        // EVERY string value is screened. There is no carve-out.
        //
        // Earlier drafts exempted values under identifier keys — first
        // on key name alone, then on key name plus a UUID/ULID value
        // shape. Codex found a bypass in each, and the second one is
        // instructive: a 26-character Crockford string containing a
        // nine-digit run is a syntactically valid ULID, so shape-based
        // trust preserved it verbatim.
        //
        // The deeper problem is that inferring trust from shape is the
        // wrong instinct for a layer whose entire premise is that
        // Layers 1 and 2 already failed. Each carve-out was another
        // thing to get right, and each was gotten wrong.
        //
        // Removing it costs almost nothing in practice. Real
        // identifiers do not match the high-confidence patterns at all
        // and so survive untouched with no exemption needed:
        // `Telecheck-US`, `/v0/ai/chat`, `23505`, and any UUID (whose
        // hex runs are hyphen-separated at lengths that never expose a
        // bounded nine-digit run). The only casualty is the rare ULID
        // that happens to contain nine consecutive digits — roughly one
        // in two thousand — which is redacted with a token naming the
        // pattern, in a record that still carries its other identifiers.
        //
        // Losing correlation on one identifier occasionally is a better
        // trade than a standing rule that emits caller-influenced values
        // unscreened.
        out += JSON.stringify(redactString(decoded));
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

    // Numeric lexemes.
    //
    // An earlier version copied every number through verbatim, on the
    // reasoning that parsing them loses precision. That was true but
    // over-applied: it meant `{"ssn":123456789}` and
    // `{"card":4111111111111111}` — valid JSON NUMBERS matching
    // high-confidence patterns — reached the destination unredacted.
    //
    // The two goals are not in conflict. The lexeme is screened AS TEXT
    // and never converted to a Number, so a non-matching number is
    // still emitted byte-for-byte and precision is preserved; a
    // matching one is replaced with a JSON-encoded redaction token.
    // Replacing a number with a string changes the JSON type, which is
    // inherent to redacting it at all.
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const num = readJsonNumber(text, i);
      if (num !== null) {
        // Numbers are preserved ONLY at the explicitly allowlisted
        // record positions. This is the sole carve-out in the redactor.
        //
        // Why one is needed at all: pino emits `"time":<ms epoch>` on
        // EVERY line, a 13-digit number, and 13 digits sits inside the
        // credit-card pattern's 13–19 digit range — so roughly one
        // timestamp in ten is Luhn-valid by chance. Screening numbers
        // with no carve-out mangled `time` on ~10% of all log lines.
        //
        // Why it must NOT be a generative `*_id` / `*Id` rule: that
        // would preserve a bare SSN under `{"patient_id":123456789}` and
        // a Luhn-valid card under `{"trace_id":4111111111111111}`. The
        // string path once had such a rule (paired with a UUID/ULID
        // value-shape test) and it was removed as unsound. A number has
        // no shape to test at all, so nothing would compensate here.
        //
        // Preservation requires BOTH an exact root-relative path AND a
        // value inside that field's domain — see NUMERIC_PRESERVE_RULES.
        // Matching the immediate key let a caller-shaped subtree shadow a
        // trusted name (`{"payload":{"time":3125551212}}`); matching the
        // path alone still trusted location over provenance, since an
        // application merge object can collide with a root field name
        // (`logger.info({ time: 3125551212 }, 'x')`).
        // Every allowlisted field sits at a fixed position in the record,
        // so requiring the position costs nothing.
        out += shouldPreserveNumber(keyStack, num.raw)
          ? num.raw
          : redactNumericLexeme(num.raw);
        i = num.next;
        continue;
      }
    }

    // Booleans, null, whitespace, ':' and ',' — verbatim.
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
   * we must not grow without bound.
   *
   * ## On overflow the record is DROPPED, not flushed
   *
   * An earlier version redacted and emitted the oversized carry, then
   * cleared it — and that reintroduced the very leak the carry buffer
   * exists to prevent. If the emitted portion ends mid-token
   * (`real.person@ex`) and the next chunk opens with the remainder
   * (`ample.com`), neither fragment matches independently and the
   * destination concatenates them back into the original value. So the
   * overflow path became a deliberate way to defeat Layer 3.
   *
   * Retaining an overlap does not fix it either: the overlap would be
   * emitted twice, corrupting the record.
   *
   * A >1 MiB line with no terminator is not a legitimate pino record —
   * pino always terminates its writes. So the honest handling is to
   * discard it and say so: emit a sentinel, then keep discarding until
   * the next newline resynchronises the stream. Nothing from the
   * buffer reaches the destination, so nothing can be reassembled.
   */
  const MAX_CARRY_BYTES = 1_048_576; // 1 MiB

  /**
   * Set after an overflow drop. While true, input is discarded until a
   * newline is seen — otherwise the tail of the dropped record would be
   * treated as a fresh line and partially emitted.
   */
  let discardingUntilNewline = false;

  /**
   * UTF-8 byte length of `carry`, maintained incrementally.
   *
   * The cap is a BYTE cap, so it must be measured in bytes.
   * `string.length` counts UTF-16 code units, which understates UTF-8
   * size for any non-ASCII content — a record of ~1,048,575 CJK
   * characters passes a code-unit check while occupying roughly 3 MiB.
   *
   * Recomputing `Buffer.byteLength(carry)` on every chunk would be
   * O(carry) per chunk and quadratic across a large record, so the
   * count is carried incrementally: add the byte length of each
   * incoming chunk, subtract the byte length of each consumed record.
   *
   * ## It is an UPPER BOUND, not an exact count — and that is enough
   *
   * Per-chunk accumulation can OVERCOUNT when a UTF-16 surrogate pair
   * is split across two chunks: each half measures as 3 bytes on its
   * own (6 total) while the combined astral character is 4. Subtracting
   * a consumed record's exact length does not reclaim that excess, so
   * the counter can drift upward — and drift in this direction would
   * eventually drop a perfectly valid near-cap record and emit a false
   * oversized sentinel.
   *
   * Crucially the drift is always POSITIVE: chunk-wise measurement can
   * overcount but never undercount. So `carryBytes <= cap` proves the
   * true size is also `<= cap`, and the fast path is sound as-is.
   *
   * Only when the estimate EXCEEDS the cap does exactness matter, and
   * there we recompute `Buffer.byteLength(carry)` once to resynchronise
   * before acting. That keeps the common path O(chunk) while making the
   * decision itself exact — no valid record is dropped on drift alone.
   */
  let carryBytes = 0;

  /**
   * Resynchronise the estimate to the true UTF-8 size. Called only when
   * the upper-bound estimate has crossed the cap, so the O(carry) cost
   * is paid at most once per threshold crossing rather than per chunk.
   */
  const exactCarryBytes = (): number => {
    carryBytes = Buffer.byteLength(carry, 'utf8');
    return carryBytes;
  };

  /**
   * Persistent streaming UTF-8 decoder for Buffer input.
   *
   * `Buffer.toString('utf8')` per chunk is WRONG here: Node may divide a
   * valid multibyte UTF-8 character between Buffer chunks, and decoding
   * each fragment independently turns both halves into U+FFFD
   * replacement characters. The destination then receives corrupted log
   * content even though the original byte stream was perfectly valid —
   * and the corruption happens before `carry` is assembled, so no
   * downstream fix can recover it.
   *
   * `StringDecoder` holds an incomplete trailing sequence until the
   * bytes that finish it arrive, emitting only complete characters.
   * `flush` drains whatever it is still holding.
   */
  const decoder = new StringDecoder('utf8');

  const toText = (chunk: unknown): string =>
    typeof chunk === 'string'
      ? chunk
      : Buffer.isBuffer(chunk)
        ? decoder.write(chunk)
        : String(chunk);

  const transform = new Transform({
    // Chunks are pino NDJSON text.
    decodeStrings: false,

    transform(chunk: unknown, _encoding, callback): void {
      try {
        let text = toText(chunk);

        // Resynchronise after an overflow drop: throw away everything
        // up to and including the next newline.
        if (discardingUntilNewline) {
          const nl = text.indexOf('\n');
          if (nl === -1) {
            callback();
            return;
          }
          discardingUntilNewline = false;
          text = text.slice(nl + 1);
        }

        carry += text;
        carryBytes += Buffer.byteLength(text, 'utf8');

        // Process RECORD BY RECORD so the size cap is enforced per
        // record, independent of how the producer happened to chunk.
        //
        // An earlier version only checked the cap when the chunk
        // contained no newline at all. That made the bound
        // chunking-dependent: a chunk that both pushed the record past
        // 1 MiB AND supplied its newline took the normal path, so the
        // oversized record was buffered and redacted anyway. It did not
        // leak (the whole record was redacted together) but it broke
        // the resource invariant the cap exists to hold.
        let out = '';
        for (;;) {
          const nl = carry.indexOf('\n');
          if (nl === -1) break;
          const record = carry.slice(0, nl + 1);
          carry = carry.slice(nl + 1);
          const recordBytes = Buffer.byteLength(record, 'utf8');
          carryBytes -= recordBytes;
          if (recordBytes > MAX_CARRY_BYTES) {
            // Oversized even though terminated — drop it rather than
            // spend unbounded work redacting it.
            out += `{"level":50,"msg":"${LOG_OVERSIZED_LINE_SENTINEL}"}\n`;
          } else {
            out += redactLogLine(record);
          }
        }

        // Trailing partial record: hold it unless it has already blown
        // the cap, in which case DROP it (see MAX_CARRY_BYTES) — never
        // emit part of it, or the destination could reassemble a token
        // split across the emission boundary.
        // The estimate is an upper bound, so only a crossing warrants
        // the exact recount — and the drop decision is then made on the
        // true size, never on accumulated surrogate-split drift.
        if (carryBytes > MAX_CARRY_BYTES && exactCarryBytes() > MAX_CARRY_BYTES) {
          carry = '';
          carryBytes = 0;
          discardingUntilNewline = true;
          out += `{"level":50,"msg":"${LOG_OVERSIZED_LINE_SENTINEL}"}\n`;
        }

        callback(null, out.length > 0 ? out : undefined);
      } catch (err) {
        // Never let a redaction failure kill the log stream — that
        // would cost the operational record. Forward a sentinel line
        // instead so the loss is visible rather than silent.
        carry = '';
        carryBytes = 0;
        callback(null, `{"level":50,"msg":"${LOG_REDACTION_FAILURE_SENTINEL}"}\n`);
        void err;
      }
    },

    flush(callback): void {
      try {
        // Drain any bytes the streaming decoder is still holding.
        carry += decoder.end();
        if (carry.length === 0) {
          callback();
          return;
        }
        const remainder = carry;
        carry = '';
        carryBytes = 0;
        callback(null, redactChunk(remainder));
      } catch (err) {
        carry = '';
        carryBytes = 0;
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

/**
 * Emitted in place of an unterminated line that exceeded the carry cap.
 * The record is DROPPED rather than partially emitted — see
 * MAX_CARRY_BYTES for why partial emission is unsafe.
 */
export const LOG_OVERSIZED_LINE_SENTINEL = 'log-redaction:oversized-unterminated-line-dropped';

/**
 * Read one JSON number lexeme starting at `start`.
 *
 * Grammar per RFC 8259: `-? (0 | [1-9][0-9]*) (. [0-9]+)? ([eE] [+-]? [0-9]+)?`
 *
 * The lexeme is returned as TEXT and never converted to a Number, so a
 * caller can screen it for PII patterns while still emitting
 * non-matching values byte-for-byte — preserving 64-bit ids,
 * nanosecond timestamps, and exact float formatting.
 *
 * @returns the raw lexeme and the index just past it, or `null` if the
 *   text at `start` is not a well-formed number.
 */
function readJsonNumber(
  text: string,
  start: number,
): { raw: string; next: number } | null {
  let i = start;
  if (text[i] === '-') i++;

  // Integer part.
  if (text[i] === '0') {
    i++;
  } else if (text[i] !== undefined && text[i]! >= '1' && text[i]! <= '9') {
    while (i < text.length && text[i]! >= '0' && text[i]! <= '9') i++;
  } else {
    return null;
  }

  // Fraction.
  if (text[i] === '.') {
    i++;
    const fracStart = i;
    while (i < text.length && text[i]! >= '0' && text[i]! <= '9') i++;
    if (i === fracStart) return null;
  }

  // Exponent.
  if (text[i] === 'e' || text[i] === 'E') {
    i++;
    if (text[i] === '+' || text[i] === '-') i++;
    const expStart = i;
    while (i < text.length && text[i]! >= '0' && text[i]! <= '9') i++;
    if (i === expStart) return null;
  }

  return { raw: text.slice(start, i), next: i };
}

/**
 * Screen a JSON numeric lexeme, returning either the original lexeme
 * verbatim or a JSON-encoded redaction token.
 *
 * ## Whole-lexeme matching only
 *
 * Unlike free text, a bare number must match a pattern in its ENTIRETY
 * to count. Substring matching produces both false positives and
 * corruption: the US-phone pattern happily matches a 10-digit run
 * inside `9007199254740993`, which would rewrite a legitimate 64-bit
 * identifier as `900719[REDACTED:US phone number]` — mangling the value
 * while protecting nothing.
 *
 * A phone number embedded in a longer digit run is not a phone number.
 * So each high-confidence pattern is anchored to the full lexeme.
 *
 * The lexeme is never converted to a Number, so a non-matching value is
 * returned byte-for-byte and precision is preserved.
 */
function redactNumericLexeme(raw: string): string {
  for (const pattern of PII_PATTERNS) {
    if (pattern.confidence !== 'high_confidence') continue;
    const anchored = new RegExp(
      `^(?:${pattern.regex.source})$`,
      pattern.regex.flags.replace(/g/g, ''),
    );
    if (!anchored.test(raw)) continue;
    if (pattern.validate && !pattern.validate(raw)) continue;
    return JSON.stringify(redactionToken(pattern.label));
  }
  return raw;
}
