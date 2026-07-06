#!/bin/bash
# pg-init-ssl.sh — runs once at first PG boot (docker-entrypoint-initdb.d).
# Generates a self-signed cert so the app can connect with
# DATABASE_SSL_MODE=require (node-postgres uses rejectUnauthorized:false —
# see src/lib/db.ts — so a self-signed cert satisfies the production
# encrypted-transport gate on the compose-internal network).
set -e
CERT_DIR="${PGDATA:-/var/lib/postgresql/data}"
if [ ! -f "$CERT_DIR/server.crt" ]; then
  openssl req -new -x509 -days 3650 -nodes \
    -subj "/CN=telecheck-staging-db" \
    -out "$CERT_DIR/server.crt" -keyout "$CERT_DIR/server.key"
  chmod 600 "$CERT_DIR/server.key"
  chown postgres:postgres "$CERT_DIR/server.crt" "$CERT_DIR/server.key"
fi
