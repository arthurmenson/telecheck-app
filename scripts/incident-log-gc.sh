#!/usr/bin/env bash
#
# incident-log-gc.sh — retention garbage collection for incident-logs.
#
# Per docs/PILOT_1_INCIDENT_RESPONSE_MINI_RUNBOOK.md §Retention + destruction:
# for each `<id>.manifest.json`, delete the manifest AND its `<id>-*.age`
# artifacts ONLY if manifest.consumed = true AND no incident lock references
# that id (an uninspectable or malformed lock blocks every deletion) AND the
# manifest is at least --min-age-days (default and MINIMUM 30) old by BOTH its file mtime
# and its capturedAt. Never touches `.incident.lock`. Never deletes an
# unconsumed, malformed or unreadable manifest. Runs weekly from cron.
#
# Holds the Pilot 1 lifecycle lock so it cannot interleave with a purge,
# a capture or a clearance.
#
# Exit: 0 done (or dry run) · 1 refused (directory uninspectable / lifecycle busy) · 2 usage
# Options: [--dry-run] [--min-age-days N] [--json]
# Environment: PILOT_1_INCIDENT_LOGS_DIR, PILOT_1_LOCK_FILE, PILOT_1_NODE, PILOT_1_FLOCK

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="${PILOT_1_NODE:-node}"
FLOCK="${PILOT_1_FLOCK:-flock}"
INCIDENT_DIR="${PILOT_1_INCIDENT_LOGS_DIR:-/home/deploy/incident-logs}"
LOCK_FILE="${PILOT_1_LOCK_FILE:-/var/tmp/pilot-1-env-purge.lock}"
DRY_RUN=0
MIN_AGE_DAYS=30
FORMAT="human"

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)       DRY_RUN=1; shift ;;
        --min-age-days)  [ $# -ge 2 ] || { echo "ERROR: --min-age-days requires a value" >&2; exit 2; }; MIN_AGE_DAYS="$2"; shift 2 ;;
        --json)          FORMAT="json"; shift ;;
        --help|-h)       sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)               echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
    esac
done
[[ "${MIN_AGE_DAYS}" =~ ^[1-9][0-9]{0,3}$ ]] && [ "${MIN_AGE_DAYS}" -ge 30 ] || { echo "ERROR: --min-age-days must be an integer >= 30 (the ratified retention floor cannot be lowered)" >&2; exit 2; }
[ -r "${HERE}/lib/incident-writers.mjs" ] || { echo "ERROR: required file missing: ${HERE}/lib/incident-writers.mjs" >&2; exit 2; }
command -v "${FLOCK}" >/dev/null 2>&1 || { echo "ERROR: flock (util-linux) is required for the lifecycle lock" >&2; exit 2; }
if [ -L "${LOCK_FILE}" ]; then echo "ERROR: PILOT_1_LOCK_FILE (${LOCK_FILE}) must not be a symbolic link" >&2; exit 2; fi
# Containment is checked against the REAL incident directory; when it does
# not exist (yet) there is nothing to be inside of — the later "not found"
# refusal handles that case instead of a false containment match.
# Configured paths may not contain `..` segments: shells and normalizers
# collapse them lexically while the kernel resolves them physically through a
# preceding symlink (Codex R3). Refused up front, before any resolution.
no_dotdot() { case "/$2/" in */../*|*\\..\\*|*\\../*|*/..\\*) echo "ERROR: $1 must not contain '..' segments: $2" >&2; exit 2 ;; esac; }
no_dotdot PILOT_1_INCIDENT_LOGS_DIR "${INCIDENT_DIR}"
no_dotdot PILOT_1_LOCK_FILE "${LOCK_FILE}"
# Physical resolution (`cd -P`): symlinks are resolved BEFORE `..` is processed.
INC_REAL="$(cd -P -- "${INCIDENT_DIR}" 2>/dev/null && pwd -P || true)"
LOCK_DIR_REAL="$(cd -P -- "$(dirname -- "${LOCK_FILE}")" 2>/dev/null && pwd -P || true)"
if [ -n "${INC_REAL}" ] && [ -n "${LOCK_DIR_REAL}" ]; then
    case "${LOCK_DIR_REAL}/" in
        "${INC_REAL}/"*) echo "ERROR: PILOT_1_LOCK_FILE must not be inside the incident directory" >&2; exit 2 ;;
    esac
fi

exec 9>>"${LOCK_FILE}" || { echo "ERROR: cannot open the lifecycle lock file ${LOCK_FILE}" >&2; exit 2; }
if [ -L "${LOCK_FILE}" ] || [ ! -f "${LOCK_FILE}" ]; then echo "ERROR: lifecycle lock file ${LOCK_FILE} is not a regular file" >&2; exit 2; fi
if ! "${FLOCK}" -n 9; then echo "REFUSED: another Pilot 1 lifecycle holds ${LOCK_FILE}; try again later (nothing changed)" >&2; exit 1; fi

[ -d "${INCIDENT_DIR}" ] || { echo "REFUSED: incident-logs directory not found or not a directory: ${INCIDENT_DIR}" >&2; exit 1; }
CMD=gc-execute; [ "${DRY_RUN}" = "1" ] && CMD=gc-plan
if ! OUT="$("${NODE}" "${HERE}/lib/incident-writers.mjs" "${CMD}" --dir "${INCIDENT_DIR}" --min-age-days "${MIN_AGE_DAYS}" 2>&1)"; then
    echo "REFUSED: incident-log-gc could not run: ${OUT}" >&2; exit 1
fi
if [ "${FORMAT}" = "json" ]; then
    printf '%s\n' "${OUT}"
else
    "${NODE}" -e '
const r = JSON.parse(process.argv[1]);
console.log(`${r.dryRun ? "DRY RUN: " : ""}incident-log-gc (min age ${r.minAgeDays} days): ${r.deletions.length} manifest(s) eligible, ${r.deleted.length} file(s) deleted, ${r.skipped.length} skipped${r.lock ? `; incident lock present (${r.lock})` : ""}`);
for (const d of r.deletions) console.log(`  ${r.dryRun ? "would delete" : "deleted"} ${d.manifest} + ${d.artifacts.length} artifact(s)`);
for (const s of r.skipped) console.log(`  skipped ${s.file}: ${s.reason}`);
' "${OUT}"
fi
exit 0
