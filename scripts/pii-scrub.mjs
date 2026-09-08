#!/usr/bin/env node
/**
 * pii-scrub.mjs — Layer 5 backup redaction CLI (Sprint 1.2c).
 *
 *   pg_dump ... | node --import tsx scripts/pii-scrub.mjs --mode backup | age -R recipients
 *
 * Reads stdin, writes stdout. FAIL CLOSED:
 *   - a line longer than --max-line-bytes (default 64 MiB), complete or
 *     unterminated, aborts the run with exit 3 — never dropped, never
 *     partially emitted (a dropped row would make a backup look valid while
 *     silently missing data);
 *   - any redaction error aborts with exit 4;
 *   - usage error exits 2.
 * Only complete newline-terminated lines are processed and emitted; a
 * trailing partial line is held until its newline or end of input, so a
 * value split across two chunks is never seen in halves.
 *
 * --mode backup  dump-aware, whole library (Layer 5, default): scrubs only
 *                inside decoded values — COPY fields and SQL string literals —
 *                never syntax, delimiters, identifiers or bare numbers
 *                (see src/lib/pii-screener/dump-scrub.ts)
 * --mode log     Layer 3's JSON-aware log-line pass (incident capture reuse)
 *
 * NER is deliberately not on this path (Layer 3 is ratified regex-only; the
 * local NER decision is unratified).
 */
import process from 'node:process';

import { createDumpScrubber } from '../src/lib/pii-screener/dump-scrub.ts';
import { redactLogLine } from '../src/lib/pii-screener/log-redaction.ts';

const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

function usage(code) {
  process.stderr.write(
    'usage: node --import tsx scripts/pii-scrub.mjs [--mode backup|log] [--max-line-bytes N] < in > out\n',
  );
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { mode: 'backup', maxLineBytes: DEFAULT_MAX_LINE_BYTES };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') {
      const v = argv[++i];
      if (v !== 'backup' && v !== 'log') usage(2);
      opts.mode = v;
    } else if (a === '--max-line-bytes') {
      const v = Number(argv[++i]);
      if (!Number.isSafeInteger(v) || v <= 0) usage(2);
      opts.maxLineBytes = v;
    } else if (a === '--help' || a === '-h') usage(0);
    else usage(2);
  }
  return opts;
}

function oversized(max) {
  const err = new Error(
    `pii-scrub: line exceeds --max-line-bytes (${max}); aborting so no row is silently dropped`,
  );
  err.exitCode = 3;
  return err;
}

export async function scrubStream(input, output, opts) {
  const dump = opts.mode === 'backup' ? createDumpScrubber() : null;
  const redact = dump ? (line) => dump.push(line) : redactLogLine;
  let carry = '';
  let carryBytes = 0;
  let lines = 0;
  let redactedLines = 0;

  const emit = (line) => {
    const out = redact(line);
    lines += 1;
    if (out !== line) redactedLines += 1;
    return out;
  };
  const write = async (text) => {
    if (text.length > 0 && !output.write(text)) {
      await new Promise((resolve) => output.once('drain', resolve));
    }
  };

  input.setEncoding('utf8');
  for await (const chunk of input) {
    carry += chunk;
    carryBytes += Buffer.byteLength(chunk, 'utf8');
    let nl;
    let out = '';
    while ((nl = carry.indexOf('\n')) !== -1) {
      const line = carry.slice(0, nl + 1);
      const lineBytes = Buffer.byteLength(line, 'utf8');
      // A complete line over the cap is as fatal as an unterminated one:
      // fail before anything from this chunk is emitted.
      if (lineBytes > opts.maxLineBytes) throw oversized(opts.maxLineBytes);
      carry = carry.slice(nl + 1);
      carryBytes -= lineBytes;
      out += emit(line);
    }
    if (carryBytes > opts.maxLineBytes) throw oversized(opts.maxLineBytes);
    await write(out);
  }
  let tail = '';
  if (carry.length > 0) tail += emit(carry);
  if (dump) tail += dump.end();
  await write(tail);
  return {
    lines,
    redactedLines,
    redactedValues: dump ? dump.stats.redactedValues : null,
    copyRows: dump ? dump.stats.copyRows : null,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  try {
    const summary = await scrubStream(process.stdin, process.stdout, opts);
    const accounting =
      summary.redactedValues === null
        ? `redactedLines=${summary.redactedLines}`
        : `copyRows=${summary.copyRows} redactedValues=${summary.redactedValues}`;
    process.stderr.write(`pii-scrub: mode=${opts.mode} lines=${summary.lines} ${accounting}\n`);
    await new Promise((resolve) => process.stdout.write('', resolve));
    process.exitCode = 0;
  } catch (error) {
    const code = typeof error?.exitCode === 'number' ? error.exitCode : 4;
    process.stderr.write(`pii-scrub: FAILED (${error?.message ?? String(error)})\n`);
    process.exitCode = code;
  }
}

const invokedDirectly = process.argv[1] && /pii-scrub\.mjs$/.test(process.argv[1]);
if (invokedDirectly) await main();
