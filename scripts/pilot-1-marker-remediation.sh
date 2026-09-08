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
#   PILOT_1_DATABASE_URL  — operator DSN (defaults to $DATABASE_URL). Must be
#                           the cross-tenant operator role used by
#                           verify-pilot-1-baseline.sh (RLS is forced on
#                           accounts: the script binds the account's tenant
#                           via set_tenant_context before writing).
#   PILOT_1_PSQL          — psql binary (default: `psql` on PATH)
#   PILOT_1_ACTOR         — actor id recorded on the audit row
#                           (default: <user>@<hostname>; [A-Za-z0-9._@+-]{1,120})
#   PILOT_1_ACTOR_TENANT  — the OPERATOR's home tenant (audit_records.
#                           actor_tenant_id per migration 029 — the actor's
#                           tenant, NOT the target account's tenant, which
#                           may differ for a cross-tenant platform admin).
#                           Required unless --actor-tenant is given; must be
#                           an existing tenant id.
#
# Options:
#   --account-id <id>      26-character Crockford ULID
#   --classify-as <c>      participant | baseline
#   --reason "<text>"      required, 1–500 characters; recorded verbatim on
#                          the audit row (do NOT put PII in it — it is durable)
#   --actor <id>           overrides PILOT_1_ACTOR
#   --actor-tenant <id>    overrides PILOT_1_ACTOR_TENANT
#   --json                 machine-readable output
#
# Spec references:
#   - docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md §Remediation contract
#   - migrations/080_pilot_1_cohort_classification.sql (schema + column comment)
#   - migrations/002_audit_chain.sql / 029 / 030 (audit envelope, hash chain,
#     actor_tenant_id = actor's home tenant, CHECK for human actors)
#   - scripts/verify-pilot-1-baseline.sh (the gate this script unblocks)

set -euo pipefail

DSN="${PILOT_1_DATABASE_URL:-${DATABASE_URL:-}}"
PSQL="${PILOT_1_PSQL:-psql}"
ACTOR="${PILOT_1_ACTOR:-}"
ACTOR_TENANT="${PILOT_1_ACTOR_TENANT:-}"
ACCOUNT_ID=""
CLASSIFY_AS=""
REASON=""
FORMAT="human"

usage() { sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        --account-id)   [ $# -ge 2 ] || { echo "ERROR: --account-id requires a value" >&2; exit 2; }; ACCOUNT_ID="$2"; shift 2 ;;
        --classify-as)  [ $# -ge 2 ] || { echo "ERROR: --classify-as requires a value" >&2; exit 2; }; CLASSIFY_AS="$2"; shift 2 ;;
        --reason)       [ $# -ge 2 ] || { echo "ERROR: --reason requires a value" >&2; exit 2; }; REASON="$2"; shift 2 ;;
        --actor)        [ $# -ge 2 ] || { echo "ERROR: --actor requires a value" >&2; exit 2; }; ACTOR="$2"; shift 2 ;;
        --actor-tenant) [ $# -ge 2 ] || { echo "ERROR: --actor-tenant requires a value" >&2; exit 2; }; ACTOR_TENANT="$2"; shift 2 ;;
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
# The actor id is emitted verbatim in the --json output; a closed charset
# keeps that output valid JSON without an encoder on the host.
if ! [[ "${ACTOR}" =~ ^[A-Za-z0-9._@+-]{1,120}$ ]]; then
    echo "ERROR: actor id must match [A-Za-z0-9._@+-]{1,120} (got '${ACTOR}')" >&2; exit 2
fi
if [ -z "${ACTOR_TENANT}" ]; then
    echo "ERROR: the operator's home tenant is required — set PILOT_1_ACTOR_TENANT or pass --actor-tenant" >&2
    echo "       (audit_records.actor_tenant_id is the ACTOR's tenant per migration 029, not the target account's)" >&2
    exit 2
fi
if ! [[ "${ACTOR_TENANT}" =~ ^[A-Za-z0-9-]{1,64}$ ]]; then
    echo "ERROR: --actor-tenant must be a tenant id (got '${ACTOR_TENANT}')" >&2; exit 2
fi

# --- step 1: read current state (cross-tenant operator read; no writes) ---
# The SQL is supplied on stdin so psql interpolates :'aid' / :'actor_tenant'
# (variables are NOT interpolated inside -c commands — Codex R1).
# A refusal is decided here on committed state; the transaction below
# re-checks under FOR UPDATE so a concurrent classification cannot race.
STATE="$("${PSQL}" "${DSN}" -X -A -t -v ON_ERROR_STOP=1 \
    -v aid="${ACCOUNT_ID}" -v actor_tenant="${ACTOR_TENANT}" <<'SQL'
SELECT (SELECT CASE WHEN EXISTS (SELECT 1 FROM tenants WHERE id = :'actor_tenant') THEN 't' ELSE 'f' END)
       || '|' || (SELECT CASE WHEN rolsuper OR rolbypassrls THEN 't' ELSE 'f' END FROM pg_roles WHERE rolname = current_user)
       || '|' || COALESCE((SELECT a.tenant_id || '|' || a.account_type || '|' || a.country_of_care || '|' || a.cohort_classification || '|' || t.status
                           FROM accounts a JOIN tenants t ON t.id = a.tenant_id WHERE a.account_id = :'aid'), '');
SQL
)" || { echo "ERROR: could not read account state" >&2; exit 3; }

IFS='|' read -r ACTOR_TENANT_EXISTS OPERATOR_BYPASS TENANT_ID ACCOUNT_TYPE COUNTRY CURRENT TENANT_STATUS <<< "${STATE}"
if [ "${ACTOR_TENANT_EXISTS}" != "t" ]; then
    echo "ERROR: actor tenant '${ACTOR_TENANT}' does not exist (nothing written)" >&2; exit 2
fi
if [ -z "${TENANT_ID}" ]; then
    echo "REFUSED: account ${ACCOUNT_ID} not found (nothing written)" >&2; exit 1
fi
if [ "${CURRENT}" != "unclassified" ]; then
    echo "REFUSED: account ${ACCOUNT_ID} is already classified as '${CURRENT}'." >&2
    echo "         Reclassification requires a separate audit-logged decision; this script does not reclassify." >&2
    exit 1
fi
# A suspended / archived tenant cannot be bound via set_tenant_context
# (migration 003 requires status = 'active'), yet verify-pilot-1-baseline.sh
# counts its unclassified accounts. Remediation there runs WITHOUT binding a
# tenant context, relying on the operator role's RLS bypass, with explicit
# tenant predicates on every write and the tenant status on the audit row
# (Codex R9). Without bypass the gate cannot be cleared this way — refuse.
BIND_CONTEXT="t"
if [ "${TENANT_STATUS}" != "active" ]; then
    BIND_CONTEXT="f"
    if [ "${OPERATOR_BYPASS}" != "t" ]; then
        echo "REFUSED: account ${ACCOUNT_ID} belongs to tenant ${TENANT_ID} (status '${TENANT_STATUS}'); remediation there requires an operator role with BYPASSRLS / superuser (current role has neither), or reactivating the tenant (nothing written)" >&2
        exit 1
    fi
fi
# The ratified three-state model restricts `participant` to patients and
# delegates; a staff identity classified as participant would become eligible
# for the purge DELETE predicate (Codex R2). Decided here and re-checked
# under the row lock below.
if [ "${CLASSIFY_AS}" = "participant" ] && [ "${ACCOUNT_TYPE}" != "patient" ] && [ "${ACCOUNT_TYPE}" != "delegate" ]; then
    echo "REFUSED: account ${ACCOUNT_ID} is a ${ACCOUNT_TYPE}; only patient/delegate accounts can be classified as 'participant' (nothing written)" >&2
    exit 1
fi

# --- step 2: ONE transaction — classify + attest, or nothing ---
# Values reach the DO block through transaction-local settings (psql does
# not interpolate :'var' inside dollar-quoted bodies). Query output goes to
# /dev/null so nothing but the final line reaches stdout.
ERR="$(mktemp)"
trap 'rm -f "${ERR}"' EXIT
set +e
"${PSQL}" "${DSN}" -X -q -v ON_ERROR_STOP=1 \
    -v aid="${ACCOUNT_ID}" -v cls="${CLASSIFY_AS}" -v reason="${REASON}" \
    -v actor="${ACTOR}" -v actor_tenant="${ACTOR_TENANT}" -v tenant="${TENANT_ID}" \
    -v bind_context="${BIND_CONTEXT}" -v tenant_status="${TENANT_STATUS}" <<'SQL' >/dev/null 2>"${ERR}"
BEGIN;
-- Bind the tenant context only for an active tenant (a CASE evaluates only
-- the taken branch); an inactive tenant is written under RLS bypass with
-- explicit tenant predicates.
SELECT CASE WHEN :'bind_context' = 't' THEN set_tenant_context(:'tenant') END;
SELECT set_config('pilot1.account_id',    :'aid',           true),
       set_config('pilot1.classify_as',   :'cls',           true),
       set_config('pilot1.reason',        :'reason',        true),
       set_config('pilot1.actor',         :'actor',         true),
       set_config('pilot1.actor_tenant',  :'actor_tenant',  true),
       set_config('pilot1.tenant',        :'tenant',        true),
       set_config('pilot1.tenant_status', :'tenant_status', true),
       set_config('pilot1.bind_context',  :'bind_context',  true);
DO $$
DECLARE
    v_id           TEXT := current_setting('pilot1.account_id');
    v_cls          TEXT := current_setting('pilot1.classify_as');
    v_reason       TEXT := current_setting('pilot1.reason');
    v_actor        TEXT := current_setting('pilot1.actor');
    v_actor_tenant TEXT := current_setting('pilot1.actor_tenant');
    v_tenant       TEXT := current_setting('pilot1.tenant');
    v_tenant_status TEXT := current_setting('pilot1.tenant_status');
    v_bind         TEXT := current_setting('pilot1.bind_context');
    v_row          RECORD;
    v_n            INTEGER;
BEGIN
    -- Re-verify the tenant status under the lock of this transaction and,
    -- for an inactive tenant, that the role really bypasses RLS (otherwise
    -- the UPDATE below would silently affect zero rows and be refused).
    IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = v_tenant AND status = v_tenant_status) THEN
        RAISE EXCEPTION 'REMEDIATION_REFUSED: tenant % status changed since lookup', v_tenant;
    END IF;
    IF v_bind <> 't' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
        RAISE EXCEPTION 'REMEDIATION_REFUSED: tenant % is % and the current role cannot bypass RLS', v_tenant, v_tenant_status;
    END IF;
    IF v_cls NOT IN ('participant', 'baseline') THEN
        RAISE EXCEPTION 'REMEDIATION_REFUSED: invalid classification %', v_cls;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = v_actor_tenant) THEN
        RAISE EXCEPTION 'REMEDIATION_REFUSED: actor tenant % does not exist', v_actor_tenant;
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
    IF v_cls = 'participant' AND v_row.account_type NOT IN ('patient', 'delegate') THEN
        RAISE EXCEPTION 'REMEDIATION_REFUSED: account % is a %; only patient/delegate accounts can be participants', v_id, v_row.account_type;
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
    -- (governance decision by a human operator). actor_tenant_id is the
    -- OPERATOR's home tenant (migration 029), required non-null for human
    -- actors (migration 030); the row lives in the TARGET tenant's
    -- partition (tenant_id), patient partition for patient/delegate.
    INSERT INTO audit_records (
        tenant_id, category, audit_sensitivity_level, action,
        actor_type, actor_id, actor_tenant_id,
        target_patient_id, resource_type, resource_id, country_of_care,
        payload
    ) VALUES (
        v_tenant, 'B', 'standard', 'pilot_1.cohort_classification',
        'platform_admin', v_actor, v_actor_tenant,
        CASE WHEN v_row.account_type IN ('patient', 'delegate') THEN v_id END,
        'account', v_id, v_row.country_of_care,
        jsonb_build_object(
            'accountId', v_id,
            'classifiedAs', v_cls,
            'actor', v_actor,
            'actorTenantId', v_actor_tenant,
            'reason', v_reason,
            'previousClassification', 'unclassified',
            'accountType', v_row.account_type,
            'tenantStatus', v_tenant_status,
            'tenantContextBound', (v_bind = 't'),
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
    # Every value below is from a validated closed charset (ULID, tenant id,
    # account_type CHECK, classification enum, actor charset) — no escaping
    # is needed for the output to be valid JSON. The reason is deliberately
    # NOT echoed; it lives on the audit row.
    printf '{"accountId":"%s","tenantId":"%s","tenantStatus":"%s","accountType":"%s","classifiedAs":"%s","actor":"%s","actorTenantId":"%s","status":"classified","auditAction":"pilot_1.cohort_classification"}\n' \
        "${ACCOUNT_ID}" "${TENANT_ID}" "${TENANT_STATUS}" "${ACCOUNT_TYPE}" "${CLASSIFY_AS}" "${ACTOR}" "${ACTOR_TENANT}"
else
    echo "OK: account ${ACCOUNT_ID} (${ACCOUNT_TYPE}, ${TENANT_ID} [${TENANT_STATUS}]) classified as '${CLASSIFY_AS}'."
    echo "    Audit event pilot_1.cohort_classification committed in the same transaction (actor: ${ACTOR}, actor tenant: ${ACTOR_TENANT})."
    echo "    Re-run scripts/verify-pilot-1-baseline.sh to confirm the gate is green."
fi
exit 0
