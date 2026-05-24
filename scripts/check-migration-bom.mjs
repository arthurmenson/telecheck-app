// Migration encoding guard — fails if any migration SQL file begins with a
// UTF-8 byte-order mark (BOM, EF BB BF).
//
// WHY THIS EXISTS (defect-class guard, not just an instance fix):
//   The test-harness migration runner (tests/setup.ts) reads each migration's
//   raw bytes and feeds them straight to Postgres. A leading BOM turns the
//   first line `-- ...` into `﻿-- ...`, which Postgres rejects as a syntax
//   error, aborting the entire migration chain apply. This silently broke the
//   suite three times (cockpit Addenda 82 / 86 / 90) — each time it was
//   hotfixed on the affected files, and each time a byte-exact revert or a
//   Windows-host re-save reintroduced it (Addendum 90 documents restoring the
//   BOM byte-exact). Fixing the instance never fixed the class.
//
// This is the BOM analogue of the TLC-035 EOL-normalization guard
// (.gitattributes, Sprint 19): a cheap, deterministic, DB-free CI gate that
// makes the recurring encoding defect impossible to merge unnoticed.
//
// Scope: migrations/*.sql + migrations/rollback/*.sql. Pure filesystem scan —
// no database, no node_modules, no network. Exit 0 = clean, exit 1 = violation.

import { readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(repoRoot, 'migrations');
const rollbackDir = join(migrationsDir, 'rollback');

function sqlFilesIn(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => join(dir, e.name))
    .sort();
}

function startsWithBom(filePath) {
  const fd = openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(3);
    const bytesRead = readSync(fd, head, 0, 3, 0);
    return bytesRead === 3 && head.equals(BOM);
  } finally {
    closeSync(fd);
  }
}

const files = [...sqlFilesIn(migrationsDir), ...sqlFilesIn(rollbackDir)];
const violations = files.filter((f) => startsWithBom(f)).map((f) => f.replace(`${repoRoot}/`, ''));

if (violations.length > 0) {
  console.error(
    `\n✖ Migration encoding guard: ${violations.length} file(s) begin with a UTF-8 BOM (EF BB BF).`,
  );
  console.error(
    '  A leading BOM corrupts the first SQL statement and aborts the migration-chain apply.\n',
  );
  for (const v of violations) console.error(`    - ${v}`);
  console.error(
    '\n  Strip the BOM (e.g. `sed -i \'1s/^\\xEF\\xBB\\xBF//\' <file>`) and re-run `npm run check:migration-bom`.\n',
  );
  process.exit(1);
}

console.log(`✓ Migration encoding guard: ${files.length} SQL file(s) scanned, no UTF-8 BOM found.`);
process.exit(0);
