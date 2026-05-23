#!/usr/bin/env bash
#
# check-migration-chain.sh — clean-room verification of the full migration chain.
#
# Applies every migrations/NNN_*.sql forward (000 -> head) against a pristine
# database, then unwinds every migrations/rollback/NNN_rollback.sql in reverse
# (head -> 000). Both directions run with `psql -v ON_ERROR_STOP=1`, so the
# FIRST failed statement aborts the run with a non-zero exit.
#
# Why this exists (Track 5 Infra & Ops):
#   - tests/setup.ts applies migrations as a side effect of the integration
#     suite, but it tracks applied files in `schema_migrations` and uses
#     advisory locks across forks — a clean-room sequential apply is a clearer,
#     fail-fast signal for a cross-migration defect (e.g. a wrapper referencing
#     a role a prior migration never created — the exact shape of the
#     2026-05-23 med-interaction role-name defect that reached main latently
#     because no env had ever applied 000 -> head from scratch).
#
# Scope: this gate verifies the FORWARD chain (000 -> head) on a pristine
# database, plus the per-migration rollback-companion existence rule. It does
# NOT execute a full reverse rollback unwind: rollback/003_rollback.sql is
# documented (in its own header) as dev/test-only and requires PHI-table RLS
# policies to be dropped first, because current_tenant_id() is shared between
# 002 (which creates audit_records + its RLS policy) and 003 (CREATE OR
# REPLACE). A naive head -> 000 unwind trips that documented precondition at
# 003. Hardening the reverse unwind is a separate Track 5 item; this gate
# closes the forward-apply gap that actually went uncaught.
#
# This is NOT a substitute for the integration suite (it does not seed tenants
# or run RLS assertions); it verifies that the forward DDL chain is internally
# consistent on a fresh database.
#
# Usage:
#   CHAIN_DATABASE_URL=postgres://user:pw@host:5432/db ./scripts/check-migration-chain.sh
#
# Requires: psql on PATH; the target database empty (no prior chain applied,
# because role objects are cluster-global and several CREATE ROLE statements are
# not guarded with IF NOT EXISTS — a fresh CI service container satisfies this).

set -euo pipefail

DSN="${CHAIN_DATABASE_URL:-${TEST_DATABASE_URL:-}}"
if [[ -z "${DSN}" ]]; then
  echo "ERROR: set CHAIN_DATABASE_URL (or TEST_DATABASE_URL) to a Postgres DSN." >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="${REPO_ROOT}/migrations"
ROLLBACK_DIR="${MIGRATIONS_DIR}/rollback"

# --single-transaction wraps each file in one BEGIN/COMMIT, mirroring how
# tests/setup.ts applies each migration. Several migrations use SET LOCAL /
# LOCK TABLE, which require an explicit transaction block (none use
# CREATE INDEX CONCURRENTLY or other non-transactional statements).
PSQL=(psql "${DSN}" --no-psqlrc --quiet --single-transaction -v ON_ERROR_STOP=1)

# Ordered list of forward migrations: NNN_*.sql directly under migrations/.
# `sort -V` orders 045 before 046 etc. regardless of zero-padding width.
mapfile -t FORWARD < <(find "${MIGRATIONS_DIR}" -maxdepth 1 -name '[0-9][0-9][0-9]_*.sql' | sort -V)

if [[ ${#FORWARD[@]} -eq 0 ]]; then
  echo "ERROR: no migration files matched migrations/NNN_*.sql" >&2
  exit 2
fi

# Rollback companions are named by the 3-digit prefix only:
# migrations/045_foo.sql  ->  migrations/rollback/045_rollback.sql
rollback_for() {
  local seq
  seq="$(basename "$1")"
  seq="${seq%%_*}"           # leading NNN
  printf '%s/%s_rollback.sql' "${ROLLBACK_DIR}" "${seq}"
}

# Discipline check: every forward migration MUST have a rollback companion
# (migrations/README.md "Every migration has a rollback companion").
missing=0
for f in "${FORWARD[@]}"; do
  rb="$(rollback_for "${f}")"
  if [[ ! -f "${rb}" ]]; then
    echo "ERROR: missing rollback companion for $(basename "${f}") (expected $(basename "${rb}"))" >&2
    missing=1
  fi
done
if [[ ${missing} -ne 0 ]]; then
  exit 1
fi

echo "==> Forward apply (000 -> head): ${#FORWARD[@]} migrations"
for f in "${FORWARD[@]}"; do
  echo "  apply $(basename "${f}")"
  "${PSQL[@]}" -f "${f}"
done
echo "==> Forward chain applied cleanly."

echo "OK: forward migration chain verified clean-room (${#FORWARD[@]} migrations, each with a rollback companion)."
