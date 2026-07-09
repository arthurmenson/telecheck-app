/**
 * admin-backend/internal/handlers/ai-providers.ts — SI-025 Phase 1 handlers
 *   for /v1/admin/ai-providers (admin-managed AI provider credentials).
 *
 * Four endpoints (SI-025 §4):
 *   GET    /v1/admin/ai-providers               masked list (platform_admin + tenant_admin)
 *   PUT    /v1/admin/ai-providers/:provider     set/rotate active key (platform_admin ONLY)
 *   DELETE /v1/admin/ai-providers/:provider     revoke active credential (platform_admin ONLY)
 *   POST   /v1/admin/ai-providers/:provider/test  live connection probe (platform_admin ONLY)
 *
 * **LAYER B authorization:**
 *   - Mutations (PUT/DELETE/POST test): platform_admin ONLY
 *     (`requirePlatformAdminActorContext`). The credential is a PLATFORM
 *     asset (SI-025 fork 2) so only platform_admin may mutate it. A
 *     tenant_admin gets 403.
 *   - Masked GET: platform_admin OR tenant_admin (`requireAdminActorContext`)
 *     — visibility of WHICH providers are configured, never the key.
 *
 * **DB floor:** writes run under `withDbRole('ai_provider_credential_writer')`
 * (migration 079 grants that role INSERT/UPDATE + column-SELECT on the
 * non-secret columns). The masked GET reads under the writer role too (it
 * holds column-level SELECT on exactly the masked columns; the
 * ciphertext/envelope columns are NOT granted to it at all). The test-probe
 * decrypt path reads under `ai_service_credential_reader` via the SECDEF
 * wrapper.
 *
 * **Platform-scoped table (no tenant RLS):** `ai_provider_credential` is a
 * platform asset (SI-025 fork 2) with no tenant_id / no RLS, so the pure
 * reads do NOT bind tenant context. The mutation path DOES run inside
 * `withIdempotentExecution` (which binds tenant context for the tenant-scoped
 * idempotency_keys table) + `withTenantContext` (belt-and-braces for the tx),
 * but the credential writes themselves are tenant-agnostic.
 *
 * **Key-safety (SI-025 §7) — the plaintext key:**
 *   - PUT accepts plaintext in the body; envelope-encrypted SERVER-SIDE
 *     immediately; plaintext not retained beyond the encrypt call.
 *   - NEVER stored raw, NEVER logged, NEVER returned by any response body,
 *     NEVER in an audit detail, NEVER in an error message.
 *   - GET returns masked rows (provider, sk-...last4, status, updated_at/by).
 *   - POST /test decrypts in-process, pings the provider, returns ok/fail —
 *     never the key.
 *
 * **Audit (SI-025 §2):** every mutation emits a Cat B governance audit
 * (set/rotated/revoked) carrying provider + key_last4 + key_fingerprint,
 * AFTER the withDbRole callback returns (the writer role does not hold
 * audit_records INSERT; emitAudit runs under the restored app role, same tx).
 *
 * Spec references:
 *   - SI-025 §2/§4/§5/§7 (RATIFIER-DIRECTED Evans 2026-07-09)
 *   - migration 079 (table + roles + read wrapper + bridge)
 *   - src/lib/with-db-role.ts (Option B SET LOCAL ROLE elevation)
 *   - src/lib/ai-provider-credential-envelope.ts (server-side envelope)
 *   - I-003 / I-025 / I-027
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  computeKeyFingerprint,
  computeKeyLast4,
  decryptAiProviderKey,
  encryptAiProviderKey,
  type AiProviderKeyEnvelope,
} from '../../../../lib/ai-provider-credential-envelope.js';
import {
  requireAdminActorContext,
  requirePlatformAdminActorContext,
  resolveActorTenantIdForAudit,
} from '../../../../lib/auth-context.js';
import { config } from '../../../../lib/config.js';
import type { DbClient } from '../../../../lib/db.js';
import { withTransaction } from '../../../../lib/db.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import { AnthropicLLMProvider } from '../../../ai-service/internal/providers/anthropic-provider.js';
import { emitAiProviderCredentialMutationAudit } from '../ai-providers-audit.js';

// ---------------------------------------------------------------------------
// Provider enum + validation
// ---------------------------------------------------------------------------

const PROVIDERS = ['anthropic', 'aws_bedrock', 'azure_openai'] as const;
type Provider = (typeof PROVIDERS)[number];

const ProviderParamSchema = z.object({
  provider: z.enum(PROVIDERS),
});

// PUT body: the plaintext API key. The value is consumed + encrypted
// immediately; it is NOT logged (this route is excluded from body logging).
const PutKeyBodySchema = z
  .object({
    api_key: z
      .string()
      .min(8, 'api_key must be a plausible provider key (>=8 chars)')
      .max(512, 'api_key exceeds the maximum accepted length'),
  })
  .strict();

// ---------------------------------------------------------------------------
// Masked view row (NEVER carries ciphertext / plaintext)
// ---------------------------------------------------------------------------

interface MaskedCredentialRow {
  provider: string;
  key_last4: string;
  status: string;
  updated_at: string;
  updated_by: string;
}

interface MaskedDbRow {
  provider: string;
  key_last4: string;
  status: string;
  updated_at: Date;
  updated_by: string;
}

/** Decoded envelope row shape from read_active_ai_provider_key (BYTEA → Buffer). */
interface EnvelopeDbRow {
  key_ciphertext: Buffer;
  key_kms_envelope_dek_id: string;
  key_kms_envelope_iv: Buffer;
  key_kms_envelope_tag: Buffer;
  key_kms_envelope_alg: string;
  key_kms_envelope_alg_version: string;
  key_kms_envelope_aad: Buffer;
  key_kms_envelope_encrypted_at: Date;
}

// ---------------------------------------------------------------------------
// Error envelope helper (tenant-blind; mirrors sibling handlers)
// ---------------------------------------------------------------------------

function errorEnvelope(
  reqId: string,
  code: string,
  message: string,
): { error: { code: string; message: string; request_id: string } } {
  return { error: { code, message, request_id: reqId } };
}

// ---------------------------------------------------------------------------
// GET /v1/admin/ai-providers — masked list (platform_admin + tenant_admin)
// ---------------------------------------------------------------------------

export async function getAiProvidersHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  // Tenant context must be present (foundation plugin), but the platform-
  // scoped table is not tenant-bound — we only require an admin actor.
  requireTenantContext(req);
  // LAYER B: masked read allowed to platform_admin OR tenant_admin.
  requireAdminActorContext(req);

  const masked = await withTransaction<MaskedCredentialRow[]>(async (tx) => {
    return withDbRole(tx, 'ai_provider_credential_writer', async () => {
      const r = await tx.query<MaskedDbRow>(
        `SELECT provider, key_last4, status, updated_at, updated_by
           FROM ai_provider_credential
          WHERE status = 'active'
          ORDER BY provider`,
      );
      return r.rows.map((row) => ({
        provider: row.provider,
        key_last4: row.key_last4,
        status: row.status,
        updated_at: row.updated_at.toISOString(),
        updated_by: row.updated_by,
      }));
    });
  });

  return reply.code(200).send({ providers: masked });
}

// ---------------------------------------------------------------------------
// Shared mutation-error mapper (tenant-blind)
// ---------------------------------------------------------------------------

function mapMutationError(err: unknown, reply: FastifyReply, reqId: string): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = (err as { code?: unknown }).code;
  if (code === '42501') {
    void reply
      .code(403)
      .send(errorEnvelope(reqId, 'admin.forbidden', 'Insufficient scope for this request.'));
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// PUT /v1/admin/ai-providers/:provider — set / rotate (platform_admin ONLY)
// ---------------------------------------------------------------------------

export async function putAiProviderHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  // LAYER B: mutations are platform_admin ONLY (platform-scoped asset).
  const actor = requirePlatformAdminActorContext(req);

  const paramsParsed = ProviderParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    throw req.server.httpErrors.badRequest('Invalid provider.');
  }
  const provider: Provider = paramsParsed.data.provider;

  const bodyParsed = PutKeyBodySchema.safeParse(req.body ?? {});
  if (!bodyParsed.success) {
    // Message intentionally does NOT echo the body value.
    throw req.server.httpErrors.badRequest('Invalid request body: api_key is required.');
  }
  const plaintextKey = bodyParsed.data.api_key;

  // Envelope-encrypt SERVER-SIDE immediately; derive non-secret metadata.
  // Plaintext is not retained past this point.
  const envelope = encryptAiProviderKey(plaintextKey);
  const keyLast4 = computeKeyLast4(plaintextKey);
  const keyFingerprint = computeKeyFingerprint(plaintextKey);

  const actorId = actor.accountId;
  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);

  return withIdempotentExecution(req, reply, mapMutationError, async (tx) => {
    return withTenantContext(tx, ctx.tenantId, async () => {
      const { credentialId, mutation } = await withDbRole(
        tx,
        'ai_provider_credential_writer',
        async () => performSetOrRotate(tx, provider, envelope, keyLast4, keyFingerprint, actorId),
      );

      // Cat B audit AFTER withDbRole restores the app role (writer role has
      // no audit_records INSERT). Same tx (I-003 durability).
      await emitAiProviderCredentialMutationAudit(
        {
          tenantId: ctx.tenantId,
          actorId,
          actorTenantId,
          countryOfCare: ctx.countryOfCare,
          mutation,
          provider,
          credentialId,
          keyLast4,
          keyFingerprint,
        },
        tx,
      );

      return { status: 200, view: { provider, key_last4: keyLast4, status: 'active' } };
    });
  });
}

/**
 * Atomically revoke any existing active credential for the provider and
 * insert the new active one. Returns the new credential id + whether this was
 * a first-set ('set') or a rotation ('rotated'). The one-active-per-provider
 * EXCLUDE constraint guarantees <=1 active row at commit; revoke-then-insert
 * in one tx keeps the invariant.
 */
async function performSetOrRotate(
  tx: DbClient,
  provider: Provider,
  envelope: AiProviderKeyEnvelope,
  keyLast4: string,
  keyFingerprint: string,
  actorId: string,
): Promise<{ credentialId: string; mutation: 'set' | 'rotated' }> {
  const revoked = await tx.query<{ id: string }>(
    `UPDATE ai_provider_credential
        SET status = 'revoked', updated_at = now(), updated_by = $2
      WHERE provider = $1 AND status = 'active'
      RETURNING id`,
    [provider, actorId],
  );
  const mutation: 'set' | 'rotated' = revoked.rows.length > 0 ? 'rotated' : 'set';

  const credentialId = ulid();
  await tx.query(
    `INSERT INTO ai_provider_credential (
        id, provider,
        key_ciphertext, key_kms_envelope_dek_id, key_kms_envelope_iv,
        key_kms_envelope_tag, key_kms_envelope_alg, key_kms_envelope_alg_version,
        key_kms_envelope_aad, key_kms_envelope_encrypted_at,
        key_last4, key_fingerprint, status, updated_by
     ) VALUES (
        $1, $2,
        $3, $4, $5,
        $6, $7, $8,
        $9, $10,
        $11, $12, 'active', $13
     )`,
    [
      credentialId,
      provider,
      envelope.ciphertext,
      envelope.dekId,
      envelope.iv,
      envelope.tag,
      envelope.alg,
      envelope.algVersion,
      envelope.aad,
      envelope.encryptedAt,
      keyLast4,
      keyFingerprint,
      actorId,
    ],
  );

  return { credentialId, mutation };
}

// ---------------------------------------------------------------------------
// DELETE /v1/admin/ai-providers/:provider — revoke (platform_admin ONLY)
// ---------------------------------------------------------------------------

export async function deleteAiProviderHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actor = requirePlatformAdminActorContext(req);

  const paramsParsed = ProviderParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    throw req.server.httpErrors.badRequest('Invalid provider.');
  }
  const provider: Provider = paramsParsed.data.provider;

  const actorId = actor.accountId;
  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);

  return withIdempotentExecution(req, reply, mapMutationError, async (tx) => {
    return withTenantContext(tx, ctx.tenantId, async () => {
      const revoked = await withDbRole(tx, 'ai_provider_credential_writer', async () => {
        const r = await tx.query<{ id: string; key_last4: string; key_fingerprint: string }>(
          `UPDATE ai_provider_credential
              SET status = 'revoked', updated_at = now(), updated_by = $2
            WHERE provider = $1 AND status = 'active'
            RETURNING id, key_last4, key_fingerprint`,
          [provider, actorId],
        );
        return r.rows[0];
      });

      if (revoked === undefined) {
        // No active credential — nothing to revoke. Tenant-blind 404.
        return { status: 404, view: { provider, status: 'not_configured' } };
      }

      await emitAiProviderCredentialMutationAudit(
        {
          tenantId: ctx.tenantId,
          actorId,
          actorTenantId,
          countryOfCare: ctx.countryOfCare,
          mutation: 'revoked',
          provider,
          credentialId: revoked.id,
          keyLast4: revoked.key_last4,
          keyFingerprint: revoked.key_fingerprint,
        },
        tx,
      );

      return { status: 200, view: { provider, status: 'revoked' } };
    });
  });
}

// ---------------------------------------------------------------------------
// POST /v1/admin/ai-providers/:provider/test — live probe (platform_admin ONLY)
//   Decrypts the active credential + a minimal real provider ping. Returns
//   ok/fail — NEVER the key.
// ---------------------------------------------------------------------------

export async function testAiProviderHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  requireTenantContext(req);
  requirePlatformAdminActorContext(req);

  const paramsParsed = ProviderParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    throw req.server.httpErrors.badRequest('Invalid provider.');
  }
  const provider: Provider = paramsParsed.data.provider;

  // Only Anthropic has a real adapter at v1.0.
  if (provider !== 'anthropic') {
    return reply.code(200).send({
      provider,
      ok: false,
      reason: 'No adapter implemented for this provider at v1.0 (Anthropic only).',
    });
  }

  // Resolve the plaintext key: active DB credential first, else env fallback.
  const plaintextKey = await resolveTestKey(provider);
  if (plaintextKey === null) {
    return reply.code(200).send({
      provider,
      ok: false,
      reason: 'No active credential configured and no environment fallback key present.',
    });
  }

  // Minimal live ping. The key is used ONLY inside the adapter; the response
  // never carries it. Any failure returns ok:false with a NON-key reason.
  const adapter = new AnthropicLLMProvider({ apiKey: plaintextKey, model: config.anthropicModel });
  try {
    await adapter.sendCompletion({
      workload_type: 'conversational_assistant',
      messages: [{ role: 'user', content: 'ping' }],
      max_output_tokens: 1,
      temperature: 0,
      tenant_id: 'PLATFORM',
    });
    return reply.code(200).send({ provider, ok: true });
  } catch (err) {
    // Base wraps into LLMProviderUnavailableError / validation; the message
    // is the upstream error text, which does not echo the key.
    const reason = err instanceof Error ? err.message : String(err);
    return reply.code(200).send({ provider, ok: false, reason });
  }
}

/**
 * Resolve the plaintext test key: active DB credential (via the SECDEF read
 * under the reader role) → ANTHROPIC_API_KEY env fallback → null. Never logs.
 */
async function resolveTestKey(provider: Provider): Promise<string | null> {
  const dbKey = await withTransaction<string | null>(async (tx) => {
    return withDbRole(tx, 'ai_service_credential_reader', async () => {
      const r = await tx.query<EnvelopeDbRow>('SELECT * FROM read_active_ai_provider_key($1)', [
        provider,
      ]);
      const row = r.rows[0];
      if (row === undefined) return null;
      return decryptAiProviderKey({
        ciphertext: row.key_ciphertext,
        dekId: row.key_kms_envelope_dek_id,
        iv: row.key_kms_envelope_iv,
        tag: row.key_kms_envelope_tag,
        alg: row.key_kms_envelope_alg,
        algVersion: row.key_kms_envelope_alg_version,
        aad: row.key_kms_envelope_aad,
        encryptedAt: row.key_kms_envelope_encrypted_at,
      });
    });
  });
  if (dbKey !== null) return dbKey;

  const envKey = config.anthropicApiKey;
  return typeof envKey === 'string' && envKey.length > 0 ? envKey : null;
}
