#!/usr/bin/env node
/**
 * pii-scrub.mjs — Layer 5 backup redaction CLI (Sprint 1.2c).
 *
 *   pg_dump ... | node --import tsx scripts/pii-scrub.mjs --mode backup | age -R recipients
 *
 * Reads stdin, redacts line by line, writes stdout. FAIL CLOSED:
 *   - a line longer than --max-line-bytes (default 64 MiB) aborts the run
 *     with exit 3 — never dropped, never partially emitted (a dropped row
 *     would make a backup look valid while silently missing data);
 *   - any redaction error aborts with exit 4;
 *   - usage error exits 2.
 * Only complete newline-terminated lines are redacted and emitted; a
 * trailing partial line is held until its newline or end of input, so a
 * value split across two chunks is never seen in halves.
 *
 * --mode backup  whole library (Layer 5, default)
 * --mode log     Layer 3's JSON-aware log-line pass (incident capture reuse)
 *
 * NER is deliberately not on this path (Layer 3 is ratified regex-only; the
 * local NER decision is unratified).
 */
import process from 'node:process';

import { redactForBackup } from '../src/lib/pii-screener/backup-redaction.ts';
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

export async function scrubStream(input, output, opts) {
  const redact = opts.mode === 'log' ? redactLogLine : redactForBackup;
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

  input.setEncoding('utf8');
  for await (const chunk of input) {
    carry += chunk;
    carryBytes += Buffer.byteLength(chunk, 'utf8');
    let nl;
    let out = '';
    while ((nl = carry.indexOf('\n')) !== -1) {
      const line = carry.slice(0, nl + 1);
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (lineBytes > opts.maxLineBytes) {
        // A complete line over the cap is as fatal as an unterminated one:
        // fail before anything from this chunk is emitted.
        const err = new Error(
          `pii-scrub: line exceeds --max-line-bytes (${opts.maxLineBytes}); aborting so no row is silently dropped`,
        );
        err.exitCode = 3;
        throw err;
      }
      carry = carry.slice(nl + 1);
      carryBytes -= lineBytes;
      out += emit(line);
    }
    if (carryBytes > opts.maxLineBytes) {
      const err = new Error(
        `pii-scrub: line exceeds --max-line-bytes (${opts.maxLineBytes}); aborting so no row is silently dropped`,
      );
      err.exitCode = 3;
      throw err;
    }
    if (out.length > 0 && !output.write(out)) {
      await new Promise((resolve) => output.once('drain', resolve));
    }
  }
  if (carry.length > 0) {
    const out = emit(carry);
    if (!output.write(out)) await new Promise((resolve) => output.once('drain', resolve));
  }
  return { lines, redactedLines };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  try {
    const summary = await scrubStream(process.stdin, process.stdout, opts);
    process.stderr.write(
      `pii-scrub: mode=${opts.mode} lines=${summary.lines} redactedLines=${summary.redactedLines}\n`,
    );
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
