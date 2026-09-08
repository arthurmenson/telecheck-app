// incident-manifest.mjs — READ-ONLY verification of /home/deploy/incident-logs
// state for scripts/pilot-1-env-purge.sh (and, later, incident-clear /
// incident-log-gc / pilot-1-close-wipe).
//
// Per docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md §Environment purge/reset
// procedure and docs/PILOT_1_INCIDENT_RESPONSE_MINI_RUNBOOK.md §Capture
// procedure:
//   lock:     <dir>/.incident.lock            {"incidentId","openedAt","openedBy"}
//   manifest: <dir>/<incidentId>.manifest.json {"incidentId","status","capturedAt",
//             "artifacts":[{"path","plaintextBytes","ciphertextBytes"}],"consumed"}
//   artifact: <dir>/<incidentId>-*.age (age header, size >= plaintextBytes)
//
// This module NEVER writes under the incident directory. Every check returns
// a structured refusal; malformed or incomplete manifests count as FAILED.
//
// CLI:  node scripts/lib/incident-manifest.mjs verify-purge --dir D --incident-id ID
//       node scripts/lib/incident-manifest.mjs routine-blockers --dir D
//   exit 0 = ok, 1 = refused (reason in JSON on stdout), 2 = usage
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCK_NAME = '.incident.lock';
export const MANIFEST_FRESHNESS_MS = 30 * 60 * 1000;
export const AGE_HEADER = 'age-encryption.org/v1';
export const INCIDENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    // Only a confirmed absence is "missing"; EACCES / EISDIR / I/O errors
    // are inspection failures and must never read as a clean state (Codex R1).
    if (error && error.code === 'ENOENT') return { error: 'missing' };
    return { error: 'unreadable', code: error && error.code ? error.code : 'unknown' };
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'malformed' };
    return { value };
  } catch {
    return { error: 'malformed' };
  }
}

export function readLock(dir) {
  const file = path.join(dir, LOCK_NAME);
  const { value, error, code } = readJson(file);
  if (error === 'missing') return { present: false };
  if (error === 'unreadable') return { present: true, unreadable: true, code };
  if (error) return { present: true, malformed: true };
  return {
    present: true,
    incidentId: typeof value.incidentId === 'string' ? value.incidentId : null,
  };
}

export function listManifests(dir) {
  // Throws on any enumeration failure: an unreadable directory is not an
  // empty one (Codex R1).
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    const code = error && error.code ? error.code : 'unknown';
    throw new Error(`cannot inspect the incident directory (${code}): ${dir}`);
  }
  return entries.filter((f) => f.endsWith('.manifest.json')).sort();
}

/** Structural (public-key-only) verification of one artifact — never decrypts. */
export function verifyArtifact(dir, incidentId, artifact) {
  if (!artifact || typeof artifact !== 'object') return 'artifact entry is not an object';
  if (typeof artifact.path !== 'string' || artifact.path === '') return 'artifact path missing';
  const resolved = path.resolve(dir, artifact.path);
  const rel = path.relative(path.resolve(dir), resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel))
    return `artifact path escapes the incident directory: ${artifact.path}`;
  const base = path.basename(resolved);
  if (!base.startsWith(`${incidentId}-`) || !base.endsWith('.age')) {
    return `artifact is not <incident-id>-*.age: ${base}`;
  }
  // Containment is checked on REAL locations: a symlink artifact (or a
  // symlinked intermediate directory) must not let ciphertext outside the
  // protected retention tree authorize a purge (Codex R6).
  let lstat;
  try {
    lstat = fs.lstatSync(resolved);
  } catch {
    return `artifact missing: ${base}`;
  }
  if (lstat.isSymbolicLink()) return `artifact is a symbolic link: ${base}`;
  let realDir;
  let realArtifact;
  try {
    realDir = fs.realpathSync(dir);
    realArtifact = fs.realpathSync(resolved);
  } catch {
    return `artifact location cannot be resolved: ${base}`;
  }
  if (!realArtifact.startsWith(realDir + path.sep)) {
    return `artifact resolves outside the incident directory: ${base}`;
  }
  const stat = lstat;
  if (!stat.isFile() || stat.size === 0) return `artifact empty: ${base}`;
  if (!Number.isInteger(artifact.plaintextBytes) || artifact.plaintextBytes < 0) {
    return `artifact plaintextBytes invalid: ${base}`;
  }
  if (stat.size < artifact.plaintextBytes) return `artifact smaller than its plaintext: ${base}`;
  // The runbook records ciphertextBytes on every artifact entry; an entry
  // without it is an incomplete manifest and counts as FAILED (Codex R5).
  if (!Number.isInteger(artifact.ciphertextBytes) || artifact.ciphertextBytes <= 0) {
    return `artifact ciphertextBytes missing or invalid: ${base}`;
  }
  if (artifact.ciphertextBytes !== stat.size) {
    return `artifact size ${stat.size} != recorded ciphertextBytes ${artifact.ciphertextBytes}: ${base}`;
  }
  const fd = fs.openSync(resolved, 'r');
  try {
    const buf = Buffer.alloc(AGE_HEADER.length);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n !== buf.length || buf.toString('latin1') !== AGE_HEADER)
      return `artifact lacks the age header: ${base}`;
  } finally {
    fs.closeSync(fd);
  }
  return null;
}

/**
 * Incident-mode preconditions, in the spec's order. Returns
 * { ok: true, artifacts, capturedAt } or { ok: false, reason }.
 */
export function verifyForPurge(dir, incidentId, nowMs = Date.now()) {
  if (typeof incidentId !== 'string' || !INCIDENT_ID.test(incidentId)) {
    return { ok: false, reason: 'incident id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' };
  }
  let listing;
  try {
    listing = listManifests(dir);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!listing.includes(`${incidentId}.manifest.json`)) {
    return { ok: false, reason: `manifest missing: ${incidentId}.manifest.json` };
  }
  const { value: manifest, error, code } = readJson(path.join(dir, `${incidentId}.manifest.json`));
  if (error === 'missing')
    return { ok: false, reason: `manifest missing: ${incidentId}.manifest.json` };
  if (error === 'unreadable') return { ok: false, reason: `manifest unreadable (${code})` };
  if (error) return { ok: false, reason: 'manifest malformed (counts as FAILED)' };
  if (manifest.status !== 'SUCCESS')
    return {
      ok: false,
      reason: `manifest status is ${JSON.stringify(manifest.status ?? null)}, not SUCCESS`,
    };
  if (manifest.incidentId !== incidentId) {
    return {
      ok: false,
      reason: `manifest incidentId ${JSON.stringify(manifest.incidentId ?? null)} does not match ${incidentId}`,
    };
  }
  const captured = typeof manifest.capturedAt === 'string' ? Date.parse(manifest.capturedAt) : NaN;
  if (Number.isNaN(captured))
    return { ok: false, reason: 'manifest capturedAt missing or unparsable' };
  if (captured > nowMs + 60_000)
    return { ok: false, reason: 'manifest capturedAt is in the future' };
  if (nowMs - captured > MANIFEST_FRESHNESS_MS) {
    return {
      ok: false,
      reason: `manifest is stale (captured ${Math.round((nowMs - captured) / 60_000)} min ago; limit 30)`,
    };
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    return { ok: false, reason: 'manifest lists no artifacts' };
  }
  for (const artifact of manifest.artifacts) {
    const problem = verifyArtifact(dir, incidentId, artifact);
    if (problem) return { ok: false, reason: problem };
  }
  if (manifest.consumed !== false)
    return { ok: false, reason: 'manifest is already consumed (or consumed is not exactly false)' };
  const lock = readLock(dir);
  if (!lock.present)
    return {
      ok: false,
      reason: 'incident lock is absent — capture did not run, or the incident was already cleared',
    };
  if (lock.unreadable) return { ok: false, reason: `incident lock unreadable (${lock.code})` };
  if (lock.malformed) return { ok: false, reason: 'incident lock is malformed' };
  if (lock.incidentId !== incidentId) {
    return {
      ok: false,
      reason: `incident lock belongs to ${JSON.stringify(lock.incidentId)}, not ${incidentId}`,
    };
  }
  return { ok: true, artifacts: manifest.artifacts.length, capturedAt: manifest.capturedAt };
}

/** Lock state for recovery consistency checks: { present, incidentId } | { present: true, unreadable, code } | { present: true, malformed }. */
export function lockState(dir) {
  const lock = readLock(dir);
  if (!lock.present) return { present: false };
  if (lock.unreadable) return { present: true, unreadable: true, code: lock.code };
  if (lock.malformed) return { present: true, malformed: true };
  return { present: true, incidentId: lock.incidentId };
}

/** Routine-reset blockers: an incident lock, or ANY manifest not consumed: true (malformed counts). */
export function routineResetBlockers(dir) {
  const blockers = [];
  const lock = readLock(dir);
  if (lock.present) {
    if (lock.unreadable) blockers.push(`incident lock cannot be inspected (${lock.code})`);
    else blockers.push(`incident lock present (${lock.malformed ? 'malformed' : lock.incidentId})`);
  }
  let files;
  try {
    files = listManifests(dir);
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
    return blockers;
  }
  for (const file of files) {
    const { value, error, code } = readJson(path.join(dir, file));
    if (error) blockers.push(`unreadable manifest ${file}${code ? ` (${code})` : ''}`);
    else if (value.consumed !== true) blockers.push(`unconsumed manifest ${file}`);
  }
  return blockers;
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
      'usage: incident-manifest.mjs verify-purge --dir D --incident-id ID | routine-blockers --dir D | lock-state --dir D\n',
    );
    return 2;
  }
  if (cmd === 'verify-purge') {
    const id = arg(rest, '--incident-id');
    if (!id) {
      process.stderr.write('verify-purge requires --incident-id\n');
      return 2;
    }
    const result = verifyForPurge(dir, id);
    process.stdout.write(JSON.stringify(result) + '\n');
    return result.ok ? 0 : 1;
  }
  if (cmd === 'lock-state') {
    const state = lockState(dir);
    process.stdout.write(JSON.stringify(state) + '\n');
    return state.unreadable ? 1 : 0;
  }
  if (cmd === 'routine-blockers') {
    const blockers = routineResetBlockers(dir);
    process.stdout.write(JSON.stringify({ ok: blockers.length === 0, blockers }) + '\n');
    return blockers.length === 0 ? 0 : 1;
  }
  process.stderr.write(`unknown command ${cmd}\n`);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(cli(process.argv.slice(2)));
}
