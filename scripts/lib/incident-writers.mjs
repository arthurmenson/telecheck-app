// Incident-logs WRITERS — the only code that may change state under the
// incident directory, per PILOT_1_INCIDENT_RESPONSE_MINI_RUNBOOK.md
// §Forensic-evidence preservation (steps 8, retention, close):
//   consume(dir, id, fields)   incident-clear: manifest.consumed = true (+ disposition fields)
//   removeLock(dir, id)        incident-clear: unlink .incident.lock, which must name <id>
//   gcPlan(dir, opts)          incident-log-gc: aged, consumed, unlocked manifests + artifacts
//   gcExecute(dir, plan)       incident-log-gc: delete artifacts, then the manifest
//   closeWipeBlockers(dir)     pilot-1-close-wipe: lock / unconsumed / unreadable / foreign entries
//   closeWipe(dir)             pilot-1-close-wipe: unlink every regular file in the directory
//
// Discipline shared by every writer (Codex R3–R11 on the purge script apply
// here too): presence is established by lstat (symlinks are never followed,
// a symlinked entry is a refusal), manifest rewrites are atomic (O_EXCL temp
// + rename + parent fsync), artifacts are deleted only when they are regular
// files whose REAL location is inside the REAL incident directory, and the
// lock is never touched by gc or by anything but incident-clear.
//
// CLI: node scripts/lib/incident-writers.mjs <cmd> --dir D ...
//   consume --incident-id ID --disposition RESOLVED|ABANDONED --cleared-by WHO [--reason R] [--purge-attested true|false]
//   remove-lock --incident-id ID
//   gc-plan [--min-age-days N] | gc-execute [--min-age-days N]
//   close-wipe-blockers | close-wipe
//   exit 0 = ok, 1 = refused (reason on stderr / JSON on stdout), 2 = usage
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { INCIDENT_ID, LOCK_NAME, listManifests, readLock } from './incident-manifest.mjs';

const POSIX = process.platform !== 'win32';
export const DISPOSITIONS = ['RESOLVED', 'ABANDONED'];
export const DEFAULT_GC_MIN_AGE_DAYS = 30;

function fsyncDir(dir) {
  if (!POSIX) return;
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function assertId(id) {
  if (typeof id !== 'string' || !INCIDENT_ID.test(id)) {
    throw new Error('incident id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$');
  }
  return id;
}

/** lstat that distinguishes absent from uninspectable; never follows symlinks. */
function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new Error(`cannot inspect ${p} (${error && error.code ? error.code : 'unknown'})`);
  }
}

function realDir(dir) {
  const st = lstatOrNull(dir);
  if (!st) throw new Error(`incident directory not found: ${dir}`);
  if (st.isSymbolicLink()) throw new Error(`incident directory is a symbolic link: ${dir}`);
  if (!st.isDirectory()) throw new Error(`incident directory is not a directory: ${dir}`);
  return fs.realpathSync(dir);
}

function regularFileInside(realBase, p) {
  const st = lstatOrNull(p);
  if (!st) return { st: null };
  if (st.isSymbolicLink()) throw new Error(`entry is a symbolic link: ${path.basename(p)}`);
  if (!st.isFile()) throw new Error(`entry is not a regular file: ${path.basename(p)}`);
  const real = fs.realpathSync(p);
  if (!real.startsWith(realBase + path.sep)) {
    throw new Error(`entry resolves outside the incident directory: ${path.basename(p)}`);
  }
  return { st, real };
}

export function readManifest(dir, id) {
  assertId(id);
  const base = realDir(dir);
  const file = path.join(base, `${id}.manifest.json`);
  const { st } = regularFileInside(base, file);
  if (!st) return { missing: true, file };
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { malformed: true, file };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { malformed: true, file };
  return { value, file };
}

function atomicWriteJson(base, file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  let flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
  if (typeof fs.constants.O_NOFOLLOW === 'number') flags |= fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(tmp, flags, 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw error;
  }
  fsyncDir(base);
}

/**
 * incident-clear: mark the manifest consumed with the disposition. Refuses a
 * missing / malformed / symlinked manifest, an id mismatch, and a manifest
 * already consumed under a DIFFERENT disposition. A manifest already consumed
 * under the SAME disposition is reported (interrupted clearance) and left as is.
 */
export function consume(dir, id, fields) {
  assertId(id);
  if (!DISPOSITIONS.includes(fields.disposition))
    throw new Error('disposition must be RESOLVED or ABANDONED');
  if (typeof fields.clearedBy !== 'string' || fields.clearedBy === '')
    throw new Error('clearedBy is required');
  const r = readManifest(dir, id);
  if (r.missing) throw new Error(`manifest missing: ${id}.manifest.json`);
  if (r.malformed) throw new Error(`manifest malformed: ${id}.manifest.json`);
  const manifest = r.value;
  if (manifest.incidentId !== id) {
    throw new Error(
      `manifest incidentId ${JSON.stringify(manifest.incidentId ?? null)} does not match ${id}`,
    );
  }
  if (manifest.consumed === true) {
    if (manifest.disposition !== fields.disposition) {
      throw new Error(
        `manifest already consumed with disposition ${JSON.stringify(manifest.disposition ?? null)}`,
      );
    }
    return { alreadyConsumed: true, manifest };
  }
  if (manifest.consumed !== false) throw new Error('manifest consumed is not exactly false');
  const next = {
    ...manifest,
    consumed: true,
    disposition: fields.disposition,
    clearedAt: fields.clearedAt ?? new Date().toISOString(),
    clearedBy: fields.clearedBy,
  };
  if (fields.disposition === 'ABANDONED') next.abandonReason = fields.reason ?? null;
  if (typeof fields.purgeAttested === 'boolean') next.purgeAttested = fields.purgeAttested;
  atomicWriteJson(realDir(dir), r.file, next);
  return { alreadyConsumed: false, manifest: next };
}

/** incident-clear: remove the lock, which must be a regular file naming <id>. */
export function removeLock(dir, id) {
  assertId(id);
  const base = realDir(dir);
  const lock = readLock(base);
  if (!lock.present) return { absent: true };
  if (lock.unreadable) throw new Error(`incident lock cannot be inspected (${lock.code})`);
  if (lock.malformed) throw new Error('incident lock is malformed');
  if (lock.incidentId !== id)
    throw new Error(`incident lock belongs to ${JSON.stringify(lock.incidentId)}, not ${id}`);
  const file = path.join(base, LOCK_NAME);
  regularFileInside(base, file);
  fs.unlinkSync(file);
  fsyncDir(base);
  return { absent: false, removed: true };
}

/** Artifacts of <id>: `<id>-*.age` regular files inside the directory (unlisted ones included). */
function artifactsOf(base, id) {
  const out = [];
  for (const f of fs.readdirSync(base)) {
    if (!f.startsWith(`${id}-`) || !f.endsWith('.age')) continue;
    const p = path.join(base, f);
    const st = lstatOrNull(p);
    if (!st || !st.isFile() || st.isSymbolicLink()) continue; // never touch anything but regular files
    out.push(f);
  }
  return out.sort();
}

/**
 * incident-log-gc plan: for every manifest, delete only when consumed:true AND
 * no lock references its id AND both the manifest file's mtime and its
 * capturedAt (when present) are >= minAgeDays old. Never the lock; never an
 * unconsumed / unreadable manifest (those are reported as skipped).
 */
export function gcPlan(dir, { nowMs = Date.now(), minAgeDays = DEFAULT_GC_MIN_AGE_DAYS } = {}) {
  const base = realDir(dir);
  const lock = readLock(base);
  const minAgeMs = minAgeDays * 24 * 60 * 60 * 1000;
  const plan = {
    deletions: [],
    skipped: [],
    lock: lock.present ? (lock.unreadable ? 'unreadable' : (lock.incidentId ?? 'malformed')) : null,
  };
  for (const file of listManifests(base)) {
    const id = file.slice(0, -'.manifest.json'.length);
    const p = path.join(base, file);
    let st;
    try {
      ({ st } = regularFileInside(base, p));
    } catch (error) {
      plan.skipped.push({ file, reason: error.message });
      continue;
    }
    let value;
    try {
      value = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      plan.skipped.push({ file, reason: 'malformed manifest' });
      continue;
    }
    if (!value || typeof value !== 'object' || value.consumed !== true) {
      plan.skipped.push({ file, reason: 'not consumed' });
      continue;
    }
    if (lock.present && (lock.unreadable || lock.malformed || lock.incidentId === id)) {
      plan.skipped.push({
        file,
        reason:
          lock.unreadable || lock.malformed
            ? 'incident lock uninspectable'
            : 'incident lock references this incident',
      });
      continue;
    }
    const mtimeAge = nowMs - st.mtimeMs;
    const captured = typeof value.capturedAt === 'string' ? Date.parse(value.capturedAt) : NaN;
    const capturedAge = Number.isNaN(captured) ? mtimeAge : nowMs - captured;
    if (mtimeAge < minAgeMs || capturedAge < minAgeMs) {
      plan.skipped.push({ file, reason: `younger than ${minAgeDays} days` });
      continue;
    }
    plan.deletions.push({ id, manifest: file, artifacts: artifactsOf(base, id) });
  }
  return plan;
}

/** incident-log-gc execute: artifacts first, then the manifest; each unlink re-checked by lstat. */
export function gcExecute(dir, plan) {
  const base = realDir(dir);
  const deleted = [];
  for (const d of plan.deletions) {
    for (const a of d.artifacts) {
      const p = path.join(base, a);
      const { st } = regularFileInside(base, p);
      if (!st) continue;
      fs.unlinkSync(p);
      deleted.push(a);
    }
    const m = path.join(base, d.manifest);
    const { st } = regularFileInside(base, m);
    if (st) {
      fs.unlinkSync(m);
      deleted.push(d.manifest);
    }
  }
  if (deleted.length) fsyncDir(base);
  return deleted;
}

/** pilot-1-close-wipe blockers: any lock, any unconsumed / unreadable manifest, any non-regular entry. */
export function closeWipeBlockers(dir) {
  const blockers = [];
  let base;
  try {
    base = realDir(dir);
  } catch (error) {
    return [error.message];
  }
  const lock = readLock(base);
  if (lock.present) {
    blockers.push(
      lock.unreadable
        ? `incident lock cannot be inspected (${lock.code})`
        : `incident lock present (${lock.malformed ? 'malformed' : lock.incidentId})`,
    );
  }
  for (const f of fs.readdirSync(base)) {
    if (f === LOCK_NAME) continue;
    const p = path.join(base, f);
    const st = lstatOrNull(p);
    if (!st || !st.isFile() || st.isSymbolicLink()) {
      blockers.push(`unexpected entry (not a regular file): ${f}`);
      continue;
    }
    if (f.endsWith('.manifest.json')) {
      let value;
      try {
        value = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        blockers.push(`unreadable manifest ${f}`);
        continue;
      }
      if (!value || typeof value !== 'object' || value.consumed !== true)
        blockers.push(`unconsumed manifest ${f}`);
    }
  }
  return blockers;
}

/** pilot-1-close-wipe: unlink every regular file (blockers must have been checked by the caller under the lifecycle lock). */
export function closeWipe(dir) {
  const base = realDir(dir);
  const blockers = closeWipeBlockers(base);
  if (blockers.length) throw new Error(`close-wipe blocked: ${blockers.join('; ')}`);
  const removed = [];
  for (const f of fs.readdirSync(base).sort()) {
    const p = path.join(base, f);
    const { st } = regularFileInside(base, p);
    if (!st) continue;
    fs.unlinkSync(p);
    removed.push(f);
  }
  if (removed.length) fsyncDir(base);
  return removed;
}

function arg(rest, name) {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}

function cli(argv) {
  const [cmd, ...rest] = argv;
  const dir = arg(rest, '--dir');
  if (!dir) {
    process.stderr.write(
      'usage: incident-writers.mjs <consume|remove-lock|gc-plan|gc-execute|close-wipe-blockers|close-wipe> --dir D ...\n',
    );
    return 2;
  }
  try {
    if (cmd === 'consume') {
      const id = arg(rest, '--incident-id');
      const disposition = arg(rest, '--disposition');
      const clearedBy = arg(rest, '--cleared-by');
      if (!id || !disposition || !clearedBy) {
        process.stderr.write('consume requires --incident-id, --disposition and --cleared-by\n');
        return 2;
      }
      const attested = arg(rest, '--purge-attested');
      const result = consume(dir, id, {
        disposition,
        clearedBy,
        reason: arg(rest, '--reason'),
        purgeAttested: attested === undefined ? undefined : attested === 'true',
      });
      process.stdout.write(
        JSON.stringify({ ok: true, alreadyConsumed: result.alreadyConsumed }) + '\n',
      );
      return 0;
    }
    if (cmd === 'remove-lock') {
      const id = arg(rest, '--incident-id');
      if (!id) {
        process.stderr.write('remove-lock requires --incident-id\n');
        return 2;
      }
      process.stdout.write(JSON.stringify({ ok: true, ...removeLock(dir, id) }) + '\n');
      return 0;
    }
    if (cmd === 'gc-plan' || cmd === 'gc-execute') {
      const days = arg(rest, '--min-age-days');
      const minAgeDays = days === undefined ? DEFAULT_GC_MIN_AGE_DAYS : Number(days);
      if (!Number.isInteger(minAgeDays) || minAgeDays < 1) {
        process.stderr.write('--min-age-days must be a positive integer\n');
        return 2;
      }
      const plan = gcPlan(dir, { minAgeDays });
      const deleted = cmd === 'gc-execute' ? gcExecute(dir, plan) : [];
      process.stdout.write(
        JSON.stringify({ ok: true, dryRun: cmd === 'gc-plan', minAgeDays, ...plan, deleted }) +
          '\n',
      );
      return 0;
    }
    if (cmd === 'close-wipe-blockers') {
      const blockers = closeWipeBlockers(dir);
      process.stdout.write(JSON.stringify({ ok: blockers.length === 0, blockers }) + '\n');
      return blockers.length === 0 ? 0 : 1;
    }
    if (cmd === 'close-wipe') {
      const removed = closeWipe(dir);
      process.stdout.write(JSON.stringify({ ok: true, removed }) + '\n');
      return 0;
    }
    process.stderr.write(`unknown command ${cmd}\n`);
    return 2;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(cli(process.argv.slice(2)));
}
