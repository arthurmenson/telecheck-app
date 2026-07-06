# Telecheck staging environment — provisioning runbook

**Purpose:** a cheap, always-on, internet-reachable test environment for the
full Telecheck stack (Fastify app + PostgreSQL 16 RLS + Redis + TLS) so
end-to-end testing, the mobile/console apps, and pilot rehearsal happen
**before any AWS spend**. The AWS build-out (F4_DEPLOY_RUNBOOK, ADR-026
us-east-1 + us-west-2) starts at pre-go-live; this environment de-risks it.

## Recommendation (decision record, 2026-07-06)

**Primary: Hetzner Cloud CX22 VPS** (2 vCPU / 4 GB / 40 GB NVMe, ~€4.60/mo
≈ $5/mo, Falkenstein or Ashburn region) running this directory's Docker
Compose stack.

**Alternative if you prefer US billing/console: DigitalOcean Basic Droplet**
(2 GB / 1 vCPU, $12/mo for the 4 GB tier) — identical runbook, marginally
pricier.

**Why a plain VPS and not a managed free tier:**

1. **The migration chain needs real PostgreSQL ownership.** 000→059 creates
   ~40 `NOLOGIN NOBYPASSRLS` roles, `SECURITY DEFINER` functions with owner
   pinning, `FORCE ROW LEVEL SECURITY`, and BYPASSRLS preflight checks.
   Managed free tiers (Supabase, Neon, RDS free) restrict role/superuser
   surface in ways that break exactly this class of DDL — the whole point
   of staging is to exercise it.
2. **Container parity with production.** The app image built here is the
   image AWS will run. Nothing about the VPS leaks into the app.
3. **Cost floor.** ~$5/mo total vs ~$50–150/mo for the smallest honest AWS
   staging (RDS + ECS + ALB + NAT). Two orders of magnitude cheaper while
   the test surface is identical at pilot scale (tens of synthetic users).
4. **Disposable.** `docker compose down -v` resets the world; the VPS can
   be destroyed and re-provisioned from this runbook in ~20 minutes.

**What stays out of scope here (deliberately):** LiveKit (sync-video slice
is post-pilot; add a `livekit` service to compose when Track E starts),
KMS-per-tenant (staging uses env-key encryption; AWS KMS wiring is a
pre-go-live task), SIEM shipping (pino stdout + `docker logs` suffice).

## Operator steps (one-time, ~20 min)

1. **Create the account + VPS** (the only step Claude cannot do):
   - hetzner.com → Cloud Console → new project "telecheck-staging" →
     Add Server → Ubuntu 24.04, CX22, Ashburn (or Falkenstein), add your
     SSH key. Note the public IPv4.
2. **DNS:** add an A record, e.g. `staging.heroshealth.com → <VPS IP>`
   (any subdomain works; it only needs to resolve for Let's Encrypt).
3. **Provision (as root on the VPS):**

   ```bash
   apt-get update && apt-get install -y docker.io docker-compose-v2 git ufw
   ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
   adduser --disabled-password --gecos "" deploy && usermod -aG docker deploy
   su - deploy
   git clone https://github.com/arthurmenson/telecheck-app.git && cd telecheck-app
   # (private repo: use a fine-grained read-only deploy token or deploy key)
   cp infra/staging/.env.example infra/staging/.env
   nano infra/staging/.env        # set passwords, domain, ACME email
   bash infra/staging/deploy.sh
   ```

4. **Seed + smoke:**

   ```bash
   docker compose -f infra/staging/docker-compose.yml --env-file infra/staging/.env \
     exec db psql -U telecheck telecheck -c "SELECT COUNT(*) FROM schema_migrations;"
   curl -s https://staging.<domain>/health
   ```

   Seed the two operating tenants (Telecheck-US + Telecheck-Ghana) with the
   synthetic-tenant seed script when it lands (tracked follow-up; until
   then, insert via psql per tests/fixtures conventions).

## Recurring operations

| Action | Command (on VPS, repo root) |
|---|---|
| Deploy latest main | `bash infra/staging/deploy.sh` |
| App logs | `docker compose -f infra/staging/docker-compose.yml logs -f app` |
| psql console | `docker compose -f infra/staging/docker-compose.yml exec db psql -U telecheck telecheck` |
| Full reset (DESTROYS DATA) | `docker compose -f infra/staging/docker-compose.yml down -v && bash infra/staging/deploy.sh` |
| DB backup | `docker compose -f infra/staging/docker-compose.yml exec -T db pg_dump -U telecheck telecheck | gzip > backup-$(date +%F).sql.gz` |

## Ground rules

- **Synthetic data only.** No real patient data ever touches this box
  (I-023/I-026 posture: staging predates the KMS + BAA + DR controls).
- **Secrets live only in `infra/staging/.env` on the VPS** (gitignored) —
  never in the repo, never in deliverables.
- **This is not production.** No SLOs, no on-call, no DR. Its job is to
  make the AWS pre-go-live build boring.

## Migration path to AWS (pre-go-live)

Same image → ECR; `db` service → RDS PostgreSQL 16 (apply-migrations.sh
against the RDS URL); `redis` → ElastiCache; `caddy` → ALB + ACM; env file
→ Secrets Manager. The compose file is the checklist.
