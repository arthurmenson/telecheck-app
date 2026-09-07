/**
 * Synthetic historical intake for downstream wrapper regressions only.
 * The test harness grants its test principal broad function access; production
 * patient roles cannot call this retained private wrapper after migration 095.
 * Actual plaintext HTTP/encryption acceptance is verify-care-intake-runtime.mjs.
 */
import {
  bindActorContextForRequest,
  withActorContext,
} from '../../src/lib/actor-context-binding.js';
import { config } from '../../src/lib/config.js';
import { getBindActorContextPool } from '../../src/lib/db.js';
import { verifyAccessToken } from '../../src/lib/jwt.js';
import { ulid } from '../../src/lib/ulid.js';
import { getTestClient } from '../setup.js';

export async function seedLegacyConsultIntakeFixture(
  token: string,
  consultId: string,
  templateId: string,
): Promise<string> {
  const verified = verifyAccessToken(token, config.jwtSigningKey);
  if (!verified.ok) throw new Error('fixture_token_invalid');
  const actor = verified.claims;
  const pool = getBindActorContextPool();
  if (!pool) throw new Error('fixture_bind_pool_missing');
  const binder = await pool.connect();
  const bound = await (async () => {
    try {
      return await bindActorContextForRequest(binder, {
        actorAccountId: actor.sub,
        actorAccountTenantId: actor.tenant_id,
        actorRole: 'patient',
        actorAdminHomeTenantId: null,
        sessionId: actor.session_id,
      });
    } finally {
      binder.release();
    }
  })();
  const tx = getTestClient();
  await tx.query('SELECT public.set_tenant_context($1)', [actor.tenant_id]);
  const submissionId = ulid();
  await withActorContext(tx, bound.nonce, async () => {
    await tx.query(
      'SELECT public.record_consult_intake_submission($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',
      [
        submissionId,
        actor.tenant_id,
        consultId,
        actor.sub,
        templateId,
        '1',
        Buffer.from('synthetic-historical-intake'),
        ulid(),
        Buffer.from('0123456789ab'),
        Buffer.from('0123456789abcdef'),
        'AES-256-GCM',
        '1',
        Buffer.from('tenant:synthetic'),
        new Date(),
        ulid(),
        ulid(),
        actor.sub,
        'patient',
      ],
    );
  });
  return submissionId;
}
