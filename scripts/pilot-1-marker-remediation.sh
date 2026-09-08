#!/usr/bin/env bash
#
# pilot-1-marker-remediation.sh — the ONLY authorized route for classifying
# an `unclassified` Pilot 1 account.
#
# Per docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md §Three-state cohort
# classification §Remediation contract and §Cohort-classification integrity
# §Remediation path:
#
#   scripts/pilot-1-marker-remediation.sh \
#       --account-id <ulid> --classify-as {participant|baseline} --reason "..."
#
#   - Classifies exactly ONE `unclassified` account, in ONE transaction, with
#     the audit event `pilot_1.cohort_classification{accountId, classifiedAs,
#     actor, reason}` inserted in the SAME transaction (I-003: the
#     classification cannot commit without its attestation, and vice versa).
#   - Refuses (exit 1) if the account does not exist or is already
#     classified: "Once classified, the account joins its class permanently.
#     Reclassification requires a separate audit-logged decision" — this
#     script deliberately has no reclassify mode.
#   - Never touches any other row; never touches /home/deploy/incident-logs/.
#
# Exit codes:
#   0  classified; audit event committed
#   1  refused — account not found, or not `unclassified` (nothing written)
#   2  usage / environment error (nothing written)
#   3  database error (transaction rolled back; nothing written)
#
# Environment:
#   PILOT_1_DATABASE_URL — operator DSN (defaults to $DATABASE_URL). Must be
#                          the cross-tenant operator role used by
#                          verify-pilot-1-baseline.sh (RLS is forced on
#                          accounts: the script binds the account's tenant
#                          via set_tenant_context before writing).
#   PILOT_1_PSQL         — psql binary (default: `psql` on PATH)
#   PILOT_1_ACTOR        — actor id recorded on the audit row
#                          (default: <user>@<hostname>)
#
# Options:
#   --account-id <id>     26-character Crockford ULID
#   --classify-as <c>     participant | baseline
#   --reason "<text>"     required, 1–500 characters; recorded verbatim on the
#                         audit row (do NOT put PII in it — it is durable)
#   --actor <id>          overrides PILOT_1_ACTOR
#   --json                machine-readable output
#
# Spec references:
#   - docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md §Remediation contract
#   - migrations/080_pilot_1_cohort_classification.sql (schema + column comment)
#   - migrations/002_audit_chain.sql / 029 / 030 (audit envelope, hash chain,
#     actor_tenant_id CHECK for human actors)
#   - scripts/verify-pilot-1-baseline.sh (the gate this script unblocks)

set -euo pipefail

DSN="${PILOT_1_DATABASE_URL:-${DATABASE_URL:-}}"
PSQL="${PILOT_1_PSQL:-psql}"
ACTOR="${PILOT_1_ACTOR:-}"
ACCOUNT_ID=""
CLASSIFY_AS=""
REASON=""
FORMAT="human"

usage() { sed -n '2,52p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        --account-id)   [ $# -ge 2 ] || { echo "ERROR: --account-id requires a value" >&2; exit 2; }; ACCOUNT_ID="$2"; shift 2 ;;
        --classify-as)  [ $# -ge 2 ] || { echo "ERROR: --classify-as requires a value" >&2; exit 2; }; CLASSIFY_AS="$2"; shift 2 ;;
        --reason)       [ $# -ge 2 ] || { echo "ERROR: --reason requires a value" >&2; exit 2; }; REASON="$2"; shift 2 ;;
        --actor)        [ $# -ge 2 ] || { echo "ERROR: --actor requires a value" >&2; exit 2; }; ACTOR="$2"; shift 2 ;;
        --json)         FORMAT="json"; shift ;;
        --help|-h)      usage; exit 0 ;;
        *)              echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
    esac
done

# --- argument validation (nothing is executed until every check passes) ---
if [ -z "${DSN}" ]; then
    echo "ERROR: PILOT_1_DATABASE_URL (or DATABASE_URL) is not set" >&2; exit 2
fi
if ! [[ "${ACCOUNT_ID}" =~ ^[0-9A-HJKMNP-TV-Z]{26}$ ]]; then
    echo "ERROR: --account-id must be a 26-character Crockford-base32 ULID (got '${ACCOUNT_ID}')" >&2; exit 2
fi
case "${CLASSIFY_AS}" in
    participant|baseline) ;;
    *) echo "ERROR: --classify-as must be 'participant' or 'baseline' (got '${CLASSIFY_AS}')" >&2; exit 2 ;;
esac
if [ -z "${REASON}" ] || [ "${#REASON}" -gt 500 ]; then
    echo "ERROR: --reason is required (1–500 characters)" >&2; exit 2
fi
if [ -z "${ACTOR}" ]; then
    ACTOR="$(id -un 2>/dev/null || echo operator)@$(hostname 2>/dev/null || echo unknown-host)"
fi

# --- step 1: read current state (cross-tenant operator read; no writes) ---
# A refusal is decided here on committed state; the transaction below
# re-checks under FOR UPDATE so a concurrent classification cannot race.
STATE="$("${PSQL}" "${DSN}" -X -A -t -v ON_ERROR_STOP=1 -v aid="${ACCOUNT_ID}" -c \
    "SELECT tenant_id || '|' || account_type || '|' || country_of_care || '|' || cohort_classification
       FROM accounts WHERE account_id = :'aid'")" || { echo "ERROR: could not read account state" >&2; exit 3; }

if [ -z "${STATE}" ]; then
    echo "REFUSED: account ${ACCOUNT_ID} not found (nothing written)" >&2; exit 1
fi
IFS='|' read -r TENANT_ID ACCOUNT_TYPE COUNTRY CURRENT <<< "${STATE}"
if [ "${CURRENT}" != "unclassified" ]; then
    echo "REFUSED: account ${ACCOUNT_ID} is already classified as '${CURRENT}'." >&2
    echo "         Reclassification requires a separate audit-logged decision; this script does not reclassify." >&2
    exit 1
fi

# --- step 2: ONE transaction — classify + attest, or nothing ---
# Values reach the DO block through transaction-local settings (psql does
# not interpolate :'var' inside dollar-quoted bodies).
ERR="$(mktemp)"
trap 'rm -f "${ERR}"' EXIT
set +e
"${PSQL}" "${DSN}" -X -q -v ON_ERROR_STOP=1 \
    -v aid="${ACCOUNT_ID}" -v cls="${CLASSIFY_AS}" -v reason="${REASON}" \
    -v actor="${ACTOR}" -v tenant="${TENANT_ID}" <<'SQL' 2>"${ERR}"
BEGIN;
SELECT set_tenant_context(:'tenant');
SELECT set_config('pilot1.account_id', :'aid',   true),
       set_config('pilot1.classify_as', :'cls',  true),
       set_config('pilot1.reason',      :'reason', true),
       set_config('pilot1.actor',       :'actor', true),
       set_config('pilot1.tenant',      :'tenant', true);
DO $$
DECLARE
    v_id      TEXT := current_setting('pilot1.account_id');
    v_cls     TEXT := current_setting('pilot1.classify_as');
    v_reason  TEXT := current_setting('pilot1.reason');
    v_actor   TEXT := current_setting('pilot1.actor');
    v_tenant  TEXT := current_setting('pilot1.tenant');
    v_row     RECORD;
    v_n       INTEGER;
BEGIN
    IF v_cls NOT IN ('participant', 'baseline') THEN
        RAISE EXCEPTION 'REMEDIATION_REFUSED: invalid classification %', v_cls;
    END IF;

    SELECT account_type, country_of_care, cohort_classification
      INTO v_row
      FROM accounts
     WHERE account_id = v_id AND tenant_id = v_tenant
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'REMEDIATION_REFUSED: account % not visible under tenant %', v_id, v_tenant;
    END IF;
    IF v_row.cohort_classification <> 'unclassified' THEN
        RAISE EXCEPTION 'REMEDIATION_REFUSED: account % is already classified as %', v_id, v_row.cohort_classification;
    END IF;

    UPDATE accounts
       SET cohort_classification = v_cls
     WHERE account_id = v_id AND tenant_id = v_tenant
       AND cohort_classification = 'unclassified';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'REMEDIATION_REFUSED: expected to classify exactly one row, affected %', v_n;
    END IF;

    -- Attestation in the SAME transaction (I-003 / I-027). Category B
    -- (governance decision by a human operator); actor_tenant_id is
    -- required for human actors by migration 030's CHECK; the patient
    -- partition is used for patient/delegate accounts, PLATFORM otherwise.
    INSERT INTO audit_records (
        tenant_id, category, audit_sensitivity_level, action,
        actor_type, actor_id, actor_tenant_id,
        target_patient_id, resource_type, resource_id, country_of_care,
        payload
    ) VALUES (
        v_tenant, 'B', 'standard', 'pilot_1.cohort_classification',
        'platform_admin', v_actor, v_tenant,
        CASE WHEN v_row.account_type IN ('patient', 'delegate') THEN v_id END,
        'account', v_id, v_row.country_of_care,
        jsonb_build_object(
            'accountId', v_id,
            'classifiedAs', v_cls,
            'actor', v_actor,
            'reason', v_reason,
            'previousClassification', 'unclassified',
            'accountType', v_row.account_type,
            'script', 'scripts/pilot-1-marker-remediation.sh'
        )
    );
END
$$;
COMMIT;
SQL
STATUS=$?
set -e

if [ "${STATUS}" -ne 0 ]; then
    if grep -q "REMEDIATION_REFUSED" "${ERR}"; then
        echo "REFUSED: $(grep -o 'REMEDIATION_REFUSED:[^"]*' "${ERR}" | head -1 | sed 's/REMEDIATION_REFUSED: //') (transaction rolled back; nothing written)" >&2
        exit 1
    fi
    echo "ERROR: classification transaction failed (rolled back; nothing written):" >&2
    sed 's/^/    /' "${ERR}" >&2
    exit 3
fi

if [ "${FORMAT}" = "json" ]; then
    printf '{"accountId":"%s","tenantId":"%s","accountType":"%s","classifiedAs":"%s","actor":"%s","status":"classified","auditAction":"pilot_1.cohort_classification"}\n' \
        "${ACCOUNT_ID}" "${TENANT_ID}" "${ACCOUNT_TYPE}" "${CLASSIFY_AS}" "${ACTOR}"
else
    echo "OK: account ${ACCOUNT_ID} (${ACCOUNT_TYPE}, ${TENANT_ID}) classified as '${CLASSIFY_AS}'."
    echo "    Audit event pilot_1.cohort_classification committed in the same transaction (actor: ${ACTOR})."
    echo "    Re-run scripts/verify-pilot-1-baseline.sh to confirm the gate is green."
fi
exit 0
