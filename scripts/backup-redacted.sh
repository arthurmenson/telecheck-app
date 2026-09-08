#!/usr/bin/env bash
# backup-redacted.sh — Layer 5 backup redaction wrapper (Sprint 1.2c).
#
#   scripts/backup-redacted.sh <out-dir> [safe pg_dump args...]
#
# pg_dump (plain UTF-8 to stdout, forced) | pii-scrub (dump-aware, whole
# regex library, fail closed) | age (public-key encryption to
# AGE_RECIPIENTS_FILE). Nothing unredacted and nothing unencrypted is ever
# written to <out-dir>; the sanitized-but-unencrypted bytes exist only inside
# the pipe. Structural verification before publication: non-empty dump,
# artifact non-empty, canonical age header, ciphertext >= plaintext bytes.
# Artifact and manifest are staged and published together; a failure at any
# point — including after publication started — removes this run's files.
#
# pg_dump options that would bypass the pipe are REJECTED before execution:
# -f/--file (writes raw to disk), -F/--format other than plain, -Z/--compress,
# -j/--jobs (directory format). Format and encoding are forced.
#
# Env:
#   BACKUP_DATABASE_URL   (required) DSN pg_dump reads; use a read-only role
#   AGE_RECIPIENTS_FILE   (default /home/deploy/.age-recipients)
#   PG_DUMP_BIN, AGE_BIN  (defaults pg_dump, age) — overridable for tests
#   PII_SCRUB_MAX_LINE_BYTES (default 67108864)
#   BACKUP_REDACTED_FAIL_AFTER_PUBLISH  test hook: abort after the artifact
#                         is published (simulates a manifest-write failure)
set -euo pipefail

OUT_DIR="${1:-}"; shift || true
[ -n "$OUT_DIR" ] || { echo "usage: $0 <out-dir> [pg_dump args...]" >&2; exit 2; }
: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is required}"
AGE_RECIPIENTS_FILE="${AGE_RECIPIENTS_FILE:-/home/deploy/.age-recipients}"
PG_DUMP_BIN="${PG_DUMP_BIN:-pg_dump}"
AGE_BIN="${AGE_BIN:-age}"
MAX_LINE="${PII_SCRUB_MAX_LINE_BYTES:-67108864}"

# pg_dump options: explicit ALLOWLIST, parsed token by token. Bundled short
# options (-vf/path, -vFc, -vZ9) are refused outright — PostgreSQL parses
# bundles, so a prefix check is not a guard. Everything that redirects
# output, changes format/compression/encoding, or changes data serialisation
# (INSERT forms are not type-aware-screened) is refused before execution.
ALLOWED_LONG='^--(data-only|schema-only|no-comments|no-publications|no-subscriptions|no-security-labels|no-tablespaces|no-unlogged-table-data|no-sync|strict-names|if-exists|clean|create|serializable-deferrable|verbose|table|exclude-table|exclude-table-data|schema|exclude-schema|extension|lock-wait-timeout|snapshot)(=.*)?$'
ALLOWED_SHORT='^-(a|s|c|C|v|t|T|n|N|e)$'
prev_takes_value=0
for arg in "$@"; do
  if [ "$prev_takes_value" = "1" ]; then prev_takes_value=0; continue; fi
  case "$arg" in
    --inserts|--column-inserts|--attribute-inserts|--rows-per-insert|--rows-per-insert=*)
      echo "backup-redacted: refusing '$arg' — INSERT-serialised values are not type-aware-screened" >&2; exit 2 ;;
  esac
  if [[ "$arg" == --* ]]; then
    [[ "$arg" =~ $ALLOWED_LONG ]] || { echo "backup-redacted: refusing '$arg' — not on the allowlist" >&2; exit 2; }
    case "$arg" in --table|--exclude-table|--exclude-table-data|--schema|--exclude-schema|--extension|--lock-wait-timeout|--snapshot) prev_takes_value=1 ;; esac
    continue
  fi
  if [[ "$arg" == -* ]]; then
    [[ "$arg" =~ $ALLOWED_SHORT ]] || { echo "backup-redacted: refusing '$arg' — bundled or unlisted short option" >&2; exit 2; }
    case "$arg" in -t|-T|-n|-N|-e) prev_takes_value=1 ;; esac
    continue
  fi
  echo "backup-redacted: refusing positional argument '$arg' — the DSN comes from BACKUP_DATABASE_URL" >&2; exit 2
done

[ -r "$AGE_RECIPIENTS_FILE" ] || { echo "backup-redacted: recipients file not readable: $AGE_RECIPIENTS_FILE" >&2; exit 2; }
command -v "$AGE_BIN" >/dev/null 2>&1 || { echo "backup-redacted: age binary not found ($AGE_BIN)" >&2; exit 2; }
command -v "$PG_DUMP_BIN" >/dev/null 2>&1 || { echo "backup-redacted: pg_dump binary not found ($PG_DUMP_BIN)" >&2; exit 2; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
TMP="$(mktemp -d)"
ARTIFACT="$TMP/db.sql.age"
MANIFEST="$TMP/db.manifest.json"
PLAIN_BYTES_FILE="$TMP/plain.bytes"
FINAL_ARTIFACT="$OUT_DIR/$STAMP-db.sql.age"
FINAL_MANIFEST="$OUT_DIR/$STAMP-db.manifest.json"
FINALIZED=0
cleanup() {
  rm -rf "$TMP"
  if [ "$FINALIZED" != "1" ]; then
    rm -f "$FINAL_ARTIFACT" "$FINAL_MANIFEST"
  fi
}
trap cleanup EXIT

set +e
"$PG_DUMP_BIN" --format=plain --encoding=UTF8 --no-owner --no-privileges "$@" "$BACKUP_DATABASE_URL" \
  | node --import tsx "$HERE/pii-scrub.mjs" --mode backup --max-line-bytes "$MAX_LINE" \
  | tee >(wc -c | tr -d ' ' > "$PLAIN_BYTES_FILE") \
  | "$AGE_BIN" -R "$AGE_RECIPIENTS_FILE" > "$ARTIFACT"
STATUS=("${PIPESTATUS[@]}")
set -e
# The byte counter runs in a process substitution; bounded wait for its flush.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -s "$PLAIN_BYTES_FILE" ] && break
  sleep 0.1
done
for i in 0 1 2 3; do
  if [ "${STATUS[$i]}" != "0" ]; then
    echo "backup-redacted: stage $i failed (exit ${STATUS[$i]}) — no artifact written" >&2
    exit 1
  fi
done

PLAIN_BYTES="$(cat "$PLAIN_BYTES_FILE" 2>/dev/null || echo 0)"
[ "$PLAIN_BYTES" -gt 0 ] 2>/dev/null || { echo "backup-redacted: empty dump — refusing to publish" >&2; exit 1; }
CIPHER_BYTES="$(wc -c < "$ARTIFACT" | tr -d ' ')"
[ "$CIPHER_BYTES" -gt 0 ] || { echo "backup-redacted: empty artifact" >&2; exit 1; }
HEADER="$(head -c 21 "$ARTIFACT")"
[ "$HEADER" = "age-encryption.org/v1" ] || { echo "backup-redacted: artifact lacks the age header" >&2; exit 1; }
[ "$CIPHER_BYTES" -ge "$PLAIN_BYTES" ] || { echo "backup-redacted: ciphertext smaller than plaintext" >&2; exit 1; }

# JSON-escape embedded strings (backslashes, then quotes) with parameter
# expansion — valid on every platform the wrapper runs on.
json_escape() {
  local v="$1"
  v="${v//\\/\\\\}"
  v="${v//\"/\\\"}"
  printf '%s' "$v"
}
ARTIFACT_NAME="$(json_escape "$(basename "$FINAL_ARTIFACT")")"
RECIPIENTS_JSON="$(json_escape "$AGE_RECIPIENTS_FILE")"
cat > "$MANIFEST" <<JSON
{"artifact":"$ARTIFACT_NAME","createdAt":"$STAMP","plaintextBytes":$PLAIN_BYTES,"ciphertextBytes":$CIPHER_BYTES,"redaction":"layer5-dump-aware-whole-library","encryption":"age","recipientsFile":"$RECIPIENTS_JSON"}
JSON
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$MANIFEST" \
  || { echo "backup-redacted: manifest is not valid JSON" >&2; exit 1; }

# Publish: artifact first, then manifest; cleanup removes both unless finalized.
mkdir -p "$OUT_DIR"
mv "$ARTIFACT" "$FINAL_ARTIFACT"
if [ "${BACKUP_REDACTED_FAIL_AFTER_PUBLISH:-}" = "1" ]; then
  echo "backup-redacted: simulated failure after publishing the artifact" >&2
  exit 7
fi
mv "$MANIFEST" "$FINAL_MANIFEST"
FINALIZED=1
echo "backup-redacted: wrote $FINAL_ARTIFACT ($CIPHER_BYTES bytes; plaintext $PLAIN_BYTES bytes)" >&2
