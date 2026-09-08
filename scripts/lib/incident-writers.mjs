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
// Discipline shared by every writer (Codex R3–R11 on the purge script and R1
// here): presence is established by lstat (symlinks are never followed, a
// symlinked entry is a refusal), manifest rewrites are atomic (O_EXCL temp,
// COMPLETE write, fsync, rename, parent fsync), artifacts are deleted only when
// the VALIDATED manifest inventory names them and they are regular files whose
// REAL location is inside the REAL incident directory (never by name prefix —
// `inc-2-app.log.age` belongs to `inc-2`, not `inc`), a lock that is present
// but does not carry a valid incident id blocks every deletion, GC and
// close-wipe accept only structurally complete lifecycle manifests, and the
// ratified 30-day retention floor cannot be lowered.
//
// CLI: node scripts/lib/incident-writers.mjs <cmd> --dir D ...
//   consume --incident-id ID --disposition RESOLVED|ABANDONED --cleared-by WHO [--reason R] [--purge-attested true|false] [--cleared-at ISO]
//   remove-lock --incident-id ID
//   gc-plan [--min-age-days N>=30] | gc-execute [--min-age-days N>=30]
//   close-wipe-blockers | close-wipe
//   exit 0 = ok, 1 = refused (reason on stderr / JSON on stdout), 2 = usage
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { INCIDENT_ID, LOCK_NAME, listManifests, readLock } from './incident-manifest.mjs';

const POSIX = process.platform !== 'win32';
export const DISPOSITIONS = ['RESOLVED', 'ABANDONED'];
/** Ratified retention floor (runbook §Retention + destruction): never lower. */
export const GC_MIN_AGE_DAYS_FLOOR = 30;
export const DEFAULT_GC_MIN_AGE_DAYS = GC_MIN_AGE_DAYS_FLOOR;

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
  // path.resolve strips trailing separators (lstat('link/') would follow the
  // link — Codex R2); the resolved path must then be its own real path, i.e.
  // no component anywhere in it may be a symbolic link.
  const resolved = path.resolve(dir);
  const st = lstatOrNull(resolved);
  if (!st) throw new Error(`incident directory not found: ${resolved}`);
  if (st.isSymbolicLink()) throw new Error(`incident directory is a symbolic link: ${resolved}`);
  if (!st.isDirectory()) throw new Error(`incident directory is not a directory: ${resolved}`);
  const real = fs.realpathSync(resolved);
  if (real !== resolved) {
    throw new Error(`incident directory path contains a symbolic link (${resolved} -> ${real})`);
  }
  return real;
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

const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/**
 * Structural validation of a lifecycle manifest (shared by GC and close-wipe,
 * Codex R1): identity must match the file name, capturedAt must parse,
 * artifacts must be an array of entries whose `path` is a string, consumed must
 * be a boolean, and a consumed manifest must carry a valid disposition and a
 * parsable clearedAt. Returns null when valid, otherwise the defect.
 */
export function validateLifecycleManifest(value, id) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not an object';
  if (value.incidentId !== id)
    return `incidentId ${JSON.stringify(value.incidentId ?? null)} does not match the file name`;
  if (typeof value.status !== 'string' || value.status === '') return 'status missing';
  if (!isIso(value.capturedAt)) return 'capturedAt missing or unparsable';
  // Runbook step 5: a FAILED capture writes the manifest WITHOUT an artifact
  // list; every other status must inventory its artifacts (Codex R2).
  const artifacts =
    value.artifacts === undefined && value.status === 'FAILED' ? [] : value.artifacts;
  if (!Array.isArray(artifacts)) return 'artifacts is not an array';
  for (const a of artifacts) {
    if (!a || typeof a !== 'object' || typeof a.path !== 'string' || a.path === '')
      return 'artifact entry without a path';
  }
  if (typeof value.consumed !== 'boolean') return 'consumed is not a boolean';
  if (value.consumed === true) {
    if (!DISPOSITIONS.includes(value.disposition)) return 'consumed without a valid disposition';
    if (!isIso(value.clearedAt)) return 'consumed without a parsable clearedAt';
  }
  return null;
}

/** A present lock is trustworthy only when it is a readable JSON object naming a valid incident id. */
function lockIdentity(lock) {
  if (!lock.present) return { present: false };
  if (lock.unreadable || lock.malformed)
    return {
      present: true,
      valid: false,
      why: lock.unreadable ? `cannot be inspected (${lock.code})` : 'is malformed',
    };
  if (typeof lock.incidentId !== 'string' || !INCIDENT_ID.test(lock.incidentId)) {
    return { present: true, valid: false, why: 'has no valid incident id' };
  }
  return { present: true, valid: true, incidentId: lock.incidentId };
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

/** Writes EVERY byte (writeSync may return a short count); throws on a zero-length write. */
export function writeAll(fd, buf) {
  let off = 0;
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off);
    if (!(n > 0)) throw new Error(`short write: ${off} of ${buf.length} bytes written`);
    off += n;
  }
  return off;
}

function atomicWriteJson(base, file, value) {
  const buf = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  let flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
  if (typeof fs.constants.O_NOFOLLOW === 'number') flags |= fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(tmp, flags, 0o600);
  try {
    try {
      writeAll(fd, buf);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.statSync(tmp).size !== buf.length)
      throw new Error('temp file size mismatch after write');
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
  if (fields.clearedAt !== undefined && !isIso(fields.clearedAt))
    throw new Error('clearedAt must be an ISO-8601 timestamp');
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
    // a FAILED capture carries no artifact list (runbook step 5): record an
    // explicit empty inventory so GC / close-wipe can account for it
    artifacts:
      manifest.artifacts === undefined && manifest.status === 'FAILED' ? [] : manifest.artifacts,
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
  const lock = lockIdentity(readLock(base));
  if (!lock.present) return { absent: true };
  if (!lock.valid) throw new Error(`incident lock is ${lock.why}`);
  if (lock.incidentId !== id)
    throw new Error(`incident lock belongs to ${JSON.stringify(lock.incidentId)}, not ${id}`);
  const file = path.join(base, LOCK_NAME);
  regularFileInside(base, file);
  fs.unlinkSync(file);
  fsyncDir(base);
  return { absent: false, removed: true };
}

/**
 * Artifacts owned by <id>, taken from the VALIDATED manifest inventory only:
 * each listed path must resolve to `<base>/<id>-*.age` (a regular file inside
 * the real directory). Files that merely share the id as a name prefix are
 * never claimed (Codex R1: `inc-2-app.log.age` is `inc-2`'s evidence).
 */
function inventoriedArtifacts(base, id, manifest) {
  const out = [];
  for (const a of manifest.artifacts ?? []) {
    const name = path.basename(a.path);
    if (!name.startsWith(`${id}-`) || !name.endsWith('.age')) {
      throw new Error(`artifact ${name} is not <${id}>-*.age`);
    }
    // The listed path must denote `<incident dir>/<name>` (the runbook lists
    // absolute paths under the incident directory); anything else refuses the
    // whole manifest rather than guessing. The real-location check follows.
    if (path.dirname(path.resolve(base, a.path)) !== base) {
      throw new Error(`artifact ${name} is listed outside the incident directory`);
    }
    const p = path.join(base, name);
    const { st } = regularFileInside(base, p);
    if (st) out.push(name);
  }
  return [...new Set(out)].sort();
}

/**
 * incident-log-gc plan: for every manifest, delete only when it is a VALID
 * lifecycle manifest with consumed:true AND no lock references its id (a
 * present lock without a valid identity blocks every deletion) AND both the
 * manifest file's mtime and its capturedAt are >= minAgeDays old (minimum 30).
 * Never the lock; never an unconsumed / malformed / incomplete manifest.
 */
export function gcPlan(dir, { nowMs = Date.now(), minAgeDays = DEFAULT_GC_MIN_AGE_DAYS } = {}) {
  if (!Number.isInteger(minAgeDays) || minAgeDays < GC_MIN_AGE_DAYS_FLOOR) {
    throw new Error(
      `minAgeDays must be an integer >= ${GC_MIN_AGE_DAYS_FLOOR} (ratified retention floor)`,
    );
  }
  const base = realDir(dir);
  const lock = lockIdentity(readLock(base));
  const minAgeMs = minAgeDays * 24 * 60 * 60 * 1000;
  const plan = {
    deletions: [],
    skipped: [],
    lock: lock.present ? (lock.valid ? lock.incidentId : lock.why) : null,
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
    if (!INCIDENT_ID.test(id)) {
      plan.skipped.push({ file, reason: 'file name is not a valid incident id' });
      continue;
    }
    const defect = validateLifecycleManifest(value, id);
    if (defect) {
      plan.skipped.push({ file, reason: `incomplete lifecycle manifest: ${defect}` });
      continue;
    }
    if (value.consumed !== true) {
      plan.skipped.push({ file, reason: 'not consumed' });
      continue;
    }
    if (lock.present && (!lock.valid || lock.incidentId === id)) {
      plan.skipped.push({
        file,
        reason: lock.valid
          ? 'incident lock references this incident'
          : `incident lock present and ${lock.why} — blocks every deletion`,
      });
      continue;
    }
    const mtimeAge = nowMs - st.mtimeMs;
    const capturedAge = nowMs - Date.parse(value.capturedAt);
    if (mtimeAge < minAgeMs || capturedAge < minAgeMs) {
      plan.skipped.push({ file, reason: `younger than ${minAgeDays} days` });
      continue;
    }
    let artifacts;
    try {
      artifacts = inventoriedArtifacts(base, id, value);
    } catch (error) {
      plan.skipped.push({ file, reason: `inventory refused: ${error.message}` });
      continue;
    }
    // residual `<id>-*.age` files that the inventory does not name (e.g. a
    // partial FAILED capture) are reported, never deleted by GC; close-wipe
    // removes them with everything else once every incident is disposed
    const residual = fs
      .readdirSync(base)
      .filter((f) => f.startsWith(`${id}-`) && f.endsWith('.age') && !artifacts.includes(f))
      .sort();
    plan.deletions.push({ id, manifest: file, artifacts, residual });
  }
  return plan;
}

/** incident-log-gc execute: artifacts first, then the manifest; each unlink re-checked by lstat. */
export function gcExecute(dir, plan) {
  const base = realDir(dir);
  const deleted = [];
  for (const d of plan.deletions) {
    for (const a of d.artifacts) {
      if (!a.startsWith(`${d.id}-`) || !a.endsWith('.age') || a.includes('/') || a.includes('\\')) {
        throw new Error(`refusing to delete ${a}: not an artifact of ${d.id}`);
      }
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

/** pilot-1-close-wipe blockers: any lock, any unconsumed / incomplete / unreadable manifest, any non-regular entry. */
export function closeWipeBlockers(dir) {
  const blockers = [];
  let base;
  try {
    base = realDir(dir);
  } catch (error) {
    return [error.message];
  }
  const lock = lockIdentity(readLock(base));
  if (lock.present)
    blockers.push(`incident lock present (${lock.valid ? lock.incidentId : lock.why})`);
  for (const f of fs.readdirSync(base)) {
    if (f === LOCK_NAME) continue;
    const p = path.join(base, f);
    const st = lstatOrNull(p);
    if (!st || !st.isFile() || st.isSymbolicLink()) {
      blockers.push(`unexpected entry (not a regular file): ${f}`);
      continue;
    }
    if (f.endsWith('.manifest.json')) {
      const id = f.slice(0, -'.manifest.json'.length);
      let value;
      try {
        value = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        blockers.push(`unreadable manifest ${f}`);
        continue;
      }
      const defect = INCIDENT_ID.test(id)
        ? validateLifecycleManifest(value, id)
        : 'file name is not a valid incident id';
      if (defect) blockers.push(`incomplete lifecycle manifest ${f}: ${defect}`);
      else if (value.consumed !== true) blockers.push(`unconsumed manifest ${f}`);
    }
  }
  return blockers;
}

/** pilot-1-close-wipe: unlink every regular file (blockers re-checked here, under the caller's lifecycle lock). */
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
        clearedAt: arg(rest, '--cleared-at'),
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
      if (!Number.isInteger(minAgeDays) || minAgeDays < GC_MIN_AGE_DAYS_FLOOR) {
        process.stderr.write(
          `--min-age-days must be an integer >= ${GC_MIN_AGE_DAYS_FLOOR} (ratified retention floor)\n`,
        );
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
