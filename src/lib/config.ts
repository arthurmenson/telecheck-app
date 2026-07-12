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
      // zod 4: errorMap key on z.literal options was renamed to `error`.
      // Since these are static-message error maps, collapsed to the
      // simpler `message:` key (equivalent semantically).
      z.literal(false, {
        message: 'ENABLE_AUTONOMOUS_AGENT must be false at v1.0 — requires ADR-030',
      }),
    )
    // zod 4: .default() on a piped schema must match the OUTPUT type
    // (post-pipe), which here is the boolean `false` after the
    // `.transform((v) => v === 'true').pipe(z.literal(false))`. zod 3
    // accepted the input-shape default `'false'` and routed it through
    // the transform; zod 4 requires the output-shape literal `false`.
    .default(false),

  ENABLE_MULTI_AGENT_SUPERVISOR: z
    .string()
    .transform((v) => v === 'true')
    .pipe(
      z.literal(false, {
        message: 'ENABLE_MULTI_AGENT_SUPERVISOR must be false at v1.0 — requires ADR-033',
      }),
    )
    .default(false),

  ENABLE_TOOL_USING_AGENT: z
    .string()
    .transform((v) => v === 'true')
    .pipe(
      z.literal(false, {
        message: 'ENABLE_TOOL_USING_AGENT must be false at v1.0 — requires ADR-031 + ADR-030',
      }),
    )
    .default(false),

  // Reserved autonomy levels (AUTONOMY_LEVELS v5.2 §3).
  ENABLE_ACTION_WITH_AUDIT_ONLY: z
    .string()
    .transform((v) => v === 'true')
    .pipe(
      z.literal(false, {
        message:
          'ENABLE_ACTION_WITH_AUDIT_ONLY must be false at v1.0 — requires ADR-030 + PolicyAuthorization framework + I-012 successor invariant',
      }),
    )
    .default(false),

  ENABLE_FULLY_AUTONOMOUS: z
    .string()
    .transform((v) => v === 'true')
    .pipe(
      z.literal(false, {
        message:
          'ENABLE_FULLY_AUTONOMOUS must be false at v1.0 — requires ADR-030 + named successor invariant superseding I-012',
      }),
    )
    .default(false),
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

  // SI-010 dedicated bind-pool URL. Required in production once SI-010
  // authContextPlugin wiring lands; optional in dev/test (the wiring
  // skips binding when undefined, leaving actorContext untrusted for
  // DB-side SECURITY DEFINER procedures — those procedures correctly
  // raise `actor_context_unbound` if called without a bound row).
  //
  // The connection string MUST authenticate as `bind_actor_context_role`
  // (a LOGIN role created by migration 031 with EXECUTE on
  // bind_actor_context()). It MUST NOT authenticate as
  // `telecheck_app_role` — the migration's session_user gate would
  // reject the bind anyway, but the config layer rejects this early
  // for clearer operator feedback.
  BIND_ACTOR_CONTEXT_DATABASE_URL: z
    .string()
    .url('BIND_ACTOR_CONTEXT_DATABASE_URL must be a valid PostgreSQL connection string')
    .optional(),

  // Pool sizing for the SI-010 bind pool. Lower than the main DB pool
  // because each bind is a single, fast statement. Default 5; tune up
  // if `bind_actor_context()` becomes a contention point.
  BIND_ACTOR_CONTEXT_POOL_MAX: z
    .string()
    .default('5')
    .transform((v) => Number.parseInt(v, 10))
    .pipe(z.number().int().min(1).max(50)),

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

  // Mode 2 case-prep route mount gate. Default OFF in every environment
  // until (a) clinical-anchor authorization is implemented (clinician
  // must be on the consult's care team for the named protocol — not
  // just JWT-role gating); (b) real protocol-engine provider execution
  // wires the I-012 reject-unless three-clause rule at the downstream
  // prescribing boundary per State Machines v1.2 §19 §19.X; (c) the
  // audit-emission discipline per I-019 / I-027 is verified end-to-end
  // against a live Postgres + real LLM provider. Flipping this to
  // `'true'` in production WITHOUT all three Day-3+ prerequisites is a
  // platform-floor violation per Codex PR #210 R1 NEEDS-WORK closure.
  //
  // Honest-failure-until-wiring-lands pattern matching the C1 cockpit
  // precedent: ship the route DEFINED but BEHIND A FLAG so prod can't
  // reach it; Day-3+ wiring flips the flag.
  AI_MODE2_ENABLED: z.enum(['false', 'true']).default('false'),

  // Staging-only OTP echo (Track 4 patient-app real-login wiring). No SMS
  // provider is wired at v1.0 — login/start issues the OTP and discards
  // the plaintext, which makes the real login flow unreachable outside
  // tests. When 'true', login/start includes the OTP plaintext in its
  // response as `dev_otp` so staging testers can complete the flow.
  // HARD-REFUSED when DEPLOY_ENV resolves to 'production' (fail-fast
  // below): echoing an auth credential in a response is a staging-only
  // affordance, removed in lockstep with the SMS-provider SI, never a
  // production toggle.
  AUTH_DEV_OTP_ECHO: z.enum(['false', 'true']).default('false'),

  // Transactional email delivery (email+PIN passcodes; see src/lib/email/).
  // Provider-agnostic. Default 'noop' = log-only, NO external send — so an
  // unconfigured/dev/test/CI environment changes no behavior (the passcode is
  // still issued + persisted; staging's dev_passcode echo still completes the
  // flow). Activation is a pure config flip to 'resend' + RESEND_API_KEY.
  // Flagged §12 SI (docs/SI-EMAIL-DELIVERY-PROVIDER.md), same posture as the
  // pending SMS-provider SI. `sending data to an external provider` is an
  // operator decision — this stays 'noop' until explicitly flipped.
  EMAIL_PROVIDER: z.enum(['noop', 'resend']).default('noop'),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().min(1).default('Heros Health <no-reply@heroshealth.com>'),

  // Transactional SMS delivery (phone OTP; see src/lib/sms/). Provider-
  // agnostic. Default 'noop' = log-only, NO external send — unconfigured/dev/
  // test changes no behavior (the OTP is still issued + persisted). Activation
  // is a config flip to 'telnyx' + TELNYX_API_KEY + a sender (SMS_FROM number
  // or TELNYX_MESSAGING_PROFILE_ID). Flagged §12 SI
  // (docs/SI-SMS-DELIVERY-PROVIDER.md). Sending data to an external provider
  // is an operator decision — stays 'noop' until explicitly flipped.
  SMS_PROVIDER: z.enum(['noop', 'telnyx']).default('noop'),
  TELNYX_API_KEY: z.string().optional(),
  SMS_FROM: z.string().optional(),
  TELNYX_MESSAGING_PROFILE_ID: z.string().optional(),

  // Deployment-environment label, DISTINCT from NODE_ENV: the staging
  // stack runs NODE_ENV=production for runtime parity (prod code paths,
  // no dev middleware), so NODE_ENV cannot express "is this the
  // production deployment". DEPLOY_ENV defaults to NODE_ENV's value —
  // fail-closed: an environment that does not explicitly label itself
  // 'staging' is treated as production for gate purposes. The staging
  // compose sets DEPLOY_ENV=staging.
  DEPLOY_ENV: z.enum(['development', 'test', 'staging', 'production']).optional(),

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
    const messages = result.error.issues
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
    const messages = flagResult.error.issues
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

  // R1 HIGH closure (Codex 2026-05-15) — SI-010 production fail-fast:
  // when NODE_ENV === 'production', BIND_ACTOR_CONTEXT_DATABASE_URL
  // MUST be set. Without it, requests authenticate successfully but
  // skip the bind invocation, so DB-side SECURITY DEFINER procedures
  // (SI-005 / SI-008 / SI-009) fail with `actor_context_unbound` at
  // request time — a late, easy-to-miss outage mode. The config-time
  // failure surfaces the misconfiguration at boot, before any traffic
  // is served.
  //
  // Dev/test/staging deliberately remain permissive — those
  // environments can run with bind-pool wiring opt-in until the
  // dedicated role + credentials are provisioned.
  if (parsed.NODE_ENV === 'production' && parsed.BIND_ACTOR_CONTEXT_DATABASE_URL === undefined) {
    throw new Error(
      'BIND_ACTOR_CONTEXT_DATABASE_URL must be set in production. ' +
        'SI-010 actor-context binding is the trust anchor for SECURITY DEFINER ' +
        'procedures (SI-005 / SI-008 / SI-009). Without it, requests authenticate ' +
        'but skip the bind invocation, causing procedure-boundary failures at ' +
        'request time. Set the env var to a connection string authenticating ' +
        'as bind_actor_context_role (the LOGIN role created by migration 031).',
    );
  }

  // Codex PR #210 R2 HIGH closure (2026-05-24): production fail-fast on
  // AI_MODE2_ENABLED=true. The handler only has clinician-role JWT
  // gating + an explicit TODO for clinician-on-care-team / protocol-
  // eligibility verification (see case-prep.ts §Layer B authorization
  // TODO(SI-024)). A mistaken or premature production env flip would
  // expose a known-unauthorized clinical surface. The config layer
  // enforces the documented production-invariant rather than relying
  // on operator discipline alone.
  //
  // When the three Day-3+ prerequisites land (clinical-anchor auth +
  // real protocol-engine provider execution + verified audit-emission
  // discipline end-to-end), this gate is removed in lockstep with the
  // SI that delivers them — not before. Dev / test / staging remain
  // permissive so the route's mount semantics can be exercised under
  // the same config singleton.
  if (parsed.NODE_ENV === 'production' && parsed.AI_MODE2_ENABLED === 'true') {
    throw new Error(
      'AI_MODE2_ENABLED must remain "false" in production. The Mode 2 case-prep ' +
        'handler at v0.1 has clinician-role JWT gating but lacks (a) clinical-anchor ' +
        'authorization (clinician-on-care-team-for-named-protocol — see ' +
        'src/modules/ai-service/internal/handlers/case-prep.ts TODO(SI-024)), ' +
        '(b) real protocol-engine provider execution wiring the I-012 reject-unless ' +
        'three-clause rule at the downstream prescribing boundary per State Machines ' +
        'v1.2 §19 §19.X, and (c) verified end-to-end audit-emission discipline per ' +
        'I-019 / I-027 against a live Postgres + real LLM provider. The flag may be ' +
        'flipped in dev / test / staging to exercise the mount path, but production ' +
        'rollout blocks until the SI that delivers all three prerequisites removes ' +
        'this gate in lockstep (Codex PR #210 R2 HIGH closure).',
    );
  }

  // Production fail-fast on AUTH_DEV_OTP_ECHO=true (same posture as the
  // AI_MODE2_ENABLED gate): echoing OTP plaintext in an HTTP response is
  // a staging-only affordance for the Track-4 patient-app login flow
  // while no SMS provider is wired. Keyed on DEPLOY_ENV (not NODE_ENV):
  // the staging stack runs NODE_ENV=production for runtime parity, and
  // DEPLOY_ENV defaults to NODE_ENV when unset — so any deployment that
  // has not explicitly labeled itself 'staging'/'development'/'test'
  // still fails closed as production.
  const deployEnv = parsed.DEPLOY_ENV ?? parsed.NODE_ENV;
  if (deployEnv === 'production' && parsed.AUTH_DEV_OTP_ECHO === 'true') {
    throw new Error(
      'AUTH_DEV_OTP_ECHO must remain "false" in production deployments ' +
        '(DEPLOY_ENV=production, or unset with NODE_ENV=production). The flag ' +
        'exists only so staging testers can complete the OTP login flow while no ' +
        'SMS provider is wired (login/start otherwise discards the OTP plaintext). ' +
        'It is removed in lockstep with the SMS-provider SI.',
    );
  }

  // Fail-fast if a real email provider is selected without its credential —
  // a silent fall-back to noop would drop every passcode email. (noop itself
  // is always valid: it is the intentional no-delivery default.)
  if (parsed.EMAIL_PROVIDER === 'resend' && (parsed.RESEND_API_KEY ?? '').length === 0) {
    throw new Error(
      'EMAIL_PROVIDER=resend requires RESEND_API_KEY to be set. Set a valid ' +
        'Resend API key (with a verified sending domain matching EMAIL_FROM), ' +
        'or leave EMAIL_PROVIDER=noop.',
    );
  }

  // Same posture for SMS: a real provider without its credential + a sender
  // would silently drop every OTP. (noop is always valid.)
  if (parsed.SMS_PROVIDER === 'telnyx') {
    if ((parsed.TELNYX_API_KEY ?? '').length === 0) {
      throw new Error(
        'SMS_PROVIDER=telnyx requires TELNYX_API_KEY to be set, or leave SMS_PROVIDER=noop.',
      );
    }
    if (
      (parsed.SMS_FROM ?? '').length === 0 &&
      (parsed.TELNYX_MESSAGING_PROFILE_ID ?? '').length === 0
    ) {
      throw new Error(
        'SMS_PROVIDER=telnyx requires a sender: set SMS_FROM (E.164 number) or ' +
          'TELNYX_MESSAGING_PROFILE_ID.',
      );
    }
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    logRedactPaths: parsed.LOG_REDACT_PATHS ?? [],
    databaseUrl: parsed.DATABASE_URL,
    dbPoolMax: parsed.DB_POOL_MAX,
    dbSslMode: parsed.DATABASE_SSL_MODE,
    // SI-010 dedicated bind pool (optional). When undefined, the
    // authContextPlugin skips bind invocation; the helpers from
    // src/lib/actor-context-binding.ts remain importable but the
    // request lifecycle does not produce an actorNonce.
    bindActorContextDatabaseUrl: parsed.BIND_ACTOR_CONTEXT_DATABASE_URL,
    bindActorContextPoolMax: parsed.BIND_ACTOR_CONTEXT_POOL_MAX,
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
    aiMode2Enabled: parsed.AI_MODE2_ENABLED === 'true',
    authDevOtpEcho: parsed.AUTH_DEV_OTP_ECHO === 'true',
    email: {
      provider: parsed.EMAIL_PROVIDER,
      resendApiKey: parsed.RESEND_API_KEY,
      from: parsed.EMAIL_FROM,
    },
    sms: {
      provider: parsed.SMS_PROVIDER,
      telnyxApiKey: parsed.TELNYX_API_KEY,
      from: parsed.SMS_FROM,
      messagingProfileId: parsed.TELNYX_MESSAGING_PROFILE_ID,
    },
    deployEnv,
    resumeTokenSecret,
  } as const;
}

// ---------------------------------------------------------------------------
// Exported singleton — evaluated once at module load time
// ---------------------------------------------------------------------------

export const config = loadConfig();
export type Config = typeof config;
