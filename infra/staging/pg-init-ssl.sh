#!/bin/bash
# pg-init-ssl.sh — runs once at first PG boot (docker-entrypoint-initdb.d).
#
# Generates a self-signed cert AND enables SSL via postgresql.conf. SSL must
# NOT be enabled via command-line flags in compose: the official entrypoint
# starts its TEMPORARY init server with the same flags, which fails before
# any initdb.d script can create the cert (chicken-and-egg). Writing the
# settings to postgresql.conf here means: temp init server runs without
# SSL (socket-only, unreachable from the network), final server boots with
# SSL on. node-postgres connects with rejectUnauthorized:false (see
# src/lib/db.ts), so the self-signed cert satisfies the production
# DATABASE_SSL_MODE=require encrypted-transport gate.
set -e
# postgres:16-alpine does not ship the openssl CLI — install it (initdb.d
# scripts run as root before the entrypoint steps down to postgres).
command -v openssl >/dev/null 2>&1 || apk add --no-cache openssl >/dev/null
CERT_DIR="${PGDATA:-/var/lib/postgresql/data}"
if [ ! -f "$CERT_DIR/server.crt" ]; then
  openssl req -new -x509 -days 3650 -nodes \
    -subj "/CN=telecheck-staging-db" \
    -out "$CERT_DIR/server.crt" -keyout "$CERT_DIR/server.key"
  chmod 600 "$CERT_DIR/server.key"
  chown postgres:postgres "$CERT_DIR/server.crt" "$CERT_DIR/server.key"
fi
if ! grep -q "^ssl = on" "$CERT_DIR/postgresql.conf"; then
  cat >> "$CERT_DIR/postgresql.conf" <<CONF
# --- staging TLS (pg-init-ssl.sh) ---
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
CONF
fi
