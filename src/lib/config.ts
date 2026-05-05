/**
 * config.ts — Environment loader with Zod validation.
 *
 * Purpose:
 *   Validates all required environment variables at startup using Zod.
 *   Exports a fully-typed `config` object consumed by every module.
 *   Fails fast (throws) on missing required vars — the app must not start
 *   in a misconfigured state.
 *
 * Spec references:
 *   - WORKLOAD_TAXONOMY v5.2: reserved AI workload types default to false;
 *     `featureFlags` expose the runtime gate per §1 (reserved require ADR +
 *     activation audit event before production use).
 *   - AUTONOMY_LEVELS v5.2: `action_with_audit_only` and `fully_autonomous`
 *     are reserved; their flags default false and must not be enabled without
 *     ADR-030 + activation audit event.
 *   - ADR-029: workload taxonomy activation conditions.
 *   - ADR-024: per-tenant KMS keys (alias stored in DB; dev uses a local key).
 *   - ADR-026: us-east-1 primary, us-west-2 cold DR.
 *
 * Open questions for Engineering Lead:
 *   - TENANT_KMS_LOCAL_DEV_KEY: how should prod KMS resolution be
 *     injected? Currently we assume all prod KMS aliases live in AWS and
 *     the app uses `kmsKeyAlias` from the `tenants` table; this config
 *     value is dev-only escape hatch.
 *   - REDIS_URL: not consumed by this file yet (idempotency.ts will read it);
 *     centralized here so all env access funnels through one validated object.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeatureFlagsSchema = z.object({
  // Reserved AI workload types (WORKLOAD_TAXONOMY v5.2 §3).
  // MUST remain false until both (a) successor ADR accepted AND
  // (b) activation audit event present in immutable chain.
  ENABLE_AUTONOMOUS_AGENT: z
    .string()
    .transform((v) => v === 'true')
    .pipe(
      z.literal(false, {
        errorMap: () => ({
          message: 'ENABLE_AUTONOMOUS_AGENT must be false at v1.0 — requires ADR-030',
        }),
      }),
    )
    .default('false'),

  ENABLE_MULTI_AGENT_SUPERVISOR: z
    .string()
    .transform((v) => v === 'true')
    .pipe(
      z.literal(false, {
        errorMap: () => ({
          message: 'ENABLE_MULTI_AGENT_SUPERVISOR must be false at v1.0 — requires ADR-033',
        }),
      }),
    )
    .default('false'),

  ENABLE_TOOL_USING_AGENT: z
    .string()
    .transform((v) => v === 'true')
    .pipe(
      z.literal(false, {
        errorMap: () => ({
          message: 'ENABLE_TOOL_USING_AGENT must be false at v1.0 — requires ADR-031 + ADR-030',
        }),
      }),
    )
    .default('false'),

  // Reserved autonomy levels (AUTONOMY_LEVELS v5.2 §3).
  ENABLE_ACTION_WITH_AUDIT_ONLY: z
    .string()
    .transform((v) => v === 'true')
    .pipe(
      z.literal(false, {
        errorMap: () => ({
          message:
            'ENABLE_ACTION_WITH_AUDIT_ONLY must be false at v1.0 — requires ADR-030 + PolicyAuthorization framework + I-012 successor invariant',
        }),
      }),
    )
    .default('false'),

  ENABLE_FULLY_AUTONOMOUS: z
    .string()
    .transform((v) => v === 'true')
    .pipe(
      z.literal(false, {
        errorMap: () => ({
          message:
            'ENABLE_FULLY_AUTONOMOUS must be false at v1.0 — requires ADR-030 + named successor invariant superseding I-012',
        }),
      }),
    )
    .default('false'),
});

const ConfigSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_REDACT_PATHS: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    ),

  // Database (PostgreSQL 15+ with RLS per ADR-023)
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .url('DATABASE_URL must be a valid PostgreSQL connection string'),

  // Connection pool sizing — defaults appropriate for a single-process
  // development run; production should tune per concurrent-request capacity.
  DB_POOL_MAX: z
    .string()
    .default('10')
    .transform((v) => Number.parseInt(v, 10))
    .pipe(z.number().int().min(1).max(200)),

  // SSL posture for the DB connection. Production deployments MUST set this
  // to 'require'. Local dev with Postgres in Docker / native typically uses
  // 'disable'. There is no 'verify-full' option here — that is a deployment
  // concern handled via the connection string `sslmode=verify-full`.
  DATABASE_SSL_MODE: z.enum(['disable', 'require']).default('disable'),

  // Redis (idempotency cache + queues)
  REDIS_URL: z
    .string()
    .min(1, 'REDIS_URL is required')
    .url('REDIS_URL must be a valid Redis connection string'),

  // KMS — dev-only local key; prod uses AWS KMS via `kmsKeyAlias` from tenants table
  TENANT_KMS_LOCAL_DEV_KEY: z.string().optional(),

  // JWT signing key for Identity slice access tokens (HMAC-SHA256 at v1.0;
  // RSA/ECDSA upgrade lands when key rotation infrastructure is wired).
  // Required in production; tests/dev fall back to a deterministic stub.
  // The signing key is platform-wide (not per-tenant) — JWT issuance + verify
  // happens at the platform plane; tenant_id is a CLAIM inside the JWT body.
  JWT_SIGNING_KEY: z.string().optional(),

  // AI providers (per ADR-020 multi-provider abstraction)
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-4-5-20250929'),

  // AWS (per ADR-026)
  AWS_REGION: z.string().default('us-east-1'),
  AWS_DR_REGION: z.string().default('us-west-2'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_BEDROCK_REGION: z.string().default('us-east-1'),

  // Feature flags — reserved workload types and autonomy levels
  ENABLE_AUTONOMOUS_AGENT: z.string().default('false'),
  ENABLE_MULTI_AGENT_SUPERVISOR: z.string().default('false'),
  ENABLE_TOOL_USING_AGENT: z.string().default('false'),
  ENABLE_ACTION_WITH_AUDIT_ONLY: z.string().default('false'),
  ENABLE_FULLY_AUTONOMOUS: z.string().default('false'),

  // Research data partnership (per ADR-028) — Stage 2 gate
  RESEARCH_DATA_PARTNERSHIP_ACTIVE: z.enum(['active', 'inactive']).default('inactive'),

  // Resume-token signing secret (Forms/Intake save-and-resume per Slice PRD §8).
  // The forms-intake module's resume-token.ts derives an HMAC-SHA-256 signature
  // over (resume_state_id, tenant_id, expires_at_ms) so a leaked token is
  // (a) tenant-bound (cannot be replayed in another tenant), (b) tamper-evident,
  // and (c) does not require a separate `resume_token_hash` column on
  // forms_resume_state (the current migration 006 lacks one).
  //
  // **Fail-closed in production** — missing/short secrets at NODE_ENV=production
  // throw at startup. Dev/test default is deterministic so tests are reproducible.
  RESUME_TOKEN_SECRET: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Parse and validate
// ---------------------------------------------------------------------------

function loadConfig() {
  const rawEnv = process.env;

  const result = ConfigSchema.safeParse(rawEnv);
  if (!result.success) {
    const messages = result.error.errors
      .map((e) => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(
      `Configuration validation failed — app cannot start:\n${messages}\n\n` +
        'Copy .env.example to .env and populate all required values.',
    );
  }

  const parsed = result.data;

  // Validate feature flags independently to surface clear rejection messages.
  const flagResult = FeatureFlagsSchema.safeParse({
    ENABLE_AUTONOMOUS_AGENT: parsed.ENABLE_AUTONOMOUS_AGENT,
    ENABLE_MULTI_AGENT_SUPERVISOR: parsed.ENABLE_MULTI_AGENT_SUPERVISOR,
    ENABLE_TOOL_USING_AGENT: parsed.ENABLE_TOOL_USING_AGENT,
    ENABLE_ACTION_WITH_AUDIT_ONLY: parsed.ENABLE_ACTION_WITH_AUDIT_ONLY,
    ENABLE_FULLY_AUTONOMOUS: parsed.ENABLE_FULLY_AUTONOMOUS,
  });

  if (!flagResult.success) {
    const messages = flagResult.error.errors
      .map((e) => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(
      `Feature flag validation failed — reserved AI workload types are not enabled at v1.0:\n${messages}\n\n` +
        'Per WORKLOAD_TAXONOMY v5.2: activation requires successor ADR + activation audit event.',
    );
  }

  // Production DB SSL fail-closed gate. Production deployments MUST set
  // DATABASE_SSL_MODE=require; the prior version of this file documented
  // the requirement in a comment but never enforced it, so a production
  // deploy with the env unset (default 'disable') would start with
  // unencrypted DB transport. Codex config-test-r1 closure 2026-05-04
  // (HIGH finding): the documented contract is now enforced.
  //
  // Why the gate is here, not in the Zod enum: the enum lists the two
  // valid SSL modes ('disable' / 'require') without cross-field
  // dependencies. The NODE_ENV-conditional rejection is a cross-field
  // invariant that's clearer expressed as a procedural check at the
  // point of resolution. Same pattern as the RESUME_TOKEN_SECRET gate
  // immediately below.
  if (parsed.NODE_ENV === 'production' && parsed.DATABASE_SSL_MODE !== 'require') {
    throw new Error(
      'DATABASE_SSL_MODE must be "require" in production. ' +
        `Got "${parsed.DATABASE_SSL_MODE}" — production deployments MUST encrypt DB transport ` +
        'per ADR-022 cloud-posture + I-023 cross-tenant data integrity. ' +
        'Local dev / test environments may use "disable" against a Postgres ' +
        'service without TLS termination.',
    );
  }

  // Resume-token secret resolution. Production fail-closed: missing or
  // <32-char secrets throw at startup. Dev/test get a deterministic default
  // so the suite is reproducible without env plumbing.
  let resumeTokenSecret = parsed.RESUME_TOKEN_SECRET ?? '';
  if (parsed.NODE_ENV === 'production') {
    if (resumeTokenSecret.length < 32) {
      throw new Error(
        'RESUME_TOKEN_SECRET must be set to a value of at least 32 characters in production. ' +
          'Forms/Intake save-and-resume tokens are HMAC-signed; a missing or weak secret ' +
          'undermines token integrity per Slice PRD §8.',
      );
    }
  } else if (resumeTokenSecret.length === 0) {
    // Deterministic dev/test default. Crucially NOT used in production
    // (the gate above rejects on entry); safe to be deterministic so tests
    // can re-issue and verify tokens without extra env plumbing.
    resumeTokenSecret =
      'dev-resume-token-secret-not-for-production-use-32chars-min-padding-padding';
  }

  // JWT signing key resolution. Mirror of the resume-token pattern:
  // production fail-closed on missing/short keys; dev/test get a
  // deterministic default. Identity Spec v1.0 §3.3: access tokens are
  // JWTs; signing key strength directly bounds session security.
  let jwtSigningKey = parsed.JWT_SIGNING_KEY ?? '';
  if (parsed.NODE_ENV === 'production') {
    if (jwtSigningKey.length < 32) {
      throw new Error(
        'JWT_SIGNING_KEY must be set to a value of at least 32 characters in production. ' +
          'Identity slice access tokens are HMAC-signed JWTs per Identity Spec §3.3; ' +
          'a missing or weak signing key undermines session integrity. ' +
          'Generate with: openssl rand -base64 48',
      );
    }
  } else if (jwtSigningKey.length === 0) {
    // Deterministic dev/test default.
    jwtSigningKey = 'dev-jwt-signing-key-not-for-production-use-32chars-min-padding-padding';
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    logRedactPaths: parsed.LOG_REDACT_PATHS ?? [],
    databaseUrl: parsed.DATABASE_URL,
    dbPoolMax: parsed.DB_POOL_MAX,
    dbSslMode: parsed.DATABASE_SSL_MODE,
    redisUrl: parsed.REDIS_URL,
    tenantKmsLocalDevKey: parsed.TENANT_KMS_LOCAL_DEV_KEY,
    jwtSigningKey,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    anthropicModel: parsed.ANTHROPIC_MODEL,
    aws: {
      region: parsed.AWS_REGION,
      drRegion: parsed.AWS_DR_REGION,
      accessKeyId: parsed.AWS_ACCESS_KEY_ID,
      secretAccessKey: parsed.AWS_SECRET_ACCESS_KEY,
      bedrockRegion: parsed.AWS_BEDROCK_REGION,
    },
    // All feature flags are `false` at v1.0 — validated above.
    featureFlags: {
      ENABLE_AUTONOMOUS_AGENT: false as const,
      ENABLE_MULTI_AGENT_SUPERVISOR: false as const,
      ENABLE_TOOL_USING_AGENT: false as const,
      ENABLE_ACTION_WITH_AUDIT_ONLY: false as const,
      ENABLE_FULLY_AUTONOMOUS: false as const,
    },
    researchDataPartnershipActive: parsed.RESEARCH_DATA_PARTNERSHIP_ACTIVE === 'active',
    resumeTokenSecret,
  } as const;
}

// ---------------------------------------------------------------------------
// Exported singleton — evaluated once at module load time
// ---------------------------------------------------------------------------

export const config = loadConfig();
export type Config = typeof config;
