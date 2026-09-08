/**
 * pii-screener/dump-scrub.ts — Layer 5: dump-aware redaction (Sprint 1.2c).
 *
 * A `pg_dump` plain-text dump is NOT a stream of prose. It is SQL — DDL,
 * `COPY ... FROM stdin` blocks with escaped tab-separated fields, INSERT
 * statements with quoted literals, dollar-quoted function bodies, comments.
 * Running a regex library over the serialized text (the first Layer 5 cut)
 * fails both ways, as Codex showed on the first review:
 *
 *   - MISSES: PostgreSQL escapes embedded newlines and tabs inside COPY
 *     fields (`MRN\n1234567`, `(415)\t555-0123`), JSON uses `\u` escapes,
 *     bytea is hex — the decoded value matches the library, the serialized
 *     bytes do not, and the "clean" artifact still holds recoverable PII.
 *   - CORRUPTS: `DEFAULT '{}'::jsonb` has a `::` that the IPv6 pattern
 *     matches; two tab-separated numeric fields merge into one token; a
 *     redacted numeric becomes invalid JSON. Header and size checks cannot
 *     see any of that.
 *
 * So this module scrubs ONLY inside decoded VALUES and never touches
 * syntax, delimiters, identifiers or bare numbers:
 *
 *   - COPY rows: split on real tabs (tabs inside values are escaped, so a
 *     raw tab is always a delimiter); per field: `\N` kept; the field is
 *     COPY-decoded, scrubbed as a value, re-encoded.
 *   - SQL text: only the contents of single-quoted string literals are
 *     scrubbed (`''` doubling and `E'...'` backslash escapes decoded and
 *     re-encoded; literals may span lines). Dollar-quoted blocks (function
 *     bodies) and `--` comments pass through untouched — they are code.
 *   - Values: a JSON value goes through the JSON-aware token scanner with
 *     the whole library (strings and property names scrubbed, non-matching
 *     numbers verbatim, a matching number replaced by 0 so it stays a
 *     number, output stays valid JSON); a bare numeric value that matches
 *     a pattern is replaced by 0 the same way (typed replacement — it stays
 *     an integer for an integer column); bytea hex that decodes to printable
 *     UTF-8 is scrubbed as text and re-hexed; other bytea passes through
 *     (ciphertext is not text); everything else gets the whole library.
 *
 * Framing invariants: a COPY row keeps its field count; a JSON value stays
 * parseable; a literal stays a literal; the line structure of the dump is
 * preserved (a literal that spans lines is emitted whole when it closes,
 * newlines included).
 */

import { redactForBackup } from './backup-redaction.js';
import { redactLogLine } from './log-redaction.js';

/** COPY header, tested on the complete statement once it closes in code mode. */
const COPY_START_MULTILINE = /^COPY\s[\s\S]*?\sFROM\s+stdin\s*;\s*$/i;
/** Any COPY statement at all — one that is not the header above is unsupported. */
const COPY_ANY = /^COPY\s/i;
const COPY_END = /^\\\.\s*$/;
const NUMERIC = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Typed replacement for a number that matches a pattern (bare or inside
 * JSON): replaced by 0 so an integer column stays an integer and a JSON
 * number stays a number. Non-matching numbers are verbatim.
 */
export function zeroFillIfMatching(rawNumber: string): string {
  // `0` is a valid literal for an integer or numeric column, a JSON number
  // and a bare SQL numeric; a digit-for-digit fill would produce leading
  // zeros, which JSON rejects.
  return redactForBackup(rawNumber) === rawNumber ? rawNumber : '0';
}

/** Scrub one decoded value. Exported for tests. */
export function scrubValue(value: string): string {
  if (value.length === 0) return value;
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    // A valid JSON scalar string (possibly fully or partly \u-escaped):
    // decode, scrub the decoded text, re-encode — never scrub the escaped
    // form (that either misses the value or breaks the escape).
    try {
      const decoded = JSON.parse(trimmed) as unknown;
      if (typeof decoded === 'string') {
        const leading = value.slice(0, value.length - value.trimStart().length);
        const trailing = value.slice(value.trimEnd().length);
        return leading + JSON.stringify(redactForBackup(decoded)) + trailing;
      }
    } catch {
      // not a JSON string — fall through to prose
    }
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      // The JSON-aware scanner keeps numbers verbatim and the output valid;
      // whole library via the redactor parameter.
      const leading = value.slice(0, value.length - value.trimStart().length);
      const trailing = value.slice(value.trimEnd().length);
      return (
        leading +
        redactLogLine(trimmed, redactForBackup, zeroFillIfMatching, { preserveNumbers: false }) +
        trailing
      );
    } catch {
      // not JSON — fall through
    }
  }
  if (NUMERIC.test(trimmed)) {
    // Typed replacement: a matching number becomes 0 so an integer column
    // stays an integer and a COPY row stays typed.
    return zeroFillIfMatching(value);
  }
  return redactForBackup(value);
}

// ---------------------------------------------------------------------------
// COPY text-format field encoding
// ---------------------------------------------------------------------------

export function decodeCopyField(field: string): string {
  let out = '';
  for (let i = 0; i < field.length; i++) {
    const ch = field[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = field[i + 1];
    if (next === undefined) {
      out += '\\';
      break;
    }
    i++;
    switch (next) {
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 't':
        out += '\t';
        break;
      case 'v':
        out += '\v';
        break;
      case 'x': {
        const hex = field.slice(i + 1, i + 3).match(/^[0-9A-Fa-f]{1,2}/)?.[0] ?? '';
        if (hex.length === 0) {
          out += 'x';
        } else {
          out += String.fromCharCode(parseInt(hex, 16));
          i += hex.length;
        }
        break;
      }
      default: {
        const oct = field.slice(i, i + 3).match(/^[0-7]{1,3}/)?.[0];
        if (oct) {
          out += String.fromCharCode(parseInt(oct, 8));
          i += oct.length - 1;
        } else {
          out += next; // `\\` -> `\`, `\.` etc.
        }
      }
    }
  }
  return out;
}

export function encodeCopyField(value: string): string {
  let out = '';
  for (const ch of value) {
    switch (ch) {
      case '\\':
        out += '\\\\';
        break;
      case '\b':
        out += '\\b';
        break;
      case '\f':
        out += '\\f';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      case '\v':
        out += '\\v';
        break;
      default:
        out += ch;
    }
  }
  return out;
}

function isPrintableUtf8(buf: Buffer): string | null {
  const text = buf.toString('utf8');
  if (Buffer.from(text, 'utf8').compare(buf) !== 0) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) return null;
  return text;
}

function scrubCopyField(raw: string, stats?: DumpScrubStats): string {
  if (raw === '\\N') return raw;
  const decoded = decodeCopyField(raw);
  if (/^\\x[0-9A-Fa-f]*$/.test(decoded)) {
    // bytea in hex form. Only text-like payloads are scrubbed; ciphertext
    // and binary pass through unchanged.
    const bytes = Buffer.from(decoded.slice(2), 'hex');
    const text = isPrintableUtf8(bytes);
    if (text === null) return raw;
    const scrubbed = scrubValue(text);
    if (scrubbed === text) return raw;
    if (stats) stats.redactedValues += 1;
    return encodeCopyField('\\x' + Buffer.from(scrubbed, 'utf8').toString('hex'));
  }
  const scrubbed = scrubValue(decoded);
  if (scrubbed === decoded) return raw;
  if (stats) stats.redactedValues += 1;
  return encodeCopyField(scrubbed);
}

export function scrubCopyRow(line: string, stats?: DumpScrubStats): string {
  const newline = line.endsWith('\n') ? '\n' : '';
  const body = newline ? line.slice(0, -1) : line;
  const cr = body.endsWith('\r') ? '\r' : '';
  const row = cr ? body.slice(0, -1) : body;
  if (row.includes('\r')) {
    // pg_dump escapes a CR inside a value as \r; a bare one is not a valid
    // text-format row and would be a newline to PostgreSQL. Fail closed.
    const err = new Error(
      'dump-scrub: unsupported bare carriage return inside a COPY row; aborting',
    );
    (err as { exitCode?: number }).exitCode = 4;
    throw err;
  }
  if (stats) stats.copyRows += 1;
  return (
    row
      .split('\t')
      .map((f) => scrubCopyField(f, stats))
      .join('\t') +
    cr +
    newline
  );
}

// ---------------------------------------------------------------------------
// SQL literal scrubbing with cross-line state
// ---------------------------------------------------------------------------

function decodeEscapeLiteral(content: string): string {
  // PostgreSQL's scanner: \ooo and \xhh yield BYTES (truncated to 8 bits),
  // \uXXXX / \UXXXXXXXX yield code points, and the resulting byte sequence
  // is read in the server encoding — UTF-8, which the wrapper forces. A
  // character-level decode let `E'\542@\543.\543\557'` (an email) through
  // and corrupted multibyte text around a redaction (Codex R10).
  const bytes: number[] = [];
  const pushText = (text: string) => {
    for (const b of Buffer.from(text, 'utf8')) bytes.push(b);
  };
  let i = 0;
  while (i < content.length) {
    const ch = content[i]!;
    if (ch !== '\\') {
      if (ch === "'" && content[i + 1] === "'") {
        bytes.push(0x27);
        i += 2;
        continue;
      }
      let j = i + 1;
      while (j < content.length && content[j] !== '\\' && content[j] !== "'") j++;
      pushText(content.slice(i, j));
      i = j;
      continue;
    }
    const next = content[i + 1];
    if (next === undefined) {
      bytes.push(0x5c);
      break;
    }
    i += 2;
    switch (next) {
      case 'n':
        bytes.push(0x0a);
        break;
      case 't':
        bytes.push(0x09);
        break;
      case 'r':
        bytes.push(0x0d);
        break;
      case 'b':
        bytes.push(0x08);
        break;
      case 'f':
        bytes.push(0x0c);
        break;
      case 'x': {
        const hex = content.slice(i, i + 2).match(/^[0-9A-Fa-f]{1,2}/)?.[0] ?? '';
        if (hex.length === 0) bytes.push(0x78);
        else {
          bytes.push(parseInt(hex, 16) & 0xff);
          i += hex.length;
        }
        break;
      }
      case 'u':
      case 'U': {
        const width = next === 'u' ? 4 : 8;
        const hex = content.slice(i, i + width);
        if (hex.length === width && /^[0-9A-Fa-f]+$/.test(hex)) {
          let code = parseInt(hex, 16);
          i += width;
          if (code >= 0xd800 && code <= 0xdbff) {
            // PostgreSQL accepts a high surrogate only when the very next
            // escape is its low half; a lone half is an error there and a
            // silent U+FFFD here — so fail closed instead.
            const low = content.slice(i, i + 6).match(/^\\u([Dd][C-Fc-f][0-9A-Fa-f]{2})/);
            if (!low) throw invalidEscapeSequence();
            code = 0x10000 + ((code - 0xd800) << 10) + (parseInt(low[1]!, 16) - 0xdc00);
            i += 6;
          } else if (code >= 0xdc00 && code <= 0xdfff) throw invalidEscapeSequence();
          let cp: string;
          try {
            cp = String.fromCodePoint(code);
          } catch {
            throw invalidEscapeSequence();
          }
          pushText(cp);
        } else pushText(next);
        break;
      }
      default: {
        const oct = content.slice(i - 1, i + 2).match(/^[0-7]{1,3}/)?.[0];
        if (oct) {
          bytes.push(parseInt(oct, 8) & 0xff);
          i += oct.length - 1;
        } else pushText(next); // `\\`, `\'`, and any other char stands for itself
      }
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    // PostgreSQL would have rejected this literal on a UTF8 database; a
    // lossy decode here would corrupt the value on re-encode.
    throw invalidEscapeSequence();
  }
}

function invalidEscapeSequence(): Error {
  const err = new Error(
    'dump-scrub: E-string escapes decode to an invalid UTF-8 sequence; aborting',
  );
  (err as { exitCode?: number }).exitCode = 4;
  return err;
}

function encodeEscapeLiteral(value: string): string {
  let out = '';
  for (const ch of value) {
    switch (ch) {
      case '\\':
        out += '\\\\';
        break;
      case "'":
        out += "\\'";
        break;
      case '\n':
        out += '\\n';
        break;
      case '\t':
        out += '\\t';
        break;
      case '\r':
        out += '\\r';
        break;
      default:
        out += ch;
    }
  }
  return out;
}

interface SqlState {
  mode: 'code' | 'literal' | 'dollar' | 'identifier' | 'blockcomment';
  /** Nesting depth while in a block comment (PostgreSQL nests them). */
  commentDepth: number;
  escapeLiteral: boolean;
  literal: string;
  dollarTag: string;
  /** Raw text of an open quoted identifier, held until it closes. */
  identifier: string;
  stats?: DumpScrubStats;
  /**
   * True when the last literal closed and only whitespace followed it on its
   * line. PostgreSQL joins a following literal that starts on the next line
   * into the same literal (E-mode carried over); that continuation is not
   * supported here and fails closed. (Codex R6.)
   */
  literalClosedAtLineEnd: boolean;
  /**
   * Comment-free, literal-masked text of the statement in progress (code
   * characters and identifiers verbatim; a literal contributes '' and a
   * dollar block $$). COPY-header recognition and statement termination
   * are decided on THIS, never on raw lines. (Codex R8.)
   */
  stmt: string;
  /**
   * Called with the finished statement text at its ACTUAL terminating `;`
   * (code mode, outside quotes and comments) — the only place a statement
   * boundary is decided. (Codex R9: per-line boundary handling dropped the
   * start of a COPY header that followed a semicolon on the same line.)
   */
  onStatementEnd?: (stmt: string) => void;
}

function scrubLiteral(content: string, escapeLiteral: boolean, stats?: DumpScrubStats): string {
  // Both literal kinds are decoded in ONE sequential pass: a regex
  // pre-replacement of '' overlapped a preceding \' and corrupted the
  // value (Codex R3).
  const decoded = escapeLiteral ? decodeEscapeLiteral(content) : content.replace(/''/g, "'");
  const scrubbed = scrubValue(decoded);
  if (scrubbed === decoded) return content;
  if (stats) stats.redactedValues += 1;
  return escapeLiteral ? encodeEscapeLiteral(scrubbed) : scrubbed.replace(/'/g, "''");
}

function scrubSqlText(text: string, st: SqlState): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (st.mode === 'blockcomment') {
      // Nested block comment: whitespace to PostgreSQL. Passed through
      // verbatim; contributes nothing to the statement text.
      if (text.startsWith('/*', i)) {
        st.commentDepth += 1;
        out += '/*';
        i += 2;
        continue;
      }
      if (text.startsWith('*/', i)) {
        st.commentDepth -= 1;
        out += '*/';
        i += 2;
        if (st.commentDepth === 0) {
          st.mode = 'code';
          st.stmt += ' ';
        }
        continue;
      }
      out += ch;
      i++;
      continue;
    }
    if (st.mode === 'dollar') {
      const end = text.indexOf(st.dollarTag, i);
      if (end === -1) {
        out += text.slice(i);
        return out;
      }
      out += text.slice(i, end + st.dollarTag.length);
      i = end + st.dollarTag.length;
      st.mode = 'code';
      continue;
    }
    if (st.mode === 'identifier') {
      // Continuation of a quoted identifier that spanned a line boundary:
      // keep holding it; emit only when it closes.
      let j = i;
      while (j < text.length) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      if (j >= text.length) {
        st.identifier += text.slice(i);
        return out;
      }
      out += st.identifier + text.slice(i, j + 1);
      st.stmt += st.identifier + text.slice(i, j + 1);
      st.identifier = '';
      i = j + 1;
      st.mode = 'code';
      continue;
    }
    if (st.mode === 'literal') {
      if (st.escapeLiteral && ch === '\\') {
        st.literal += ch + (text[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (ch === "'") {
        // A doubled quote is an escaped quote in BOTH literal kinds.
        if (text[i + 1] === "'") {
          st.literal += "''";
          i += 2;
          continue;
        }
        out += scrubLiteral(st.literal, st.escapeLiteral, st.stats) + "'";
        st.stmt += "''";
        st.mode = 'code';
        st.literal = '';
        i++;
        // A literal that closes with only whitespace — or a line comment,
        // which PostgreSQL treats as whitespace — after it on this line may
        // be continued by a literal on a later line (PostgreSQL joins them).
        st.literalClosedAtLineEnd = /^\s*(?:--[^\n]*)?\n?$/.test(text.slice(i));
        continue;
      }
      st.literal += ch;
      i++;
      continue;
    }
    // code
    if (ch === '/' && text[i + 1] === '*') {
      st.mode = 'blockcomment';
      st.commentDepth = 1;
      out += '/*';
      i += 2;
      continue;
    }
    if (ch === '-' && text[i + 1] === '-') {
      // A line comment ends at LF or CR (PostgreSQL treats both as
      // newlines); it contributes nothing to the statement text.
      const lf = text.indexOf('\n', i);
      const cr = text.indexOf('\r', i);
      const end = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr);
      if (end === -1) {
        out += text.slice(i);
        return out;
      }
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') {
        // CRLF line ending: pass through; the LF below is the newline.
        out += ch;
        i++;
        continue;
      }
      // A bare CR is a newline to PostgreSQL but not to this line-oriented
      // scanner: reject rather than mis-lex what follows it. (Codex R8.)
      const err = new Error('dump-scrub: unsupported bare carriage return in SQL text; aborting');
      (err as { exitCode?: number }).exitCode = 4;
      throw err;
    }
    if (ch === '$') {
      const tag = text.slice(i).match(DOLLAR_TAG)?.[0];
      if (tag) {
        st.mode = 'dollar';
        st.dollarTag = tag;
        st.stmt += '$$';
        out += tag;
        i += tag.length;
        continue;
      }
    }
    if (ch === '"') {
      // Quoted identifier: its content is a NAME, passed through verbatim
      // once it closes (a doubled quote is an escaped quote; an apostrophe
      // inside must not open a literal). If it does not close on this line
      // it is HELD, not emitted — an unterminated identifier leaks nothing.
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      if (j >= text.length) {
        st.mode = 'identifier';
        st.identifier = text.slice(i);
        return out;
      }
      out += text.slice(i, j + 1);
      st.stmt += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "'") {
      const prev = text[i - 1];
      const prevPrev = text[i - 2];
      st.escapeLiteral =
        (prev === 'E' || prev === 'e') &&
        (prevPrev === undefined || !/[A-Za-z0-9_]/.test(prevPrev));
      st.mode = 'literal';
      st.literal = '';
      out += ch;
      i++;
      continue;
    }
    out += ch;
    st.stmt += ch;
    if (ch === ';') {
      // The statement ends HERE, not at the end of the physical line: decide
      // it now and start accumulating the next one.
      const finished = st.stmt;
      st.stmt = '';
      st.onStatementEnd?.(finished);
    }
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Line-oriented scrubber with state across lines
// ---------------------------------------------------------------------------

export interface DumpScrubStats {
  /** COPY fields and SQL literals whose scrubbed form differed from the decoded value. */
  redactedValues: number;
  /** COPY data rows seen. */
  copyRows: number;
}

export interface DumpScrubber {
  /** Live accounting for the run (value-level, never the values themselves). */
  readonly stats: DumpScrubStats;
  /** Feed one line (with its trailing newline if it had one). Returns text to emit now. */
  push(line: string): string;
  /** Flush at end of input. */
  end(): string;
}

export function createDumpScrubber(): DumpScrubber {
  let inCopy = false;
  const stats: DumpScrubStats = { redactedValues: 0, copyRows: 0 };
  const sql: SqlState = {
    mode: 'code',
    escapeLiteral: false,
    literal: '',
    dollarTag: '',
    identifier: '',
    stats,
    literalClosedAtLineEnd: false,
    stmt: '',
    commentDepth: 0,
  };
  // Physical lines of the statement in progress while a quoted identifier,
  // literal or dollar block is open. A COPY header is recognised ONLY when
  // the statement closes in code mode with `FROM stdin;` at its end — never
  // from a single-line shortcut that runs before the quote state is known
  // (Codex R4: a table named public."a FROM stdin;<newline>\\.<newline>b"
  // activated COPY early, its embedded terminator ended it, and the real
  // rows bypassed scrubbing).
  // Beyond the cap a pending statement FAILS CLOSED — never a fallback to
  // SQL passthrough (Codex R5). The budget covers EVERY pending buffer —
  // statement text, an open identifier, an open literal — on every push, so
  // nothing can grow unbounded before a closing quote or EOF (Codex R9).
  const STMT_CAP = 1024 * 1024;
  let activateCopy = false;
  let afterCopyHeader = false;
  sql.onStatementEnd = (stmt) => {
    // A statement completing after a pending COPY activation is content on
    // the header line — it would otherwise be mis-lexed as the first row.
    if (activateCopy) afterCopyHeader = true;
    else if (COPY_START_MULTILINE.test(stmt.trim())) activateCopy = true;
    else if (COPY_ANY.test(stmt.trim())) {
      // `COPY ... TO stdout`, `COPY ... FROM '/file'`, WITH options: pg_dump
      // plain format never emits them; the rows that might follow would be
      // lexed as SQL, so fail closed instead (Codex R10).
      const err = new Error('dump-scrub: unsupported COPY statement form; aborting');
      (err as { exitCode?: number }).exitCode = 4;
      throw err;
    }
  };
  return {
    stats,
    push(line: string): string {
      if (inCopy) {
        if (COPY_END.test(line)) {
          inCopy = false;
          return line;
        }
        return scrubCopyRow(line, stats);
      }
      if (sql.literalClosedAtLineEnd) {
        // Whitespace-only lines (any \s, so \f and \v too) and `--` comment
        // lines are whitespace to PostgreSQL: the continuation question stays
        // open across them. It is settled only by a real token — a quote
        // (rejected) or anything else (cleared). (Codex R7.)
        if (/^\s*'/.test(line)) {
          const err = new Error(
            'dump-scrub: unsupported string-literal continuation across a newline; aborting',
          );
          (err as { exitCode?: number }).exitCode = 4;
          throw err;
        }
        if (!/^\s*(?:--[^\n\r]*)?\s*$/.test(line)) sql.literalClosedAtLineEnd = false;
      }
      // Enforced BEFORE the line is accumulated or decoded: a line that
      // closes a buffer, or a complete oversized literal, must not incur the
      // allocation the guard exists to prevent (Codex R10).
      const pending = sql.stmt.length + sql.identifier.length + sql.literal.length;
      if (pending + line.length > STMT_CAP) {
        const err = new Error(
          `dump-scrub: pending statement exceeds ${STMT_CAP} bytes before closing; aborting so no row is passed through unscreened`,
        );
        (err as { exitCode?: number }).exitCode = 4;
        throw err;
      }
      const out = scrubSqlText(line, sql);
      if (activateCopy) {
        activateCopy = false;
        // A real dump puts nothing after `FROM stdin;` on the header line;
        // anything else there would be mis-lexed as the first row.
        if (afterCopyHeader || sql.mode !== 'code' || sql.stmt.trim().length > 0) {
          afterCopyHeader = false;
          const err = new Error(
            'dump-scrub: unsupported content after a COPY header on the same line; aborting',
          );
          (err as { exitCode?: number }).exitCode = 4;
          throw err;
        }
        inCopy = true;
      }
      return out;
    },
    end(): string {
      if (/^\s*COPY\s/.test(sql.stmt)) {
        const err = new Error('dump-scrub: unterminated COPY statement at end of input');
        (err as { exitCode?: number }).exitCode = 4;
        throw err;
      }
      if (
        sql.mode === 'literal' ||
        sql.mode === 'dollar' ||
        sql.mode === 'identifier' ||
        sql.mode === 'blockcomment'
      ) {
        // An unterminated literal / dollar block / identifier at end of
        // input is not a valid dump: fail closed rather than guess.
        const err = new Error(`dump-scrub: unterminated ${sql.mode} at end of input`);
        (err as { exitCode?: number }).exitCode = 4;
        throw err;
      }
      return '';
    },
  };
}
