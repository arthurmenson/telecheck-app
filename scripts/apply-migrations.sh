#!/usr/bin/env bash
#
# apply-migrations.sh — idempotent forward migration apply with tracking.
#
# Unlike check-migration-chain.sh (clean-room CI gate: pristine DB, applies
# everything, then exits), this script is the OPERATIONAL apply path for
# staging/production: it records applied files in `schema_migrations` and
# applies only what's new, in filename order, each under ON_ERROR_STOP.
#
# Usage:
#   DATABASE_URL=postgres://user:pw@host:5432/db ./scripts/apply-migrations.sh
#
# Notes:
#   - Migration files are NOT wrapped in an outer transaction here; several
#     contain their own DO-block verification and a few operations
#     (CREATE ROLE etc.) are cluster-global. Each file runs with
#     ON_ERROR_STOP=1 so the first failed statement aborts the run and the
#     failing file is NOT recorded as applied.
#   - Re-running after a mid-file failure re-runs that file from the top;
#     migrations in this repo are written idempotent-or-guarded for that
#     reason (IF NOT EXISTS / OR REPLACE / DO-block existence checks).

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

MIGRATIONS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../migrations" && pwd)"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL

applied=0
skipped=0
for f in "$MIGRATIONS_DIR"/[0-9][0-9][0-9]_*.sql; do
  base="$(basename "$f")"
  already="$(psql "$DATABASE_URL" -tA -c "SELECT 1 FROM schema_migrations WHERE filename = '$base'")"
  if [ "$already" = "1" ]; then
    skipped=$((skipped + 1))
    continue
  fi
  echo ">> applying $base"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
    "INSERT INTO schema_migrations (filename) VALUES ('$base')"
  applied=$((applied + 1))
done

echo "apply-migrations: $applied applied, $skipped already-applied."
