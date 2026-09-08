#!/usr/bin/env bash
#
# pilot-1-close-wipe.sh — full incident-logs wipe on Pilot 1 exit (win or abort).
#
# Per docs/PILOT_1_INCIDENT_RESPONSE_MINI_RUNBOOK.md §Retention + destruction:
# REFUSES if `.incident.lock` exists (readable or not), if ANY manifest has
# consumed:false (or is malformed / unreadable), or if the directory holds
# anything but regular files. Every incident opened but not disposed must be
# closed with incident-clear.sh first. Deletes every regular file in the
# directory (manifests + artifacts), keeps the directory, and prints the
# record for the Pilot 1 close report. Requires --confirm.
#
# Holds the Pilot 1 lifecycle lock so it cannot interleave with a purge,
# a capture, a clearance or the gc.
#
# Exit: 0 wiped · 1 refused (nothing changed) · 2 usage
# Options: --confirm [--json]
# Environment: PILOT_1_INCIDENT_LOGS_DIR, PILOT_1_LOCK_FILE, PILOT_1_ACTOR, PILOT_1_NODE, PILOT_1_FLOCK

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="${PILOT_1_NODE:-node}"
FLOCK="${PILOT_1_FLOCK:-flock}"
ACTOR="${PILOT_1_ACTOR:-}"
INCIDENT_DIR="${PILOT_1_INCIDENT_LOGS_DIR:-/home/deploy/incident-logs}"
LOCK_FILE="${PILOT_1_LOCK_FILE:-/var/tmp/pilot-1-env-purge.lock}"
CONFIRM=0
FORMAT="human"

while [ $# -gt 0 ]; do
    case "$1" in
        --confirm)  CONFIRM=1; shift ;;
        --json)     FORMAT="json"; shift ;;
        --help|-h)  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)          echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
    esac
done
[ "${CONFIRM}" = "1" ] || { echo "ERROR: --confirm is required; this wipes every file under ${INCIDENT_DIR}" >&2; exit 2; }
if [ -z "${ACTOR}" ]; then ACTOR="$(id -un 2>/dev/null || echo operator)@$(hostname 2>/dev/null || echo unknown-host)"; fi
[[ "${ACTOR}" =~ ^[A-Za-z0-9._@+-]{1,120}$ ]] || { echo "ERROR: actor id must match [A-Za-z0-9._@+-]{1,120}" >&2; exit 2; }
[ -r "${HERE}/lib/incident-writers.mjs" ] || { echo "ERROR: required file missing: ${HERE}/lib/incident-writers.mjs" >&2; exit 2; }
command -v "${FLOCK}" >/dev/null 2>&1 || { echo "ERROR: flock (util-linux) is required for the lifecycle lock" >&2; exit 2; }
if [ -L "${LOCK_FILE}" ]; then echo "ERROR: PILOT_1_LOCK_FILE (${LOCK_FILE}) must not be a symbolic link" >&2; exit 2; fi
case "$(cd "$(dirname "${LOCK_FILE}")" 2>/dev/null && pwd -P)/" in
    "$(cd "${INCIDENT_DIR}" 2>/dev/null && pwd -P)/"*) echo "ERROR: PILOT_1_LOCK_FILE must not be inside the incident directory" >&2; exit 2 ;;
esac

exec 9>>"${LOCK_FILE}" || { echo "ERROR: cannot open the lifecycle lock file ${LOCK_FILE}" >&2; exit 2; }
if [ -L "${LOCK_FILE}" ] || [ ! -f "${LOCK_FILE}" ]; then echo "ERROR: lifecycle lock file ${LOCK_FILE} is not a regular file" >&2; exit 2; fi
if ! "${FLOCK}" -n 9; then echo "REFUSED: another Pilot 1 lifecycle holds ${LOCK_FILE}; wait for it (nothing changed)" >&2; exit 1; fi

[ -d "${INCIDENT_DIR}" ] || { echo "REFUSED: incident-logs directory not found or not a directory: ${INCIDENT_DIR}" >&2; exit 1; }
if ! BLOCK="$("${NODE}" "${HERE}/lib/incident-writers.mjs" close-wipe-blockers --dir "${INCIDENT_DIR}" 2>&1)"; then
    echo "REFUSED: pilot-1-close-wipe is blocked (nothing changed): ${BLOCK}" >&2
    echo "         Dispose of every open incident with scripts/incident-clear.sh first." >&2
    exit 1
fi
if ! OUT="$("${NODE}" "${HERE}/lib/incident-writers.mjs" close-wipe --dir "${INCIDENT_DIR}" 2>&1)"; then
    echo "ERROR: wipe failed: ${OUT}" >&2; exit 1
fi
WIPED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ "${FORMAT}" = "json" ]; then
    "${NODE}" -e 'const r = JSON.parse(process.argv[1]); console.log(JSON.stringify({ status: "wiped", directory: process.argv[2], wipedAt: process.argv[3], actor: process.argv[4], removed: r.removed }));' "${OUT}" "${INCIDENT_DIR}" "${WIPED_AT}" "${ACTOR}"
else
    "${NODE}" -e 'const r = JSON.parse(process.argv[1]); console.log(`OK: Pilot 1 close-wipe of ${process.argv[2]} at ${process.argv[3]} by ${process.argv[4]}: ${r.removed.length} file(s) removed — record this in the Pilot 1 close report.`); for (const f of r.removed) console.log(`  removed ${f}`);' "${OUT}" "${INCIDENT_DIR}" "${WIPED_AT}" "${ACTOR}"
fi
exit 0
