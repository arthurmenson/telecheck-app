// Runtime-state journal for scripts/pilot-1-env-purge.sh — the ONLY writer of
// ${PILOT_1_RUNTIME_STATE_DIR}. Every write is no-follow and atomic so that a
// pre-planted symlink (e.g. `latest` → an incident artifact) can never make
// the purge overwrite evidence (Codex R9):
//   - the state directory must be a real, privately owned directory
//     (not a symlink; owned by the caller; not group/world-writable);
//     it is created with mode 0700 when absent;
//   - no component between the state directory and the destination may be a
//     symbolic link; an existing destination must be a regular file;
//   - content goes to a fresh O_EXCL temp file (0600) in the same directory
//     and is renamed over the destination (rename replaces a symlink entry
//     rather than following it).
//
// CLI:  node scripts/lib/runtime-state.mjs ensure --dir D
//       node scripts/lib/runtime-state.mjs write  --dir D --path REL [--content C]
//   exit 0 = ok, 1 = refused (reason on stderr), 2 = usage
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const POSIX = process.platform !== 'win32';

/** The state directory must be a real, privately owned directory; created 0700 when absent. */
export function ensureStateDir(dir) {
  const abs = path.resolve(dir);
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      fs.mkdirSync(abs, { recursive: true, mode: 0o700 });
      st = fs.lstatSync(abs);
    } else {
      throw new Error(`state directory cannot be inspected (${error && error.code}): ${abs}`);
    }
  }
  if (st.isSymbolicLink()) throw new Error(`state directory is a symbolic link: ${abs}`);
  if (!st.isDirectory()) throw new Error(`state directory is not a directory: ${abs}`);
  if (POSIX) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid !== null && st.uid !== uid) {
      throw new Error(
        `state directory is not owned by the current user (uid ${st.uid} != ${uid}): ${abs}`,
      );
    }
    if ((st.mode & 0o022) !== 0) {
      throw new Error(
        `state directory is group/world-writable (mode ${(st.mode & 0o777).toString(8)}): ${abs}`,
      );
    }
  }
  return abs;
}

function assertRelative(rel) {
  if (typeof rel !== 'string' || rel === '' || path.isAbsolute(rel))
    throw new Error(`journal path must be relative: ${rel}`);
  const parts = rel.split(/[\\/]+/);
  if (parts.some((p) => p === '' || p === '.' || p === '..' || !/^[A-Za-z0-9._-]+$/.test(p))) {
    throw new Error(`journal path has an invalid component: ${rel}`);
  }
  return parts;
}

/** Atomic, no-follow write of `content` to <dir>/<rel>; parents created 0700. */
export function writeJournal(dir, rel, content = '') {
  const base = ensureStateDir(dir);
  const parts = assertRelative(rel);
  let cur = base;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    let st = null;
    try {
      st = fs.lstatSync(cur);
    } catch (error) {
      if (!(error && error.code === 'ENOENT'))
        throw new Error(`journal path cannot be inspected (${error && error.code}): ${cur}`);
    }
    const last = i === parts.length - 1;
    if (st) {
      if (st.isSymbolicLink())
        throw new Error(`journal destination is (or is under) a symbolic link: ${cur}`);
      if (!last && !st.isDirectory()) throw new Error(`journal parent is not a directory: ${cur}`);
      if (last && !st.isFile())
        throw new Error(`journal destination is not a regular file: ${cur}`);
    } else if (!last) {
      fs.mkdirSync(cur, { mode: 0o700 });
    }
  }
  const target = cur;
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  let flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
  if (typeof fs.constants.O_NOFOLLOW === 'number') flags |= fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(tmp, flags, 0o600);
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw error;
  }
  return target;
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const dir = arg(rest, '--dir');
  try {
    if (cmd === 'ensure' && dir) {
      ensureStateDir(dir);
      process.exit(0);
    }
    if (cmd === 'write' && dir && arg(rest, '--path')) {
      writeJournal(dir, arg(rest, '--path'), arg(rest, '--content') ?? '');
      process.exit(0);
    }
    process.stderr.write(
      'usage: runtime-state.mjs ensure --dir D | write --dir D --path REL [--content C]\n',
    );
    process.exit(2);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
