#!/usr/bin/env bash
#
# pilot-1-env-purge.sh — idempotent full reset of the Pilot 1 substrate.
#
# Per docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md §Environment purge/reset
# procedure (and §Purge table classification policy, §Cohort-classification
# integrity) and docs/PILOT_1_INCIDENT_RESPONSE_MINI_RUNBOOK.md.
#
# Modes (exactly one is required):
#   --routine-reset       no active incident (end of session / between test
#                         days). REFUSES if the incident lock exists, ANY
#                         unconsumed manifest exists, or the incident
#                         directory cannot be inspected.
#   --incident-id <id>    manifest + lock bound: the manifest for <id> must
#                         exist, be SUCCESS, be <= 30 min old, match <id>, list
#                         >= 1 structurally valid artifact, be consumed:false,
#                         and the lock must belong to <id>; the purge must not
#                         already be attested for <id> (single use).
#   --finish-runtime --operation-id <uuid>
#                         recovery ONLY, after exit 4 / 5: re-run the re-seed
#                         (idempotent) and the runtime steps for a purge whose
#                         attestation for <uuid> is COMMITTED, provided the
#                         incident state still matches that attestation. No
#                         database purge, no new attestation.
#
# Every mode holds the LIFECYCLE LOCK (a host-level lock directory) from
# before the app is stopped until the runtime steps are done, so two
# invocations can never interleave: the second refuses immediately. A stale
# lock (its recorded pid is dead) is taken over and reported.
#
# Purge modes:
#   1. verify-pilot-1-baseline.sh must be green (no `unclassified` account).
#   2. ONE transaction: advisory transaction lock → checks re-verified → ONE
#      `env.purge.executed` attestation row PER TENANT (resource tenant =
#      each purged tenant, actor_tenant_id = the operator's home tenant, all
#      correlated by an operation id, PLATFORM partition) → the FK-aware plan
#      rendered from scripts/pilot-1-purge-classification.json → COMMIT. Any
#      error rolls back everything — including the attestation. If psql fails
#      WITHOUT a refusal, the outcome is RECONCILED: a fresh session takes the
#      same advisory lock (so an in-flight COMMIT finishes first; bounded by
#      lock_timeout) and looks the operation id up: found → committed, the
#      run continues; absent → rolled back (exit 3); lookup impossible →
#      exit 5 with the app left stopped (outcome unknown).
#   3. Re-seed the synthetic baseline (scripts/pilot-1-baseline-seed.sql) in a
#      separate transaction, then the runtime steps: Redis FLUSHALL, Caddy
#      access-log truncate (configured paths only — the checked-in Caddyfile
#      writes none), app container REMOVED and RECREATED (its Docker-retained
#      stdout log goes with it — the app logs to stdout), and a health check
#      that requires exactly HTTP 200 from every configured URL.
#
# This script READS the incident directory and never writes, modifies or
# deletes anything under it (single-writer discipline; CI asserts byte-for-
# byte). It performs NO evidence capture.
#
# Exit codes:
#   0  purged, attested, re-seeded (and runtime steps done unless skipped)
#   1  refused by a precondition or by the lifecycle lock (nothing written)
#   2  usage / environment error (nothing written)
#   3  the purge transaction rolled back (verified under the advisory lock)
#   4  a step AFTER the committed purge failed (re-seed / runtime step);
#      the purge is committed and attested — run --finish-runtime
#   5  outcome UNKNOWN: the transaction's result could not be reconciled;
#      the app is left stopped — inspect audit_records for the operation id,
#      then --finish-runtime (if attested) or re-run the purge (if not)
#
# Environment:
#   PILOT_1_DATABASE_URL         operator DSN (defaults to $DATABASE_URL); a
#                                cross-tenant role with BYPASSRLS / superuser
#   PILOT_1_PSQL / PILOT_1_NODE / PILOT_1_CURL   binaries (psql / node / curl)
#   PILOT_1_ACTOR                actor id ([A-Za-z0-9._@+-]{1,120}; default <user>@<host>)
#   PILOT_1_ACTOR_TENANT         operator's home tenant (required for purge modes)
#   PILOT_1_INCIDENT_LOGS_DIR    default /home/deploy/incident-logs
#   PILOT_1_LOCK_DIR             lifecycle lock directory (default /var/tmp/pilot-1-env-purge.lock)
#   PILOT_1_COMPOSE              compose command (default "docker compose")
#   PILOT_1_CADDY_LOG_PATHS      space-separated in-container Caddy log files to
#                                truncate (default: none)
#   PILOT_1_HEALTH_URLS          space-separated URLs that must return exactly
#                                HTTP 200 after the restart — REQUIRED unless
#                                runtime steps are skipped
#   PILOT_1_SKIP_RUNTIME_STEPS   =1 skips every docker-compose step and the
#                                health check (CI / tests)
#   PILOT_1_TEST_FAIL_AFTER      TEST HOOK: audit-insert|audit|truncate|delete —
#                                injects a failure inside the purge transaction
#
# Options: --routine-reset | --incident-id <id> | --finish-runtime --operation-id <uuid> ; --json ; --help

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSN="${PILOT_1_DATABASE_URL:-${DATABASE_URL:-}}"
PSQL="${PILOT_1_PSQL:-psql}"
NODE="${PILOT_1_NODE:-node}"
CURL="${PILOT_1_CURL:-curl}"
ACTOR="${PILOT_1_ACTOR:-}"
ACTOR_TENANT="${PILOT_1_ACTOR_TENANT:-}"
INCIDENT_DIR="${PILOT_1_INCIDENT_LOGS_DIR:-/home/deploy/incident-logs}"
LOCK_DIR="${PILOT_1_LOCK_DIR:-/var/tmp/pilot-1-env-purge.lock}"
COMPOSE="${PILOT_1_COMPOSE:-docker compose}"
CADDY_LOGS="${PILOT_1_CADDY_LOG_PATHS:-}"
HEALTH_URLS="${PILOT_1_HEALTH_URLS:-}"
SKIP_RUNTIME="${PILOT_1_SKIP_RUNTIME_STEPS:-0}"
FAIL_AFTER="${PILOT_1_TEST_FAIL_AFTER:-}"
MODE=""
INCIDENT_ID=""
OP_ID=""
FORMAT="human"
APP_STOPPED=0
LOCK_OWNED=0

usage() { sed -n '2,90p' "$0" | sed 's/^# \{0,1\}//'; }
set_mode() { [ -z "${MODE}" ] || { echo "ERROR: --routine-reset, --incident-id and --finish-runtime are mutually exclusive" >&2; exit 2; }; MODE="$1"; }

while [ $# -gt 0 ]; do
    case "$1" in
        --routine-reset)  set_mode "routine-reset"; shift ;;
        --finish-runtime) set_mode "finish-runtime"; shift ;;
        --incident-id)    set_mode "incident"; [ $# -ge 2 ] || { echo "ERROR: --incident-id requires a value" >&2; exit 2; }; INCIDENT_ID="$2"; shift 2 ;;
        --operation-id)   [ $# -ge 2 ] || { echo "ERROR: --operation-id requires a value" >&2; exit 2; }; OP_ID="$2"; shift 2 ;;
        --json)           FORMAT="json"; shift ;;
        --help|-h)        usage; exit 0 ;;
        *)                echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
    esac
done

# --- validation: nothing runs until every check passes -----------------------
[ -n "${MODE}" ] || { echo "ERROR: exactly one of --routine-reset, --incident-id <id> or --finish-runtime is required" >&2; exit 2; }
if [ "${MODE}" = "incident" ] && ! [[ "${INCIDENT_ID}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
    echo "ERROR: --incident-id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ (got '${INCIDENT_ID}')" >&2; exit 2
fi
if [ "${MODE}" = "finish-runtime" ]; then
    [[ "${OP_ID}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo "ERROR: --finish-runtime requires --operation-id <uuid> of the committed purge" >&2; exit 2; }
elif [ -n "${OP_ID}" ]; then
    echo "ERROR: --operation-id is only valid with --finish-runtime" >&2; exit 2
fi
[ -n "${DSN}" ] || { echo "ERROR: PILOT_1_DATABASE_URL (or DATABASE_URL) is not set" >&2; exit 2; }
case "${DSN}" in -*) echo "ERROR: the DSN must not begin with '-'" >&2; exit 2 ;; esac
if [ -z "${ACTOR}" ]; then ACTOR="$(id -un 2>/dev/null || echo operator)@$(hostname 2>/dev/null || echo unknown-host)"; fi
[[ "${ACTOR}" =~ ^[A-Za-z0-9._@+-]{1,120}$ ]] || { echo "ERROR: actor id must match [A-Za-z0-9._@+-]{1,120}" >&2; exit 2; }
if [ "${MODE}" != "finish-runtime" ]; then
    [ -n "${ACTOR_TENANT}" ] || { echo "ERROR: PILOT_1_ACTOR_TENANT (the operator's home tenant) is required" >&2; exit 2; }
    [[ "${ACTOR_TENANT}" =~ ^[A-Za-z0-9-]{1,64}$ ]] || { echo "ERROR: PILOT_1_ACTOR_TENANT must be a tenant id" >&2; exit 2; }
fi
if [ -n "${FAIL_AFTER}" ]; then
    case "${FAIL_AFTER}" in audit-insert|audit|truncate|delete) ;; *) echo "ERROR: PILOT_1_TEST_FAIL_AFTER must be audit-insert|audit|truncate|delete" >&2; exit 2 ;; esac
fi
if [ "${SKIP_RUNTIME}" != "1" ] && [ -z "${HEALTH_URLS}" ]; then
    echo "ERROR: PILOT_1_HEALTH_URLS is required when runtime steps run (both tenant hosts' health URLs); a purge that cannot prove the app came back is not complete" >&2; exit 2
fi
for f in "${HERE}/lib/purge-plan.mjs" "${HERE}/lib/incident-manifest.mjs" "${HERE}/verify-pilot-1-baseline.sh" "${HERE}/pilot-1-baseline-seed.sql" "${HERE}/pilot-1-purge-classification.json"; do
    [ -r "$f" ] || { echo "ERROR: required file missing: $f" >&2; exit 2; }
done

TMP="$(mktemp -d)"
cleanup() {
    rm -rf "${TMP}"
    if [ "${LOCK_OWNED}" = "1" ]; then rm -rf "${LOCK_DIR}"; fi
}
trap cleanup EXIT

# --- lifecycle lock: from before the app is stopped until the runtime steps end
take_lifecycle_lock() {
    if mkdir "${LOCK_DIR}" 2>/dev/null; then
        echo "$$" > "${LOCK_DIR}/pid"; LOCK_OWNED=1; return 0
    fi
    local pid
    pid="$(cat "${LOCK_DIR}/pid" 2>/dev/null || echo '')"
    if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
        echo "REFUSED: another purge lifecycle (pid ${pid}) holds ${LOCK_DIR}; wait for it to finish (nothing written)" >&2
        exit 1
    fi
    echo "WARNING: stale lifecycle lock at ${LOCK_DIR} (pid '${pid}' is not running) — taking it over" >&2
    rm -rf "${LOCK_DIR}"
    if mkdir "${LOCK_DIR}" 2>/dev/null; then
        echo "$$" > "${LOCK_DIR}/pid"; LOCK_OWNED=1; return 0
    fi
    echo "REFUSED: could not take the lifecycle lock at ${LOCK_DIR} (nothing written)" >&2
    exit 1
}
take_lifecycle_lock

runtime_post_steps() {
    # Runs after a COMMITTED purge (or in --finish-runtime). Any failure exits 4:
    # the purge is committed and attested; re-run with --finish-runtime.
    [ "${SKIP_RUNTIME}" != "1" ] || return 0
    ${COMPOSE} exec redis redis-cli FLUSHALL >/dev/null || { echo "ERROR: purge COMMITTED; Redis FLUSHALL failed — re-run with --finish-runtime --operation-id ${OP_ID}" >&2; exit 4; }
    if [ -n "${CADDY_LOGS}" ]; then
        for f in ${CADDY_LOGS}; do
            ${COMPOSE} exec caddy sh -c "[ -e '${f}' ] && : > '${f}'" || { echo "ERROR: purge COMMITTED; Caddy log truncate failed for ${f} — re-run with --finish-runtime --operation-id ${OP_ID}" >&2; exit 4; }
        done
    else
        echo "    Caddy access log: no PILOT_1_CADDY_LOG_PATHS configured (the checked-in Caddyfile writes none) — nothing to truncate." >&2
    fi
    ${COMPOSE} rm -sf app >/dev/null || { echo "ERROR: purge COMMITTED; could not remove the app container — re-run with --finish-runtime --operation-id ${OP_ID}" >&2; exit 4; }
    ${COMPOSE} up -d app || { echo "ERROR: purge COMMITTED; app did not start — re-run with --finish-runtime --operation-id ${OP_ID}" >&2; exit 4; }
    for url in ${HEALTH_URLS}; do
        ok=0
        for _ in $(seq 1 30); do
            code="$("${CURL}" -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 "${url}" 2>/dev/null || echo '000')"
            if [ "${code}" = "200" ]; then ok=1; break; fi
            sleep 2
        done
        [ "${ok}" = "1" ] || { echo "ERROR: purge COMMITTED; health check did not return HTTP 200 for ${url} (last: ${code}) — re-run with --finish-runtime --operation-id ${OP_ID}" >&2; exit 4; }
    done
}

reseed() {
    if ! "${PSQL}" --dbname="${DSN}" -X -q -v ON_ERROR_STOP=1 -f "${HERE}/pilot-1-baseline-seed.sql" >/dev/null 2>"${TMP}/seed.err"; then
        echo "ERROR: purge COMMITTED and attested, but re-seed failed — re-run with --finish-runtime --operation-id ${OP_ID}:" >&2
        sed 's/^/    /' "${TMP}/seed.err" >&2
        exit 4
    fi
}

restart_app_if_stopped() {
    [ "${APP_STOPPED}" = "1" ] && [ "${SKIP_RUNTIME}" != "1" ] && ${COMPOSE} start app >/dev/null 2>&1 || true
}

# --- recovery mode: bound to a COMMITTED attestation + consistent incident state
if [ "${MODE}" = "finish-runtime" ]; then
    ATT="$("${PSQL}" --dbname="${DSN}" -X -A -t -v ON_ERROR_STOP=1 -v op="${OP_ID}" <<'SQL'
SELECT payload->>'mode' || '|' || COALESCE(payload->>'incidentId', '')
  FROM audit_records WHERE action = 'env.purge.executed' AND payload->>'operationId' = :'op'
 ORDER BY recorded_at LIMIT 1;
SQL
)" || { echo "ERROR: could not look up the attestation for operation ${OP_ID}" >&2; exit 3; }
    [ -n "${ATT}" ] || { echo "REFUSED: no committed env.purge.executed attestation for operation ${OP_ID}; recovery only completes a purge that committed (nothing written)" >&2; exit 1; }
    IFS='|' read -r ATT_MODE ATT_INCIDENT <<< "${ATT}"
    [ -d "${INCIDENT_DIR}" ] || { echo "REFUSED: incident-logs directory not found or not a directory: ${INCIDENT_DIR}" >&2; exit 1; }
    LOCKSTATE="$("${NODE}" "${HERE}/lib/incident-manifest.mjs" lock-state --dir "${INCIDENT_DIR}")" || { echo "REFUSED: incident lock cannot be inspected: ${LOCKSTATE}" >&2; exit 1; }
    LOCK_PRESENT="$(printf '%s' "${LOCKSTATE}" | sed -n 's/.*"present":\(true\|false\).*/\1/p')"
    LOCK_INCIDENT="$(printf '%s' "${LOCKSTATE}" | sed -n 's/.*"incidentId":"\([^"]*\)".*/\1/p')"
    if [ "${ATT_MODE}" = "incident" ]; then
        [ "${LOCK_PRESENT}" = "true" ] && [ "${LOCK_INCIDENT}" = "${ATT_INCIDENT}" ] || { echo "REFUSED: operation ${OP_ID} purged incident ${ATT_INCIDENT} but the current incident lock is $( [ "${LOCK_PRESENT}" = "true" ] && echo "for '${LOCK_INCIDENT}'" || echo "absent" ); the incident state no longer matches (nothing written)" >&2; exit 1; }
    else
        [ "${LOCK_PRESENT}" != "true" ] || { echo "REFUSED: operation ${OP_ID} was a routine-reset but an incident lock (${LOCK_INCIDENT}) is now present; dispose of the incident first (nothing written)" >&2; exit 1; }
    fi
    reseed
    runtime_post_steps
    if [ "${FORMAT}" = "json" ]; then
        printf '{"mode":"finish-runtime","operationId":"%s","attestedMode":"%s","status":"finished","runtimeStepsSkipped":%s}\n' "${OP_ID}" "${ATT_MODE}" "$([ "${SKIP_RUNTIME}" = "1" ] && echo true || echo false)"
    else
        echo "OK: re-seed and runtime steps completed for committed operation ${OP_ID} (${ATT_MODE}); no database purge was performed in this mode."
    fi
    exit 0
fi

# --- step A: operator capability + actor tenant (read-only) -------------------
CAP="$("${PSQL}" --dbname="${DSN}" -X -A -t -v ON_ERROR_STOP=1 -v actor_tenant="${ACTOR_TENANT}" <<'SQL'
SELECT (SELECT CASE WHEN rolsuper OR rolbypassrls THEN 't' ELSE 'f' END FROM pg_roles WHERE rolname = current_user)
       || '|' || (SELECT CASE WHEN EXISTS (SELECT 1 FROM tenants WHERE id = :'actor_tenant') THEN 't' ELSE 'f' END)
       || '|' || (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'cohort_classification');
SQL
)" || { echo "ERROR: could not read operator capability" >&2; exit 3; }
IFS='|' read -r BYPASS ACTOR_TENANT_EXISTS COHORT_COL <<< "${CAP}"
[ "${BYPASS}" = "t" ] || { echo "REFUSED: the operator role cannot bypass RLS (BYPASSRLS / superuser required to purge across tenants)" >&2; exit 1; }
[ "${ACTOR_TENANT_EXISTS}" = "t" ] || { echo "ERROR: actor tenant '${ACTOR_TENANT}' does not exist" >&2; exit 2; }
[ "${COHORT_COL}" = "1" ] || { echo "REFUSED: accounts.cohort_classification is absent — migration 080 not applied; the purge predicate has no authority" >&2; exit 1; }

# --- step B: incident-logs preconditions (READ-ONLY; node helper) -------------
[ -d "${INCIDENT_DIR}" ] || { echo "REFUSED: incident-logs directory not found or not a directory: ${INCIDENT_DIR}" >&2; exit 1; }
ARTIFACTS=0
if [ "${MODE}" = "routine-reset" ]; then
    if ! BLOCK="$("${NODE}" "${HERE}/lib/incident-manifest.mjs" routine-blockers --dir "${INCIDENT_DIR}")"; then
        echo "REFUSED: routine-reset is blocked by incident state under ${INCIDENT_DIR}:" >&2
        echo "         ${BLOCK}" >&2
        echo "         Dispose of the incident with scripts/incident-clear.sh first (or fix the directory's permissions)." >&2
        exit 1
    fi
else
    if ! VERIFY="$("${NODE}" "${HERE}/lib/incident-manifest.mjs" verify-purge --dir "${INCIDENT_DIR}" --incident-id "${INCIDENT_ID}")"; then
        echo "REFUSED: incident-mode preconditions failed for ${INCIDENT_ID}:" >&2
        echo "         ${VERIFY}" >&2
        exit 1
    fi
    ARTIFACTS="$(printf '%s' "${VERIFY}" | sed -n 's/.*"artifacts":\([0-9]*\).*/\1/p')"
    [ -n "${ARTIFACTS}" ] || ARTIFACTS=0
fi

# --- step C: cohort-classification integrity preflight (both modes) -----------
if ! GATE="$(PILOT_1_DATABASE_URL="${DSN}" PILOT_1_PSQL="${PSQL}" bash "${HERE}/verify-pilot-1-baseline.sh" --json 2>&1)"; then
    echo "REFUSED: cohort-classification integrity gate is not green — purge would have no authority over unclassified accounts:" >&2
    echo "         ${GATE}" >&2
    echo "         Classify each offending account with scripts/pilot-1-marker-remediation.sh and re-run." >&2
    exit 1
fi

# --- step D: single-use attestation (incident mode; re-checked under the lock) --
if [ "${MODE}" = "incident" ]; then
    PRIOR="$("${PSQL}" --dbname="${DSN}" -X -A -t -v ON_ERROR_STOP=1 -v iid="${INCIDENT_ID}" <<'SQL'
SELECT COUNT(*) FROM audit_records WHERE action = 'env.purge.executed' AND payload->>'incidentId' = :'iid';
SQL
)" || { echo "ERROR: could not read prior attestations" >&2; exit 3; }
    if [ "${PRIOR}" != "0" ]; then
        echo "REFUSED: env.purge.executed is already attested for incident ${INCIDENT_ID} (${PRIOR} row(s)); a purge runs once per incident. Dispose of the incident with scripts/incident-clear.sh." >&2
        exit 1
    fi
fi

# --- step E: render the plan; mint the operation id ---------------------------
PLAN="${TMP}/plan.sql"
PLAN_FAIL=""
case "${FAIL_AFTER}" in audit|truncate|delete) PLAN_FAIL="${FAIL_AFTER}" ;; esac
if [ -n "${PLAN_FAIL}" ]; then
    "${NODE}" "${HERE}/lib/purge-plan.mjs" render --fail-after "${PLAN_FAIL}" > "${PLAN}"
else
    "${NODE}" "${HERE}/lib/purge-plan.mjs" render > "${PLAN}"
fi
DIGEST="$("${NODE}" "${HERE}/lib/purge-plan.mjs" digest)"
CLS_VERSION="$(sed -n 's/^  "version": \([0-9]*\),$/\1/p' "${HERE}/pilot-1-purge-classification.json" | head -1)"
[ -n "${CLS_VERSION}" ] || CLS_VERSION=0
OP_ID="$("${NODE}" -e 'process.stdout.write(require("node:crypto").randomUUID())')"
FAIL_INSERT=0
[ "${FAIL_AFTER}" = "audit-insert" ] && FAIL_INSERT=1

# --- step F: freeze the app (runtime) ------------------------------------------
if [ "${SKIP_RUNTIME}" != "1" ]; then
    ${COMPOSE} exec app pkill -TERM node >/dev/null 2>&1 || true
    ${COMPOSE} stop app || { echo "ERROR: could not stop the app container (nothing written)" >&2; exit 3; }
    APP_STOPPED=1
fi

# --- step G: ONE transaction — lock, checks, attestation, plan -------------------
TX="${TMP}/tx.sql"
{
cat <<'SQL'
BEGIN;
-- Serialises every purge transaction (and the reconciliation lookups) so two
-- invocations cannot both pass the single-use check (Codex R1).
SELECT pg_advisory_xact_lock(hashtext('pilot-1-env-purge'));
SELECT set_config('pilot1.mode',            :'mode',            true),
       set_config('pilot1.incident_id',     :'incident_id',     true),
       set_config('pilot1.operation_id',    :'operation_id',    true),
       set_config('pilot1.actor',           :'actor',           true),
       set_config('pilot1.actor_tenant',    :'actor_tenant',    true),
       set_config('pilot1.plan_digest',     :'plan_digest',     true),
       set_config('pilot1.cls_version',     :'cls_version',     true),
       set_config('pilot1.artifacts',       :'artifacts',       true),
       set_config('pilot1.fail_insert',     :'fail_insert',     true);
DO $$
DECLARE
    v_mode         TEXT := current_setting('pilot1.mode');
    v_incident     TEXT := NULLIF(current_setting('pilot1.incident_id'), '');
    v_op           TEXT := current_setting('pilot1.operation_id');
    v_actor        TEXT := current_setting('pilot1.actor');
    v_actor_tenant TEXT := current_setting('pilot1.actor_tenant');
    v_digest       TEXT := current_setting('pilot1.plan_digest');
    v_cls_version  TEXT := current_setting('pilot1.cls_version');
    v_artifacts    TEXT := current_setting('pilot1.artifacts');
    v_fail_insert  TEXT := current_setting('pilot1.fail_insert');
    v_purged_at    TIMESTAMPTZ := clock_timestamp();
    v_tenants      JSONB;
    v_t            RECORD;
    v_n            BIGINT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
        RAISE EXCEPTION 'PURGE_REFUSED: the operator role cannot bypass RLS';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = v_actor_tenant) THEN
        RAISE EXCEPTION 'PURGE_REFUSED: actor tenant % does not exist', v_actor_tenant;
    END IF;
    SELECT COUNT(*) INTO v_n FROM accounts WHERE cohort_classification = 'unclassified';
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'PURGE_REFUSED: % unclassified account(s) — verify-pilot-1-baseline.sh must be green', v_n;
    END IF;
    IF v_mode = 'incident' THEN
        IF v_incident IS NULL THEN RAISE EXCEPTION 'PURGE_REFUSED: incident mode without an incident id'; END IF;
        SELECT COUNT(*) INTO v_n FROM audit_records WHERE action = 'env.purge.executed' AND payload->>'incidentId' = v_incident;
        IF v_n <> 0 THEN RAISE EXCEPTION 'PURGE_REFUSED: incident % is already attested', v_incident; END IF;
    END IF;
    SELECT COUNT(*) INTO v_n FROM audit_records WHERE action = 'env.purge.executed' AND payload->>'operationId' = v_op;
    IF v_n <> 0 THEN RAISE EXCEPTION 'PURGE_REFUSED: operation % is already attested', v_op; END IF;
    SELECT COALESCE(jsonb_agg(id ORDER BY id), '[]'::jsonb) INTO v_tenants FROM tenants;
    -- Attestation FIRST (I-003 / I-027): one row PER TENANT — the resource
    -- tenant is each purged tenant; actor_tenant_id is the operator's home
    -- tenant; all rows share the operation id. PLATFORM partition. Rolls back
    -- with everything below on any error. The TEST hook `audit-insert` makes
    -- this very INSERT fail (FK violation on tenant_id).
    FOR v_t IN SELECT id FROM tenants ORDER BY id LOOP
        INSERT INTO audit_records (
            tenant_id, category, audit_sensitivity_level, action,
            actor_type, actor_id, actor_tenant_id,
            target_patient_id, resource_type, resource_id, country_of_care,
            payload
        ) VALUES (
            CASE WHEN v_fail_insert = '1' THEN v_t.id || '-TEST-DOES-NOT-EXIST' ELSE v_t.id END,
            'B', 'standard', 'env.purge.executed',
            'platform_admin', v_actor, v_actor_tenant,
            NULL, 'environment', COALESCE(v_incident, 'routine-reset'), NULL,
            jsonb_build_object(
                'operationId', v_op,
                'incidentId', v_incident,
                'mode', v_mode,
                'purgedAt', v_purged_at,
                'actor', v_actor,
                'actorTenantId', v_actor_tenant,
                'tenants', v_tenants,
                'planDigest', v_digest,
                'classificationVersion', v_cls_version::int,
                'artifacts', v_artifacts::int,
                'script', 'scripts/pilot-1-env-purge.sh'
            )
        );
    END LOOP;
END
$$;
SQL
cat "${PLAN}"
echo "COMMIT;"
} > "${TX}"

ERR="${TMP}/tx.err"
set +e
"${PSQL}" --dbname="${DSN}" -X -q -v ON_ERROR_STOP=1 \
    -v mode="${MODE}" -v incident_id="${INCIDENT_ID}" -v operation_id="${OP_ID}" -v actor="${ACTOR}" -v actor_tenant="${ACTOR_TENANT}" \
    -v plan_digest="${DIGEST}" -v cls_version="${CLS_VERSION}" -v artifacts="${ARTIFACTS}" -v fail_insert="${FAIL_INSERT}" \
    -f "${TX}" >/dev/null 2>"${ERR}"
STATUS=$?
set -e
RECONCILED=false
if [ "${STATUS}" -ne 0 ]; then
    if grep -q "PURGE_REFUSED" "${ERR}"; then
        echo "REFUSED: $(grep -o 'PURGE_REFUSED:[^"]*' "${ERR}" | head -1 | sed 's/PURGE_REFUSED: //') (transaction rolled back; nothing written)" >&2
        restart_app_if_stopped
        exit 1
    fi
    # Not a refusal: rollback OR a lost COMMIT acknowledgement. Reconcile
    # under the SAME advisory lock — a still-running COMMIT holds it, so the
    # lookup waits for it (bounded by lock_timeout) and then reads a settled
    # state (Codex R2). If the lock cannot be taken, the outcome stays UNKNOWN.
    set +e
    FOUND="$("${PSQL}" --dbname="${DSN}" -X -A -t -v ON_ERROR_STOP=1 -v op="${OP_ID}" <<'SQL' | tail -1
SET lock_timeout = '60s';
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('pilot-1-env-purge'));
SELECT COUNT(*) FROM audit_records WHERE action = 'env.purge.executed' AND payload->>'operationId' = :'op';
COMMIT;
SQL
)"
    RSTATUS=$?
    set -e
    if [ "${RSTATUS}" -ne 0 ] || ! [[ "${FOUND}" =~ ^[0-9]+$ ]]; then
        echo "ERROR: outcome UNKNOWN — the purge transaction failed and its result could not be reconciled under the purge lock for operation ${OP_ID}:" >&2
        sed 's/^/    /' "${ERR}" >&2
        echo "       The app is left STOPPED. Inspect audit_records for payload->>'operationId' = '${OP_ID}'; if attested, run --finish-runtime --operation-id ${OP_ID}; otherwise re-run the purge." >&2
        exit 5
    fi
    if [ "${FOUND}" = "0" ]; then
        echo "ERROR: the purge transaction failed and was rolled back (verified under the purge lock: no attestation for operation ${OP_ID}) — no deletion:" >&2
        sed 's/^/    /' "${ERR}" >&2
        restart_app_if_stopped
        exit 3
    fi
    echo "WARNING: psql reported a failure but the attestation for operation ${OP_ID} is durable — the COMMIT acknowledgement was lost; continuing with re-seed and runtime steps." >&2
    RECONCILED=true
fi

# --- step H + I: re-seed, then runtime steps -----------------------------------
reseed
runtime_post_steps

if [ "${FORMAT}" = "json" ]; then
    printf '{"mode":"%s","incidentId":%s,"operationId":"%s","actor":"%s","actorTenantId":"%s","planDigest":"%s","classificationVersion":%s,"artifacts":%s,"reconciled":%s,"runtimeStepsSkipped":%s,"status":"purged","auditAction":"env.purge.executed"}\n' \
        "${MODE}" "$([ -n "${INCIDENT_ID}" ] && printf '"%s"' "${INCIDENT_ID}" || printf 'null')" "${OP_ID}" "${ACTOR}" "${ACTOR_TENANT}" "${DIGEST}" "${CLS_VERSION}" "${ARTIFACTS}" "${RECONCILED}" "$([ "${SKIP_RUNTIME}" = "1" ] && echo true || echo false)"
else
    echo "OK: Pilot 1 substrate purged (${MODE}${INCIDENT_ID:+ / incident ${INCIDENT_ID}}; operation ${OP_ID}), attested per tenant, re-seeded."
    [ "${SKIP_RUNTIME}" = "1" ] && echo "    Runtime steps skipped (PILOT_1_SKIP_RUNTIME_STEPS=1)."
    echo "    incident-logs untouched: ${INCIDENT_DIR}"
fi
exit 0
