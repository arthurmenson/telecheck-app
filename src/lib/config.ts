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
    .pipe(z.literal(false, { errorMap: () => ({ message: 'ENABLE_AUTONOMOUS_AGENT must be false at v1.0 — requires ADR-030' }) }))
    .default('false'),

  ENABLE_MULTI_AGENT_SUPERVISOR: z
    .string()
    .transform((v) => v === 'true')
    .pipe(z.literal(false, { errorMap: () => ({ message: 'ENABLE_MULTI_AGENT_SUPERVISOR must be false at v1.0 — requires ADR-033' }) }))
    .default('false'),

  ENABLE_TOOL_USING_AGENT: z
    .string()
    .transform((v) => v === 'true')
    .pipe(z.literal(false, { errorMap: () => ({ message: 'ENABLE_TOOL_USING_AGENT must be false at v1.0 — requires ADR-031 + ADR-030' }) }))
    .default('false'),

  // Reserved autonomy levels (AUTONOMY_LEVELS v5.2 §3).
  ENABLE_ACTION_WITH_AUDIT_ONLY: z
    .string()
    .transform((v) => v === 'true')
    .pipe(z.literal(false, { errorMap: () => ({ message: 'ENABLE_ACTION_WITH_AUDIT_ONLY must be false at v1.0 — requires ADR-030 + PolicyAuthorization framework + I-012 successor invariant' }) }))
    .default('false'),

  ENABLE_FULLY_AUTONOMOUS: z
    .string()
    .transform((v) => v === 'true')
    .pipe(z.literal(false, { errorMap: () => ({ message: 'ENABLE_FULLY_AUTONOMOUS must be false at v1.0 — requires ADR-030 + named successor invariant superseding I-012' }) }))
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

  // Redis (idempotency cache + queues)
  REDIS_URL: z.string().min(1, 'REDIS_URL is required').url('REDIS_URL must be a valid Redis connection string'),

  // KMS — dev-only local key; prod uses AWS KMS via `kmsKeyAlias` from tenants table
  TENANT_KMS_LOCAL_DEV_KEY: z.string().optional(),

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
  RESEARCH_DATA_PARTNERSHIP_ACTIVE: z
    .enum(['active', 'inactive'])
    .default('inactive'),
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

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    logRedactPaths: parsed.LOG_REDACT_PATHS ?? [],
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    tenantKmsLocalDevKey: parsed.TENANT_KMS_LOCAL_DEV_KEY,
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
  } as const;
}

// ---------------------------------------------------------------------------
// Exported singleton — evaluated once at module load time
// ---------------------------------------------------------------------------

export const config = loadConfig();
export type Config = typeof config;
