#!/usr/bin/env bash
#
# staging-e2e-smoke.sh — authenticated end-to-end consult-flow smoke against
# the STAGING deployment. Run ON THE VPS from the repo root:
#
#   bash scripts/staging-e2e-smoke.sh
#
# Exercises the full Sprint 10 surface against Telecheck-US:
#   1. seed synthetic accounts (idempotent)
#   2. mint patient + clinician tokens (in-container, JWT_SIGNING_KEY)
#   3. POST /v1/async-consults                      (patient)   → consult_id
#   4. POST /v1/async-consults/:id/intake           (patient)   → submission_id
#   5. GET  /v1/async-consults/queue                (clinician) → sees consult
#   6. POST /v1/async-consults/:id/claim            (clinician) → claim_id
#   7. POST /v1/async-consults/:id/decision         (clinician) → decision_id
#   8. GET  /v1/async-consults/:id                  (patient)   → final state
#
# Synthetic KMS envelopes: staging accepts pre-encrypted envelopes; the
# smoke sends well-formed base64 dummy fields (app-side envelope encryption
# is a recorded hardening TODO from PR #230).

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

COMPOSE=(docker compose -f infra/staging/docker-compose.yml --env-file infra/staging/.env)
BASE="https://87.99.159.214.sslip.io"
PATIENT_ID="01JZZZ00000000000000000P01"

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

say "1. seed synthetic accounts"
"${COMPOSE[@]}" exec -T db psql -U telecheck -d telecheck -v ON_ERROR_STOP=1 -q \
  -f /dev/stdin < scripts/seed-staging-accounts.sql 2>&1 | tail -1 || {
  # psql file over stdin loses the relative path; fall back to app container copy
  "${COMPOSE[@]}" exec -T app bash -c "psql \"\$DATABASE_URL\" -v ON_ERROR_STOP=1 -q -f scripts/seed-staging-accounts.sql" 2>&1 | tail -1
}

say "2. mint tokens"
PT="$("${COMPOSE[@]}" exec -T app node scripts/mint-staging-token.mjs --role patient)"
CT="$("${COMPOSE[@]}" exec -T app node scripts/mint-staging-token.mjs --role clinician)"
[ -n "$PT" ] && [ -n "$CT" ] || fail "token minting"
echo "patient + clinician tokens minted"

say "3. initiate consult (patient)"
INIT_BODY=$(printf '{"consult_type":"general","initiation_source":"care_tab","consult_fee_cents":0,"currency":"USD","payment_provider":"mock_local_dev","payment_intent_id":"%s","expected_turnaround_at":"%s"}' \
  "$(ulid_now)" "$(date -u -d '+24 hours' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+24H +%Y-%m-%dT%H:%M:%SZ)")
RESP=$(curl -s -m 20 -X POST "$BASE/v1/async-consults" \
  -H "Authorization: Bearer $PT" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(ulid_now)" -d "$INIT_BODY")
echo "$RESP"
CONSULT_ID=$(echo "$RESP" | JQ consult_id)
[ -n "$CONSULT_ID" ] || fail "initiate — no consult_id in response"
echo "consult_id=$CONSULT_ID"

say "4. submit intake (patient)"
# Fixed template ULID from seed-staging-accounts.sql (composite FK target).
INTAKE_BODY=$(printf '{"template_id":"01JZZZ00000000000000TMPL01","template_version":"1","intake_payload_envelope":%s}' "$(envelope)")
RESP=$(curl -s -m 20 -X POST "$BASE/v1/async-consults/$CONSULT_ID/intake" \
  -H "Authorization: Bearer $PT" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(ulid_now)" -d "$INTAKE_BODY")
echo "$RESP"
SUBMISSION_ID=$(echo "$RESP" | JQ submission_id)
[ -n "$SUBMISSION_ID" ] || fail "intake — no submission_id"

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

say "E2E SMOKE PASSED — consult $CONSULT_ID: initiate → intake → queue → claim → decision complete"
