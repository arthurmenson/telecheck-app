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

const COPY_START = /^COPY\s+\S.*\s+FROM\s+stdin;\s*$/;
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
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      // The JSON-aware scanner keeps numbers verbatim and the output valid;
      // whole library via the redactor parameter.
      const leading = value.slice(0, value.length - value.trimStart().length);
      const trailing = value.slice(value.trimEnd().length);
      return leading + redactLogLine(trimmed, redactForBackup, zeroFillIfMatching) + trailing;
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

function scrubCopyField(raw: string): string {
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
    return encodeCopyField('\\x' + Buffer.from(scrubbed, 'utf8').toString('hex'));
  }
  const scrubbed = scrubValue(decoded);
  return scrubbed === decoded ? raw : encodeCopyField(scrubbed);
}

export function scrubCopyRow(line: string): string {
  const newline = line.endsWith('\n') ? '\n' : '';
  const body = newline ? line.slice(0, -1) : line;
  const cr = body.endsWith('\r') ? '\r' : '';
  const row = cr ? body.slice(0, -1) : body;
  return row.split('\t').map(scrubCopyField).join('\t') + cr + newline;
}

// ---------------------------------------------------------------------------
// SQL literal scrubbing with cross-line state
// ---------------------------------------------------------------------------

function decodeEscapeLiteral(content: string): string {
  let out = '';
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = content[i + 1];
    if (next === undefined) {
      out += '\\';
      break;
    }
    i++;
    switch (next) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'x': {
        const hex = content.slice(i + 1, i + 3).match(/^[0-9A-Fa-f]{1,2}/)?.[0] ?? '';
        if (hex.length === 0) out += 'x';
        else {
          out += String.fromCharCode(parseInt(hex, 16));
          i += hex.length;
        }
        break;
      }
      default: {
        const oct = content.slice(i, i + 3).match(/^[0-7]{1,3}/)?.[0];
        if (oct) {
          out += String.fromCharCode(parseInt(oct, 8));
          i += oct.length - 1;
        } else out += next; // `\\`, `\'`
      }
    }
  }
  return out;
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
  mode: 'code' | 'literal' | 'dollar';
  escapeLiteral: boolean;
  literal: string;
  dollarTag: string;
}

function scrubLiteral(content: string, escapeLiteral: boolean): string {
  const decoded = escapeLiteral ? decodeEscapeLiteral(content) : content.replace(/''/g, "'");
  const scrubbed = scrubValue(decoded);
  if (scrubbed === decoded) return content;
  return escapeLiteral ? encodeEscapeLiteral(scrubbed) : scrubbed.replace(/'/g, "''");
}

function scrubSqlText(text: string, st: SqlState): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
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
    if (st.mode === 'literal') {
      if (st.escapeLiteral && ch === '\\') {
        st.literal += ch + (text[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (ch === "'") {
        if (!st.escapeLiteral && text[i + 1] === "'") {
          st.literal += "''";
          i += 2;
          continue;
        }
        out += scrubLiteral(st.literal, st.escapeLiteral) + "'";
        st.mode = 'code';
        st.literal = '';
        i++;
        continue;
      }
      st.literal += ch;
      i++;
      continue;
    }
    // code
    if (ch === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i);
      if (nl === -1) {
        out += text.slice(i);
        return out;
      }
      out += text.slice(i, nl + 1);
      i = nl + 1;
      continue;
    }
    if (ch === '$') {
      const tag = text.slice(i).match(DOLLAR_TAG)?.[0];
      if (tag) {
        st.mode = 'dollar';
        st.dollarTag = tag;
        out += tag;
        i += tag.length;
        continue;
      }
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
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Line-oriented scrubber with state across lines
// ---------------------------------------------------------------------------

export interface DumpScrubber {
  /** Feed one line (with its trailing newline if it had one). Returns text to emit now. */
  push(line: string): string;
  /** Flush at end of input. */
  end(): string;
}

export function createDumpScrubber(): DumpScrubber {
  let inCopy = false;
  const sql: SqlState = { mode: 'code', escapeLiteral: false, literal: '', dollarTag: '' };
  return {
    push(line: string): string {
      if (inCopy) {
        if (COPY_END.test(line)) {
          inCopy = false;
          return line;
        }
        return scrubCopyRow(line);
      }
      if (sql.mode === 'code' && COPY_START.test(line)) {
        inCopy = true;
        return line;
      }
      return scrubSqlText(line, sql);
    },
    end(): string {
      if (sql.mode === 'literal') {
        // Unterminated literal at end of input: emit what we hold, scrubbed
        // as a value, so nothing buffered is lost or leaked.
        const held = scrubLiteral(sql.literal, sql.escapeLiteral);
        sql.literal = '';
        sql.mode = 'code';
        return held;
      }
      return '';
    },
  };
}
