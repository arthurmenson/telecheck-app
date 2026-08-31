#!/usr/bin/env bash
#
# verify-pilot-1-baseline.sh — Pilot 1 cohort-classification integrity gate.
#
# Runs at three enforcement surfaces per docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md
# §Cohort-classification integrity:
#
#   1. Pilot 1 Day-0 startup checklist item (blocks Day-0 authorization)
#   2. env-purge preflight (both --routine-reset and --incident-id modes)
#   3. Provisioning post-hook backstop (called from the participant-kit
#      generator + any account-creation code path)
#
# Contract:
#   Exit 0 → zero unclassified participant-type accounts; caller may proceed
#   Exit 1 → one or more unclassified accounts exist; offending IDs printed;
#            caller MUST NOT proceed with purge / Day-0 startup / provisioning
#            until scripts/pilot-1-marker-remediation.sh classifies each
#            offending account explicitly
#
# The query runs on the same Postgres DB that pilot-1-env-purge targets:
#   SELECT account_id, tenant_id, account_type, created_at
#   FROM accounts
#   WHERE cohort_classification = 'unclassified'
#   ORDER BY tenant_id, created_at;
#
# Environment:
#   PILOT_1_DATABASE_URL — Postgres DSN. Defaults to $DATABASE_URL if unset.
#   PILOT_1_PSQL         — psql binary path (defaults to `psql` on PATH).
#
# Usage (from repo root):
#   bash scripts/verify-pilot-1-baseline.sh              # human-readable
#   bash scripts/verify-pilot-1-baseline.sh --json       # machine-readable
#
# Spec references:
#   - docs/PATH_A_PILOT_COMPLETION_RUNBOOK.md §Pilot 1 startup authorization
#   - docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md §Cohort-classification integrity
#   - migrations/080_pilot_1_cohort_classification.sql (schema)

set -euo pipefail

DSN="${PILOT_1_DATABASE_URL:-${DATABASE_URL:-}}"
PSQL="${PILOT_1_PSQL:-psql}"
FORMAT="human"

while [ $# -gt 0 ]; do
    case "$1" in
        --json) FORMAT="json"; shift ;;
        --help|-h)
            sed -n '1,40p' "$0"
            exit 0
            ;;
        *)
            echo "unknown arg: $1" >&2
            exit 2
            ;;
    esac
done

if [ -z "${DSN}" ]; then
    echo "ERROR: PILOT_1_DATABASE_URL (or DATABASE_URL) is not set" >&2
    exit 2
fi

# Verify the column exists — protects against running this script against
# a database on which migration 080 has not yet been applied. Fail-closed
# so a purge preflight cannot accidentally proceed on a schema that
# lacks the classification column entirely.
COLUMN_EXISTS=$("${PSQL}" "${DSN}" -X -A -t -c \
    "SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name='accounts' AND column_name='cohort_classification'")
if [ "${COLUMN_EXISTS}" != "1" ]; then
    if [ "${FORMAT}" = "json" ]; then
        printf '{"error":"schema","message":"accounts.cohort_classification column not present; migration 080 not applied"}\n'
    else
        echo "ERROR: accounts.cohort_classification column not present" >&2
        echo "       Apply migration 080_pilot_1_cohort_classification.sql before running this gate" >&2
    fi
    exit 2
fi

# Run the integrity query — one row per unclassified account. LIMIT is
# generous (a real pilot-1 substrate should have zero rows here; the
# limit protects against runaway output on a badly-drifted DB).
UNCLASSIFIED_JSON=$("${PSQL}" "${DSN}" -X -A -t -c \
    "SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
        SELECT account_id, tenant_id, account_type,
               to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at_utc
        FROM accounts
        WHERE cohort_classification = 'unclassified'
        ORDER BY tenant_id, created_at
        LIMIT 1000
    ) t")

COUNT=$("${PSQL}" "${DSN}" -X -A -t -c \
    "SELECT COUNT(*) FROM accounts WHERE cohort_classification = 'unclassified'")

if [ "${FORMAT}" = "json" ]; then
    printf '{"unclassifiedCount":%s,"unclassifiedAccounts":%s}\n' \
        "${COUNT}" "${UNCLASSIFIED_JSON}"
else
    if [ "${COUNT}" = "0" ]; then
        echo "OK: 0 unclassified participant-type accounts."
        echo "    Cohort classification integrity verified against $(basename ${DSN%\?*})."
    else
        echo "FAIL: ${COUNT} unclassified account(s) found — Pilot 1 gate BLOCKS."
        echo "      Offending accounts (JSON):"
        echo "${UNCLASSIFIED_JSON}" | sed 's/^/        /'
        echo ""
        echo "Remediation: run scripts/pilot-1-marker-remediation.sh for each"
        echo "             account with --classify-as {participant|baseline}"
        echo "             and a documented --reason. Each invocation emits a"
        echo "             pilot_1.cohort_classification audit event."
    fi
fi

if [ "${COUNT}" = "0" ]; then
    exit 0
else
    exit 1
fi
