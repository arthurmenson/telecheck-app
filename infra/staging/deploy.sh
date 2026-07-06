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

echo ">> build + start stack"
"${COMPOSE[@]}" up -d --build

echo ">> wait for db healthy"
for i in $(seq 1 30); do
  state="$("${COMPOSE[@]}" ps --format json db 2>/dev/null | grep -o '"Health":"[a-z]*"' || true)"
  case "$state" in *healthy*) break ;; esac
  sleep 2
done

echo ">> apply migrations"
"${COMPOSE[@]}" exec -T app bash scripts/apply-migrations.sh

echo ">> restart app (pick up schema)"
"${COMPOSE[@]}" restart app

echo ">> smoke"
sleep 3
"${COMPOSE[@]}" exec -T app node -e "fetch('http://localhost:3000/health').then(r=>r.text()).then(t=>{console.log('/health →', t)}).catch(e=>{console.error(e);process.exit(1)})" \
  || echo "NOTE: /health smoke failed — check 'docker compose logs app'"

echo "deploy complete."
