#!/usr/bin/env node
/**
 * mint-staging-token.mjs — mint a short-lived access token for STAGING
 * smoke testing. Runs INSIDE the app container (needs /app/dist + the
 * JWT_SIGNING_KEY env the server verifies against):
 *
 *   docker compose -f infra/staging/docker-compose.yml --env-file infra/staging/.env \
 *     exec -T app node scripts/mint-staging-token.mjs --role patient
 *
 * Options:
 *   --role     patient | clinician | tenant_admin | platform_admin  (required)
 *   --account  ULID (defaults to the scripts/seed-staging-accounts.sql identity
 *              for patient/clinician roles)
 *   --tenant   operating tenant id (default Telecheck-US)
 *   --country  US | GH (default US)
 *
 * Prints the raw JWT to stdout (15-minute TTL per Identity Spec §3.2).
 * This is a test utility: it does NOT create a session row — the v1.0
 * verify path validates claims + signature; session-service integration
 * tests cover session persistence separately.
 */
import { issueAccessToken } from '/app/dist/lib/jwt.js';
import { ulid } from 'ulid';

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const role = opt('role');
if (!role) {
  console.error('usage: mint-staging-token.mjs --role patient|clinician|tenant_admin [--account ULID] [--tenant id] [--country US|GH]');
  process.exit(1);
}

const DEFAULT_ACCOUNTS = {
  patient: '01JZZZ00000000000000000P01',
  clinician: '01JZZZ00000000000000000C01',
};

const tenant = opt('tenant', 'Telecheck-US');
const account = opt('account', DEFAULT_ACCOUNTS[role] ?? ulid());
const country = opt('country', 'US');

const signingKey = process.env.JWT_SIGNING_KEY;
if (!signingKey) {
  console.error('JWT_SIGNING_KEY is not set in this environment');
  process.exit(1);
}

const token = issueAccessToken(
  {
    account_id: account,
    tenant_id: tenant,
    session_id: ulid(),
    role,
    country_of_care: country,
    delegate_id: null,
    admin_tenant_binding: role === 'tenant_admin' ? tenant : null,
  },
  signingKey,
);

process.stdout.write(token + '\n');
