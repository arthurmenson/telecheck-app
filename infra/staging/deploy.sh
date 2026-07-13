#!/usr/bin/env bash
#
# deploy.sh — staging deploy: pull main, rebuild the app image, apply new
# migrations, restart. Run ON THE VPS from the repo root:
#
#   bash infra/staging/deploy.sh
#
# Safe to re-run; apply-migrations.sh is tracking-table idempotent.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
COMPOSE=(docker compose -f infra/staging/docker-compose.yml --env-file infra/staging/.env)

echo ">> git pull (main)"
git fetch origin main
git reset --hard origin/main

echo ">> PG TLS certs (host-side, idempotent)"
# Generated here — NOT in a docker-entrypoint-initdb.d script. See the db
# service comment in docker-compose.yml for the two failed prior designs
# (command-flag chicken-and-egg; alpine init scripts run non-root so
# apk/openssl are unavailable).
TLS_DIR="infra/staging/tls"
if [ ! -f "$TLS_DIR/server.crt" ]; then
  mkdir -p "$TLS_DIR"
  openssl req -new -x509 -days 3650 -nodes \
    -subj "/CN=telecheck-staging-db" \
    -out "$TLS_DIR/server.crt" -keyout "$TLS_DIR/server.key"
  # alpine postgres runs as uid/gid 70; the key must be 0600 and owned by
  # the server user or postgres refuses to load it. One-time sudo.
  sudo chown 70:70 "$TLS_DIR/server.crt" "$TLS_DIR/server.key"
  sudo chmod 600 "$TLS_DIR/server.key"
  sudo chmod 644 "$TLS_DIR/server.crt"
fi

echo ">> build + start stack"
"${COMPOSE[@]}" up -d --build

echo ">> wait for db healthy"
for i in $(seq 1 30); do
  state="$("${COMPOSE[@]}" ps --format json db 2>/dev/null | grep -o '"Health":"[a-z]*"' || true)"
  case "$state" in *healthy*) break ;; esac
  sleep 2
done

echo ">> apply migrations"
# run --rm (one-shot container), NOT exec into the app service: on a first
# deploy the app crash-loops by design until migrations + bind-role
# credentials exist (SI-010 fail-fast boot probe), and exec into a
# restarting container fails.
"${COMPOSE[@]}" run --rm --no-deps -T app bash scripts/apply-migrations.sh

echo ">> provision SI-010 bind-pool credentials (idempotent)"
# migration 031 creates bind_actor_context_role LOGIN without a password;
# the operator provisions credentials post-migration (031 header §Role).
# Extract ONLY the one value we need — do NOT `source` the whole .env: it is
# also a docker-compose env_file and legitimately holds values with spaces and
# shell metacharacters (e.g. EMAIL_FROM="Heros Health <no-reply@...>"), which
# `source` chokes on ("syntax error near unexpected token"). cut -f2- keeps
# everything after the first '=' so a value containing '=' survives.
BIND_ROLE_PASSWORD=$(grep -E '^BIND_ROLE_PASSWORD=' infra/staging/.env | head -1 | cut -d= -f2-)
"${COMPOSE[@]}" exec -T db psql -U "${POSTGRES_USER:-telecheck}" -d "${POSTGRES_DB:-telecheck}" -q -c \
  "ALTER ROLE bind_actor_context_role WITH LOGIN PASSWORD '${BIND_ROLE_PASSWORD}';"

echo ">> restart app (pick up schema)"
"${COMPOSE[@]}" restart app

echo ">> smoke"
sleep 3
"${COMPOSE[@]}" exec -T app node -e "fetch('http://localhost:3000/health').then(r=>r.text()).then(t=>{console.log('/health →', t)}).catch(e=>{console.error(e);process.exit(1)})" \
  || echo "NOTE: /health smoke failed — check 'docker compose logs app'"

echo "deploy complete."
