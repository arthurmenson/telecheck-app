#!/usr/bin/env bash
#
# incident-clear.sh — explicit, audited incident disposition; the ONLY route
# that removes /home/deploy/incident-logs/.incident.lock.
#
# Per docs/PILOT_1_INCIDENT_RESPONSE_MINI_RUNBOOK.md §Forensic-evidence
# preservation step 8 and docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md
# §Environment purge/reset procedure (incident-lock file).
#
#   --incident-id <id> --disposition RESOLVED
#       requires (a) a committed env.purge.executed attestation for <id> in
#       audit_records and (b) the manifest for <id> with consumed:false;
#       then atomically writes manifest.consumed = true (+ disposition,
#       clearedAt, clearedBy, purgeAttested) and removes the lock.
#   --incident-id <id> --disposition ABANDONED --force-abandoned <reason>
#       emits ONE env.incident.abandoned audit row PER TENANT (Category B,
#       platform_admin actor, actor_tenant_id = the operator's home tenant,
#       payload {incidentId, reason, purgeAttested, clearedAt, actor}) in one
#       transaction under the purge advisory lock — BEFORE any file changes
#       (I-003) — then consumes the manifest and removes the lock. Does not
#       require env-purge to have run (purgeAttested is recorded either way).
#
# Preconditions (fail-closed): the incident directory is inspectable; the
# lock is present, readable and names <id>; the manifest for <id> exists and
# parses. An interrupted clearance (manifest already consumed under the SAME
# disposition, lock still present) is completed by removing the lock; a
# manifest consumed under a different disposition is refused.
#
# Holds the Pilot 1 lifecycle lock (same PILOT_1_LOCK_FILE as env-purge) so
# a clearance can never interleave with a purge or another clearance.
#
# Exit: 0 cleared · 1 refused (nothing changed) · 2 usage · 3 DB error
#
# Environment: PILOT_1_DATABASE_URL (or DATABASE_URL), PILOT_1_INCIDENT_LOGS_DIR,
#   PILOT_1_LOCK_FILE, PILOT_1_ACTOR, PILOT_1_ACTOR_TENANT (ABANDONED),
#   PILOT_1_PSQL / PILOT_1_NODE / PILOT_1_FLOCK
# Options: --incident-id <id> --disposition RESOLVED|ABANDONED [--force-abandoned <reason>] [--json]

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSN="${PILOT_1_DATABASE_URL:-${DATABASE_URL:-}}"
PSQL="${PILOT_1_PSQL:-psql}"
NODE="${PILOT_1_NODE:-node}"
FLOCK="${PILOT_1_FLOCK:-flock}"
ACTOR="${PILOT_1_ACTOR:-}"
ACTOR_TENANT="${PILOT_1_ACTOR_TENANT:-}"
INCIDENT_DIR="${PILOT_1_INCIDENT_LOGS_DIR:-/home/deploy/incident-logs}"
LOCK_FILE="${PILOT_1_LOCK_FILE:-/var/tmp/pilot-1-env-purge.lock}"
INCIDENT_ID=""
DISPOSITION=""
REASON=""
FORMAT="human"

while [ $# -gt 0 ]; do
    case "$1" in
        --incident-id)     [ $# -ge 2 ] || { echo "ERROR: --incident-id requires a value" >&2; exit 2; }; INCIDENT_ID="$2"; shift 2 ;;
        --disposition)     [ $# -ge 2 ] || { echo "ERROR: --disposition requires a value" >&2; exit 2; }; DISPOSITION="$2"; shift 2 ;;
        --force-abandoned) [ $# -ge 2 ] || { echo "ERROR: --force-abandoned requires a reason" >&2; exit 2; }; REASON="$2"; shift 2 ;;
        --json)            FORMAT="json"; shift ;;
        --help|-h)         sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)                 echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
    esac
done

[[ "${INCIDENT_ID}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { echo "ERROR: --incident-id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" >&2; exit 2; }
case "${DISPOSITION}" in
    RESOLVED)  [ -z "${REASON}" ] || { echo "ERROR: --force-abandoned is only valid with --disposition ABANDONED" >&2; exit 2; } ;;
    ABANDONED) [ -n "${REASON}" ] || { echo "ERROR: --disposition ABANDONED requires --force-abandoned <reason>" >&2; exit 2; }
               [ "${#REASON}" -le 500 ] || { echo "ERROR: the reason must be at most 500 characters" >&2; exit 2; }
               case "${REASON}" in *$'\n'*|*$'\r'*) echo "ERROR: the reason must be a single line" >&2; exit 2 ;; esac ;;
    *)         echo "ERROR: --disposition must be RESOLVED or ABANDONED" >&2; exit 2 ;;
esac
[ -n "${DSN}" ] || { echo "ERROR: PILOT_1_DATABASE_URL (or DATABASE_URL) is not set" >&2; exit 2; }
case "${DSN}" in -*) echo "ERROR: the DSN must not begin with '-'" >&2; exit 2 ;; esac
if [ -z "${ACTOR}" ]; then ACTOR="$(id -un 2>/dev/null || echo operator)@$(hostname 2>/dev/null || echo unknown-host)"; fi
[[ "${ACTOR}" =~ ^[A-Za-z0-9._@+-]{1,120}$ ]] || { echo "ERROR: actor id must match [A-Za-z0-9._@+-]{1,120}" >&2; exit 2; }
if [ "${DISPOSITION}" = "ABANDONED" ]; then
    [ -n "${ACTOR_TENANT}" ] || { echo "ERROR: PILOT_1_ACTOR_TENANT (the operator's home tenant) is required for ABANDONED" >&2; exit 2; }
    [[ "${ACTOR_TENANT}" =~ ^[A-Za-z0-9-]{1,64}$ ]] || { echo "ERROR: PILOT_1_ACTOR_TENANT must be a tenant id" >&2; exit 2; }
fi
for f in "${HERE}/lib/incident-manifest.mjs" "${HERE}/lib/incident-writers.mjs"; do
    [ -r "$f" ] || { echo "ERROR: required file missing: $f" >&2; exit 2; }
done
command -v "${FLOCK}" >/dev/null 2>&1 || { echo "ERROR: flock (util-linux) is required for the lifecycle lock" >&2; exit 2; }
if [ -L "${LOCK_FILE}" ]; then echo "ERROR: PILOT_1_LOCK_FILE (${LOCK_FILE}) must not be a symbolic link" >&2; exit 2; fi
case "$(cd "$(dirname "${LOCK_FILE}")" 2>/dev/null && pwd -P)/" in
    "$(cd "${INCIDENT_DIR}" 2>/dev/null && pwd -P)/"*) echo "ERROR: PILOT_1_LOCK_FILE must not be inside the incident directory" >&2; exit 2 ;;
esac

# --- lifecycle lock (shared with env-purge) ------------------------------------
exec 9>>"${LOCK_FILE}" || { echo "ERROR: cannot open the lifecycle lock file ${LOCK_FILE}" >&2; exit 2; }
if [ -L "${LOCK_FILE}" ] || [ ! -f "${LOCK_FILE}" ]; then echo "ERROR: lifecycle lock file ${LOCK_FILE} is not a regular file" >&2; exit 2; fi
if ! "${FLOCK}" -n 9; then
    echo "REFUSED: another Pilot 1 lifecycle (purge or clearance) holds ${LOCK_FILE}; wait for it (nothing changed)" >&2; exit 1
fi

# --- incident state --------------------------------------------------------------
[ -d "${INCIDENT_DIR}" ] || { echo "REFUSED: incident-logs directory not found or not a directory: ${INCIDENT_DIR}" >&2; exit 1; }
LOCKSTATE="$("${NODE}" "${HERE}/lib/incident-manifest.mjs" lock-state --dir "${INCIDENT_DIR}")" || { echo "REFUSED: incident lock cannot be inspected: ${LOCKSTATE}" >&2; exit 1; }
LOCK_PRESENT="$(printf '%s' "${LOCKSTATE}" | sed -n 's/.*"present":\(true\|false\).*/\1/p')"
LOCK_INCIDENT="$(printf '%s' "${LOCKSTATE}" | sed -n 's/.*"incidentId":"\([^"]*\)".*/\1/p')"
[ "${LOCK_PRESENT}" = "true" ] || { echo "REFUSED: no incident lock is present — incident ${INCIDENT_ID} is not active (already cleared, or capture never ran); nothing changed" >&2; exit 1; }
[ "${LOCK_INCIDENT}" = "${INCIDENT_ID}" ] || { echo "REFUSED: the incident lock belongs to '${LOCK_INCIDENT:-malformed}', not ${INCIDENT_ID}; nothing changed" >&2; exit 1; }

MANIFEST_FILE="${INCIDENT_DIR}/${INCIDENT_ID}.manifest.json"
[ -f "${MANIFEST_FILE}" ] && [ ! -L "${MANIFEST_FILE}" ] || { echo "REFUSED: manifest missing or not a regular file: ${MANIFEST_FILE}" >&2; exit 1; }
MSTATE="$("${NODE}" -e '
const fs = require("node:fs");
let m; try { m = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.stdout.write("malformed|"); process.exit(0); }
if (!m || typeof m !== "object") { process.stdout.write("malformed|"); process.exit(0); }
process.stdout.write(`${m.consumed === true ? "consumed" : m.consumed === false ? "open" : "invalid"}|${typeof m.disposition === "string" ? m.disposition : ""}`);
' "${MANIFEST_FILE}")"
IFS='|' read -r M_CONSUMED M_DISPOSITION <<< "${MSTATE}"
case "${M_CONSUMED}" in
    open) ;;
    consumed)
        [ "${M_DISPOSITION}" = "${DISPOSITION}" ] || { echo "REFUSED: manifest for ${INCIDENT_ID} is already consumed with disposition '${M_DISPOSITION}'; nothing changed" >&2; exit 1; } ;;
    *) echo "REFUSED: manifest for ${INCIDENT_ID} is ${M_CONSUMED} (counts as FAILED); nothing changed" >&2; exit 1 ;;
esac

# --- evidence in audit_records ----------------------------------------------------
COUNTS="$("${PSQL}" --dbname="${DSN}" -X -q -A -t -v ON_ERROR_STOP=1 -v iid="${INCIDENT_ID}" <<'SQL'
SELECT (SELECT COUNT(*) FROM audit_records WHERE action = 'env.purge.executed' AND payload->>'incidentId' = :'iid')
       || '|' || (SELECT COUNT(*) FROM audit_records WHERE action = 'env.incident.abandoned' AND payload->>'incidentId' = :'iid');
SQL
)" || { echo "ERROR: could not read audit_records for incident ${INCIDENT_ID}" >&2; exit 3; }
IFS='|' read -r PURGE_ROWS ABANDON_ROWS <<< "${COUNTS}"
[[ "${PURGE_ROWS}" =~ ^[0-9]+$ ]] && [[ "${ABANDON_ROWS}" =~ ^[0-9]+$ ]] || { echo "ERROR: unexpected audit_records answer '${COUNTS}'" >&2; exit 3; }
PURGE_ATTESTED=false; [ "${PURGE_ROWS}" != "0" ] && PURGE_ATTESTED=true

if [ "${DISPOSITION}" = "RESOLVED" ] && [ "${PURGE_ATTESTED}" != "true" ]; then
    echo "REFUSED: RESOLVED requires a committed env.purge.executed attestation for incident ${INCIDENT_ID} (none found); use --disposition ABANDONED --force-abandoned <reason> if the purge was not appropriate; nothing changed" >&2; exit 1
fi

CLEARED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
EMITTED=false
if [ "${DISPOSITION}" = "ABANDONED" ] && [ "${ABANDON_ROWS}" = "0" ]; then
    # Audit FIRST (I-003 / I-027): one row per tenant, correlated by incidentId,
    # under the purge advisory lock; a concurrent purge cannot interleave.
    if ! "${PSQL}" --dbname="${DSN}" -X -q -v ON_ERROR_STOP=1 \
        -v iid="${INCIDENT_ID}" -v reason="${REASON}" -v actor="${ACTOR}" -v actor_tenant="${ACTOR_TENANT}" \
        -v purge_attested="${PURGE_ATTESTED}" -v cleared_at="${CLEARED_AT}" <<'SQL' >/dev/null 2>"${TMPDIR:-/tmp}/incident-clear.$$.err"
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('pilot-1-env-purge'));
SELECT set_config('pilot1.iid', :'iid', true), set_config('pilot1.reason', :'reason', true),
       set_config('pilot1.actor', :'actor', true), set_config('pilot1.actor_tenant', :'actor_tenant', true),
       set_config('pilot1.purge_attested', :'purge_attested', true), set_config('pilot1.cleared_at', :'cleared_at', true);
DO $$
DECLARE v_t RECORD; v_n BIGINT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = current_setting('pilot1.actor_tenant')) THEN
        RAISE EXCEPTION 'CLEAR_REFUSED: actor tenant % does not exist', current_setting('pilot1.actor_tenant');
    END IF;
    SELECT COUNT(*) INTO v_n FROM audit_records WHERE action = 'env.incident.abandoned' AND payload->>'incidentId' = current_setting('pilot1.iid');
    IF v_n <> 0 THEN RAISE EXCEPTION 'CLEAR_REFUSED: incident % is already recorded as abandoned', current_setting('pilot1.iid'); END IF;
    FOR v_t IN SELECT id FROM tenants ORDER BY id LOOP
        INSERT INTO audit_records (tenant_id, category, audit_sensitivity_level, action, actor_type, actor_id, actor_tenant_id,
                                   target_patient_id, resource_type, resource_id, country_of_care, payload)
        VALUES (v_t.id, 'B', 'standard', 'env.incident.abandoned', 'platform_admin', current_setting('pilot1.actor'), current_setting('pilot1.actor_tenant'),
                NULL, 'incident', current_setting('pilot1.iid'), NULL,
                jsonb_build_object('incidentId', current_setting('pilot1.iid'), 'reason', current_setting('pilot1.reason'),
                                   'disposition', 'ABANDONED', 'purgeAttested', current_setting('pilot1.purge_attested')::boolean,
                                   'clearedAt', current_setting('pilot1.cleared_at'), 'actor', current_setting('pilot1.actor'),
                                   'script', 'scripts/incident-clear.sh'));
    END LOOP;
END
$$;
COMMIT;
SQL
    then
        ERRF="${TMPDIR:-/tmp}/incident-clear.$$.err"
        if grep -q CLEAR_REFUSED "${ERRF}"; then echo "REFUSED: $(grep -o 'CLEAR_REFUSED:[^"]*' "${ERRF}" | head -1 | sed 's/CLEAR_REFUSED: //') (nothing changed)" >&2; rm -f "${ERRF}"; exit 1; fi
        echo "ERROR: could not record env.incident.abandoned for ${INCIDENT_ID} (transaction rolled back; nothing changed):" >&2; sed 's/^/    /' "${ERRF}" >&2; rm -f "${ERRF}"; exit 3
    fi
    rm -f "${TMPDIR:-/tmp}/incident-clear.$$.err"
    EMITTED=true
fi

# --- consume the manifest, then remove the lock (both no-follow, atomic) --------------
CONSUME_ARGS=(consume --dir "${INCIDENT_DIR}" --incident-id "${INCIDENT_ID}" --disposition "${DISPOSITION}" --cleared-by "${ACTOR}" --purge-attested "${PURGE_ATTESTED}")
[ "${DISPOSITION}" = "ABANDONED" ] && CONSUME_ARGS+=(--reason "${REASON}")
CONSUMED="$("${NODE}" "${HERE}/lib/incident-writers.mjs" "${CONSUME_ARGS[@]}")" || { echo "ERROR: could not consume the manifest for ${INCIDENT_ID}: ${CONSUMED}$([ "${EMITTED}" = "true" ] && echo ' (the env.incident.abandoned attestation is committed; re-run to complete)')" >&2; exit 3; }
ALREADY="$(printf '%s' "${CONSUMED}" | sed -n 's/.*"alreadyConsumed":\(true\|false\).*/\1/p')"
REMOVED="$("${NODE}" "${HERE}/lib/incident-writers.mjs" remove-lock --dir "${INCIDENT_DIR}" --incident-id "${INCIDENT_ID}")" || { echo "ERROR: manifest consumed but the incident lock could not be removed: ${REMOVED} — re-run with the same disposition to complete" >&2; exit 3; }

if [ "${FORMAT}" = "json" ]; then
    printf '{"incidentId":"%s","disposition":"%s","purgeAttested":%s,"abandonedAttestationEmitted":%s,"completedInterruptedClearance":%s,"clearedAt":"%s","clearedBy":"%s","status":"cleared"}\n' \
        "${INCIDENT_ID}" "${DISPOSITION}" "${PURGE_ATTESTED}" "${EMITTED}" "${ALREADY:-false}" "${CLEARED_AT}" "${ACTOR}"
else
    echo "OK: incident ${INCIDENT_ID} cleared (${DISPOSITION}); manifest consumed, incident lock removed$([ "${ALREADY}" = "true" ] && echo ' (completed an interrupted clearance)')."
fi
exit 0
