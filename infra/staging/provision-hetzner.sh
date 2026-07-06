#!/usr/bin/env bash
#
# provision-hetzner.sh — create + fully provision the staging VPS via the
# Hetzner Cloud API. Run from the repo root on the operator workstation:
#
#   HCLOUD_TOKEN=... bash infra/staging/provision-hetzner.sh
#
# What it does (idempotent-ish; re-running with an existing server aborts):
#   1. Generates a local SSH keypair (infra/staging/.keys/, gitignored) and
#      registers the public key with Hetzner.
#   2. Generates a read-only GitHub deploy key for this repo (via gh CLI)
#      so the VPS can clone it.
#   3. Generates all staging secrets into infra/staging/.env.provisioned
#      (kept local; ALSO injected onto the VPS at /home/deploy/...).
#   4. Creates a CX22 (Ubuntu 24.04) with cloud-init that installs Docker,
#      locks down ufw, clones the repo as the deploy user, writes .env, and
#      runs infra/staging/deploy.sh.
#   5. Waits for boot + prints the health URL (STAGING_DOMAIN defaults to
#      <ip>.sslip.io — zero-DNS TLS via Let's Encrypt; swap a real
#      subdomain later by editing .env on the VPS + re-running deploy.sh).
#
# Requirements: bash, curl, python3 or jq, ssh-keygen, gh (authenticated).

set -euo pipefail

: "${HCLOUD_TOKEN:?HCLOUD_TOKEN is required (Hetzner Cloud API token, project-scoped, read+write)}"

API="https://api.hetzner.cloud/v1"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
KEYS_DIR="$HERE/.keys"
SERVER_NAME="telecheck-staging"
GH_REPO="arthurmenson/telecheck-app"

hapi() { # method path [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$method" -H "Authorization: Bearer $HCLOUD_TOKEN" \
      -H "Content-Type: application/json" -d "$body" "$API$path"
  else
    curl -fsS -X "$method" -H "Authorization: Bearer $HCLOUD_TOKEN" "$API$path"
  fi
}

jget() { python3 -c "import sys, json; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

rand() { openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-"${1:-40}"; }

# ---------------------------------------------------------------------------
# 0 — abort if the server already exists
# ---------------------------------------------------------------------------
existing="$(hapi GET "/servers?name=$SERVER_NAME" | jget "len(d['servers'])")"
if [ "$existing" != "0" ]; then
  echo "Server '$SERVER_NAME' already exists — use deploy.sh on the VPS for updates," >&2
  echo "or delete it in the Hetzner console first for a clean re-provision." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1 — SSH keypair
# ---------------------------------------------------------------------------
mkdir -p "$KEYS_DIR"
if [ ! -f "$KEYS_DIR/staging_ed25519" ]; then
  ssh-keygen -t ed25519 -N "" -C "telecheck-staging" -f "$KEYS_DIR/staging_ed25519" -q
fi
PUB_KEY="$(cat "$KEYS_DIR/staging_ed25519.pub")"
# Register with Hetzner (ignore 'already exists' by name-checking first)
have_key="$(hapi GET "/ssh_keys?name=telecheck-staging" | jget "len(d['ssh_keys'])")"
if [ "$have_key" = "0" ]; then
  hapi POST /ssh_keys "{\"name\":\"telecheck-staging\",\"public_key\":\"$PUB_KEY\"}" >/dev/null
fi

# ---------------------------------------------------------------------------
# 2 — GitHub read-only deploy key for the VPS clone
# ---------------------------------------------------------------------------
if [ ! -f "$KEYS_DIR/deploy_ed25519" ]; then
  ssh-keygen -t ed25519 -N "" -C "telecheck-staging-deploy" -f "$KEYS_DIR/deploy_ed25519" -q
  gh repo deploy-key add "$KEYS_DIR/deploy_ed25519.pub" --repo "$GH_REPO" \
    --title "telecheck-staging (read-only)" || {
      echo "deploy-key add failed — add $KEYS_DIR/deploy_ed25519.pub manually as a read-only deploy key" >&2
      exit 1
    }
fi
DEPLOY_PRIV="$(cat "$KEYS_DIR/deploy_ed25519")"

# ---------------------------------------------------------------------------
# 3 — secrets
# ---------------------------------------------------------------------------
ENV_LOCAL="$HERE/.env.provisioned"
if [ ! -f "$ENV_LOCAL" ]; then
  cat > "$ENV_LOCAL" <<EOF
POSTGRES_DB=telecheck
POSTGRES_USER=telecheck
POSTGRES_PASSWORD=$(rand 40)
BIND_ROLE_PASSWORD=$(rand 40)
STAGING_DOMAIN=__IP__.sslip.io
ACME_EMAIL=info@cardinalfive.com
JWT_SIGNING_KEY=$(rand 48)
RESUME_TOKEN_SECRET=$(rand 48)
TENANT_KMS_LOCAL_DEV_KEY=$(rand 32)
AI_MODE2_ENABLED=false
EOF
fi

# ---------------------------------------------------------------------------
# 4 — cloud-init + server create
# ---------------------------------------------------------------------------
ENV_B64="$(base64 -w0 < "$ENV_LOCAL" 2>/dev/null || base64 < "$ENV_LOCAL" | tr -d '\n')"
KEY_B64="$(base64 -w0 < "$KEYS_DIR/deploy_ed25519" 2>/dev/null || base64 < "$KEYS_DIR/deploy_ed25519" | tr -d '\n')"

USER_DATA="$(cat <<EOF
#cloud-config
package_update: true
packages: [docker.io, docker-compose-v2, git, ufw]
users:
  - name: deploy
    groups: [docker]
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    ssh_authorized_keys:
      - $PUB_KEY
write_files:
  - path: /home/deploy/.ssh/github_deploy
    permissions: "0600"
    encoding: b64
    content: $KEY_B64
  - path: /home/deploy/env.staging
    permissions: "0600"
    encoding: b64
    content: $ENV_B64
runcmd:
  - ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
  - chown -R deploy:deploy /home/deploy
  - |
    sudo -u deploy bash -c '
      set -e
      cd /home/deploy
      export GIT_SSH_COMMAND="ssh -i /home/deploy/.ssh/github_deploy -o StrictHostKeyChecking=accept-new"
      git clone git@github.com:$GH_REPO.git telecheck-app
      cd telecheck-app
      IP=\$(curl -fsS http://169.254.169.254/hetzner/v1/metadata/public-ipv4 || hostname -I | awk "{print \\\$1}")
      sed "s/__IP__/\$IP/" /home/deploy/env.staging > infra/staging/.env
      echo "export GIT_SSH_COMMAND=\"ssh -i /home/deploy/.ssh/github_deploy -o StrictHostKeyChecking=accept-new\"" >> /home/deploy/.bashrc
      bash infra/staging/deploy.sh > /home/deploy/first-deploy.log 2>&1
    '
EOF
)"

BODY="$(python3 - "$USER_DATA" <<'PY'
import json, sys
print(json.dumps({
    "name": "telecheck-staging",
    "server_type": "cx22",
    "image": "ubuntu-24.04",
    "location": "ash",
    "ssh_keys": ["telecheck-staging"],
    "user_data": sys.argv[1],
}))
PY
)"

echo ">> creating server"
resp="$(hapi POST /servers "$BODY")"
IP="$(printf '%s' "$resp" | jget "d['server']['public_net']['ipv4']['ip']")"
echo ">> server created: $IP"
sed -i.bak "s/__IP__/$IP/" "$ENV_LOCAL" && rm -f "$ENV_LOCAL.bak"

echo ">> cloud-init will take ~5-10 minutes (docker install + image build + migrations)."
echo ">> then:  https://$IP.sslip.io/health"
echo ">> ssh:   ssh -i infra/staging/.keys/staging_ed25519 deploy@$IP"
echo ">> first-boot log on the VPS: /home/deploy/first-deploy.log"
