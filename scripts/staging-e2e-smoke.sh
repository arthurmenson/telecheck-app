#!/usr/bin/env bash
#
# staging-e2e-smoke.sh — authenticated end-to-end consult-flow smoke against
# the STAGING deployment. Run ON THE VPS from the repo root:
#
#   bash scripts/staging-e2e-smoke.sh                             # Telecheck-US (default)
#   bash scripts/staging-e2e-smoke.sh --tenant Telecheck-Ghana    # Telecheck-Ghana
#
# The default (no-arg) invocation is the standing deploy gate and is
# behavior-identical to the pre-parameterization script: same host, same
# identities, same 9 steps against Telecheck-US.
#
# --tenant Telecheck-Ghana runs the SAME pilot loop on the second operating
# tenant (host ghana.87.99.159.214.sslip.io → Telecheck-Ghana via
# TENANT_HOST_OVERRIDES in infra/staging/.env), using the Ghana synthetic
# identities from scripts/seed-staging-accounts.sql, then appends a
# cross-tenant negative assertion (step 9): a Telecheck-US patient token
# requesting the Ghana consult must get a tenant-blind 404 (I-023 / I-025
# on live infra).
#
# Steps (per tenant):
#   1. seed synthetic accounts (idempotent; seeds BOTH tenants)
#   2. mint patient + clinician tokens (in-container, JWT_SIGNING_KEY)
#   3. POST /v1/async-consults                      (patient)    → consult_id
#   4. POST /v1/async-consults/:id/intake           (patient)    → submission_id
#  4.5. POST /v1/async-consults/:id/ai-preparation  (ai_service) → summary_id
#   5. GET  /v1/async-consults/queue                (clinician)  → sees consult
#   6. POST /v1/async-consults/:id/claim            (clinician) → claim_id
#   7. POST /v1/async-consults/:id/decision         (clinician) → decision_id
#   8. GET  /v1/async-consults/:id                  (patient)   → final state
#   9. cross-tenant tenant-blind 404 (Ghana run only; US patient token
#      vs Ghana consult → 404 internal.resource.not_found, no leak)
#
# Synthetic KMS envelopes: staging accepts pre-encrypted envelopes; the
# smoke sends well-formed base64 dummy fields (app-side envelope encryption
# is a recorded hardening TODO from PR #230).

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

usage() {
  echo "usage: bash scripts/staging-e2e-smoke.sh [--tenant Telecheck-US|Telecheck-Ghana]" >&2
  exit 2
}

TENANT="Telecheck-US"
while [ $# -gt 0 ]; do
  case "$1" in
    --tenant)
      [ $# -ge 2 ] || usage
      TENANT="$2"
      shift 2
      ;;
    -h | --help)
      usage
      ;;
    *)
      usage
      ;;
  esac
done

# Staging host of the US tenant — also the cross-tenant probe origin for
# the Ghana run's step 9 (a US-tenant token belongs on the US host; the
# isolation being proven is row-level, not host-level).
US_BASE="https://87.99.159.214.sslip.io"

# Per-tenant parameters. Identities are the fixed synthetic ULIDs from
# scripts/seed-staging-accounts.sql; hosts resolve to the operating tenant
# via TENANT_HOST_OVERRIDES (staging) — see src/lib/tenant-context.ts.
case "$TENANT" in
  Telecheck-US)
    BASE="$US_BASE"
    COUNTRY="US"
    CURRENCY="USD"
    PATIENT_ID="01JZZZ00000000000000000P01"
    CLINICIAN_ID="01JZZZ00000000000000000C01"
    TEMPLATE_ID="01JZZZ0000000000000000TP01"
    ;;
  Telecheck-Ghana)
    BASE="https://ghana.87.99.159.214.sslip.io"
    COUNTRY="GH"
    CURRENCY="GHS"
    PATIENT_ID="01JZZZ00000000000000000P02"
    CLINICIAN_ID="01JZZZ00000000000000000C02"
    TEMPLATE_ID="01JZZZ0000000000000000TP02"
    ;;
  *)
    echo "unknown tenant '$TENANT' — expected Telecheck-US or Telecheck-Ghana" >&2
    exit 2
    ;;
esac

COMPOSE=(docker compose -f infra/staging/docker-compose.yml --env-file infra/staging/.env)

say()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
fail() { printf '\033[31mSMOKE FAILED: %s\033[0m\n' "$*"; exit 1; }

# jq via the app container (host may not have it)
JQ() { "${COMPOSE[@]}" exec -T app node -e "
  let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
    const j=JSON.parse(d); const path='$1'.split('.').filter(Boolean);
    let v=j; for(const p of path) v=v?.[p];
    process.stdout.write(v===undefined?'':String(v));
  })"; }

ulid_now() { "${COMPOSE[@]}" exec -T app node -e "import('ulid').then(m=>process.stdout.write(m.ulid()))"; }

envelope() {
  local DEK; DEK="$(ulid_now)"
  printf '{"ciphertext_b64":"c3ludGhldGljLXN0YWdpbmctY2lwaGVydGV4dA==","dek_id":"%s","iv_b64":"c3ludGhldGljLWl2LTEyMzQ=","tag_b64":"c3ludGhldGljLXRhZy0xMjM0NTY=","alg":"AES-256-GCM","alg_version":"1","aad_b64":"c3ludGhldGljLWFhZA==","encrypted_at":"%s"}' \
    "$DEK" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

say "smoke target: $TENANT ($BASE, country_of_care=$COUNTRY)"

say "1. seed synthetic accounts"
"${COMPOSE[@]}" exec -T db psql -U telecheck -d telecheck -v ON_ERROR_STOP=1 -q \
  -f /dev/stdin < scripts/seed-staging-accounts.sql 2>&1 | tail -1 || {
  # psql file over stdin loses the relative path; fall back to app container copy
  "${COMPOSE[@]}" exec -T app bash -c "psql \"\$DATABASE_URL\" -v ON_ERROR_STOP=1 -q -f scripts/seed-staging-accounts.sql" 2>&1 | tail -1
}

say "2. mint tokens ($TENANT)"
PT="$("${COMPOSE[@]}" exec -T app node scripts/mint-staging-token.mjs --role patient --account "$PATIENT_ID" --tenant "$TENANT" --country "$COUNTRY")"
CT="$("${COMPOSE[@]}" exec -T app node scripts/mint-staging-token.mjs --role clinician --account "$CLINICIAN_ID" --tenant "$TENANT" --country "$COUNTRY")"
[ -n "$PT" ] && [ -n "$CT" ] || fail "token minting"
echo "patient + clinician tokens minted"

say "3. initiate consult (patient)"
INIT_BODY=$(printf '{"consult_type":"general","initiation_source":"care_tab","consult_fee_cents":0,"currency":"%s","payment_provider":"mock_local_dev","payment_intent_id":"%s","expected_turnaround_at":"%s"}' \
  "$CURRENCY" "$(ulid_now)" "$(date -u -d '+24 hours' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+24H +%Y-%m-%dT%H:%M:%SZ)")
RESP=$(curl -s -m 20 -X POST "$BASE/v1/async-consults" \
  -H "Authorization: Bearer $PT" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(ulid_now)" -d "$INIT_BODY")
echo "$RESP"
CONSULT_ID=$(echo "$RESP" | JQ consult_id)
[ -n "$CONSULT_ID" ] || fail "initiate — no consult_id in response"
echo "consult_id=$CONSULT_ID"

say "4. submit intake (patient)"
# Fixed per-tenant template ULID from seed-staging-accounts.sql (composite
# FK (tenant_id, template_id) → forms_template needs a per-tenant target).
INTAKE_BODY=$(printf '{"template_id":"%s","template_version":"1","intake_payload_envelope":%s}' \
  "$TEMPLATE_ID" "$(envelope)")
RESP=$(curl -s -m 20 -X POST "$BASE/v1/async-consults/$CONSULT_ID/intake" \
  -H "Authorization: Bearer $PT" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(ulid_now)" -d "$INTAKE_BODY")
echo "$RESP"
SUBMISSION_ID=$(echo "$RESP" | JQ submission_id)
[ -n "$SUBMISSION_ID" ] || fail "intake — no submission_id"

say "4.5 AI preparation (ai_service) — REAL endpoint (migration 064 + P-038 endpoint #4)"
# The former raw-SQL stand-in is retired: the consult now advances
# submitted → processing → queued through the ratified path —
# POST /v1/async-consults/:id/ai-preparation under an ai_service-role
# token → withDbRole(ai_service_account) → SECDEF wrapper
# record_consult_ai_preparation_completed → raw lifecycle writer, with
# Cat C ai_preparation_started/_completed audits in the same tx.
# The clinical summary envelope is synthetic (same pre-encrypted-KMS
# posture as intake; app-side encryption is the recorded hardening TODO).
AIT="$("${COMPOSE[@]}" exec -T app node scripts/mint-staging-token.mjs --role ai_service --tenant "$TENANT" --country "$COUNTRY")"
[ -n "$AIT" ] || fail "ai_service token minting"
PREP_BODY=$(printf '{"patient_id":"%s","prepared_by_mode":"mode_1","ai_provider":"null_local_dev","model_id":"null-provider:staging-smoke","summary_envelope":%s,"interaction_signals_snapshot":{},"recommendation":"recommend"}' \
  "$PATIENT_ID" "$(envelope)")
RESP=$(curl -s -m 20 -X POST "$BASE/v1/async-consults/$CONSULT_ID/ai-preparation" \
  -H "Authorization: Bearer $AIT" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(ulid_now)" -d "$PREP_BODY")
echo "$RESP"
SUMMARY_ID=$(echo "$RESP" | JQ summary_id)
[ -n "$SUMMARY_ID" ] || fail "ai-preparation — no summary_id"
echo "consult advanced to queued (summary_id=$SUMMARY_ID)"

say "5. clinician queue"
RESP=$(curl -s -m 20 "$BASE/v1/async-consults/queue?limit=50" -H "Authorization: Bearer $CT")
echo "$RESP" | head -c 500; echo
echo "$RESP" | grep -q "$CONSULT_ID" || fail "queue does not list $CONSULT_ID"

say "6. claim (clinician)"
RESP=$(curl -s -m 20 -X POST "$BASE/v1/async-consults/$CONSULT_ID/claim" \
  -H "Authorization: Bearer $CT" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(ulid_now)" -d '{}')
echo "$RESP"
CLAIM_ID=$(echo "$RESP" | JQ claim_id)
[ -n "$CLAIM_ID" ] || fail "claim — no claim_id"

say "7. record decision (clinician, recommend)"
DEC_BODY=$(printf '{"claim_id":"%s","patient_id":"%s","decision_type":"recommend","agreement_with_ai_recommendation":"no_ai_recommendation","decision_rationale_envelope":%s,"interaction_signals_reviewed_ids":[]}' \
  "$CLAIM_ID" "$PATIENT_ID" "$(envelope)")
RESP=$(curl -s -m 20 -X POST "$BASE/v1/async-consults/$CONSULT_ID/decision" \
  -H "Authorization: Bearer $CT" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(ulid_now)" -d "$DEC_BODY")
echo "$RESP"
DECISION_ID=$(echo "$RESP" | JQ decision_id)
[ -n "$DECISION_ID" ] || fail "decision — no decision_id"

say "8. patient view of final state"
curl -s -m 20 "$BASE/v1/async-consults/$CONSULT_ID" -H "Authorization: Bearer $PT" | head -c 600; echo

if [ "$TENANT" = "Telecheck-Ghana" ]; then
  say "9. cross-tenant negative assertion — US patient token vs Ghana consult (I-023 / I-025)"
  # A Telecheck-US patient token on the US host requests the Ghana-tenant
  # consult by ID. RLS + app-layer tenant filtering must yield ZERO rows,
  # and the error envelope must be tenant-blind (I-025): identical
  # 404 internal.resource.not_found whether the consult is absent or
  # exists in another tenant — no cross-tenant existence leak.
  # (The probe goes via the US host because tokens are host/tenant-bound:
  # a US token on the Ghana host is rejected earlier as a cross-tenant
  # token-forge attempt, which would not exercise the row-level assertion.)
  USPT="$("${COMPOSE[@]}" exec -T app node scripts/mint-staging-token.mjs --role patient --account 01JZZZ00000000000000000P01 --tenant Telecheck-US --country US)"
  [ -n "$USPT" ] || fail "cross-tenant probe — US patient token minting"
  XT_STATUS=$(curl -s -m 20 -o /tmp/smoke-xt-body.json -w '%{http_code}' \
    "$US_BASE/v1/async-consults/$CONSULT_ID" -H "Authorization: Bearer $USPT")
  XT_BODY=$(cat /tmp/smoke-xt-body.json); rm -f /tmp/smoke-xt-body.json
  echo "HTTP $XT_STATUS $XT_BODY"
  [ "$XT_STATUS" = "404" ] || fail "cross-tenant probe — expected HTTP 404, got $XT_STATUS"
  XT_CODE=$(echo "$XT_BODY" | JQ error.code)
  [ "$XT_CODE" = "internal.resource.not_found" ] || fail "cross-tenant probe — expected tenant-blind error code internal.resource.not_found, got '$XT_CODE'"
  # Leak check: the tenant-blind envelope must not echo consult state or
  # any Ghana-tenant identifier back to the US principal.
  case "$XT_BODY" in
    *Telecheck-Ghana* | *consult_state* | *"$SUBMISSION_ID"* | *"$SUMMARY_ID"*)
      fail "cross-tenant probe — 404 body leaks cross-tenant data: $XT_BODY"
      ;;
  esac
  echo "tenant-blind 404 confirmed — no cross-tenant existence leak"
  XT_SUFFIX=" + cross-tenant 404 verified"
else
  XT_SUFFIX=""
fi

say "E2E SMOKE PASSED [$TENANT] — consult $CONSULT_ID: initiate → intake → queue → claim → decision complete$XT_SUFFIX"
