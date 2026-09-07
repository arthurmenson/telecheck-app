/** Legacy downstream-wrapper fixture, NOT payment or complete-journey evidence.
 * Real payment ingress is exercised separately by verify-billing-runtime.ts.
 */
import { createHash, randomBytes } from 'node:crypto';

import {
  bindActorContextForRequest,
  withActorContext,
} from '../../src/lib/actor-context-binding.js';
import { config } from '../../src/lib/config.js';
import { getBindActorContextPool } from '../../src/lib/db.js';
import { verifyAccessToken } from '../../src/lib/jwt.js';
import { ulid } from '../../src/lib/ulid.js';
import { withDbRole } from '../../src/lib/with-db-role.js';
import { getTestClient } from '../setup.js';

export async function seedBilledConsultFixture(token: string): Promise<string> {
  const verified = verifyAccessToken(token, config.jwtSigningKey);
  if (!verified.ok) throw new Error('fixture_token_invalid');
  const a = verified.claims;
  const tx = getTestClient();
  await tx.query('SELECT public.set_tenant_context($1)', [a.tenant_id]);
  await tx.query(
    "UPDATE public.accounts SET status='active' WHERE tenant_id=$1 AND account_id=$2",
    [a.tenant_id, a.sub],
  );
  await tx.query(
    `INSERT INTO public.sessions(session_id,tenant_id,account_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 hour') ON CONFLICT(session_id) DO NOTHING`,
    [a.session_id, a.tenant_id, a.sub, randomBytes(32).toString('hex')],
  );
  const price = ulid();
  const quote = ulid();
  const payment = ulid();
  const hash = createHash('sha256').update(payment).digest('hex');
  const version = (
    await tx.query<{ v: number }>(
      'SELECT COALESCE(max(version),0)+1 AS v FROM public.billing_consult_price WHERE tenant_id=$1 AND consult_type=$2',
      [a.tenant_id, 'general'],
    )
  ).rows[0]!.v;
  await tx.query(
    `INSERT INTO public.billing_consult_price(id,tenant_id,country_of_care,consult_type,program_id,version,amount_minor,currency,provider,provider_account,provider_mode,turnaround_minutes,quote_ttl_seconds,refund_policy,published_by)
    VALUES($1,$2,$3,'general',NULL,$4,4900,$5,'mock_local_dev','legacy-test-fixture','mock_local_dev',60,600,'full_before_review_or_decline_v1',$6)`,
    [
      price,
      a.tenant_id,
      a.country_of_care,
      version,
      a.country_of_care === 'GH' ? 'GHS' : 'USD',
      a.sub,
    ],
  );
  await tx.query(
    `INSERT INTO public.billing_consult_quote(id,tenant_id,patient_id,price_id,operation_key,created_at,expires_at) VALUES($1,$2,$3,$4,$5,statement_timestamp(),statement_timestamp()+interval '10 minutes')`,
    [quote, a.tenant_id, a.sub, price, hash],
  );
  await tx.query(
    `INSERT INTO public.billing_payment_intent(id,tenant_id,patient_id,purpose,quote_id,price_id,operation_key,request_hash,initiation_source,provider_reference,status,provider_created_at,verified_at) VALUES($1,$2,$3,'async_consult',$4,$5,$6,$6,'care_tab',$7,'paid',clock_timestamp(),clock_timestamp())`,
    [payment, a.tenant_id, a.sub, quote, price, hash, `test-${payment}`],
  );
  const pool = getBindActorContextPool();
  if (!pool) throw new Error('fixture_bind_pool_missing');
  const bindClient = await pool.connect();
  const nonce = await (async () => {
    try {
      return await bindActorContextForRequest(bindClient, {
        actorAccountId: a.sub,
        actorAccountTenantId: a.tenant_id,
        actorRole: 'patient',
        actorAdminHomeTenantId: null,
        sessionId: a.session_id,
      });
    } finally {
      bindClient.release();
    }
  })();
  return withActorContext(tx, nonce.nonce, () =>
    withDbRole(tx, 'async_consult_patient_initiator', async () => {
      const row = await tx.query<{ consult_id: string }>(
        'SELECT * FROM public.record_billed_consult_initiation($1,$2,$3)',
        [ulid(), payment, ulid()],
      );
      return row.rows[0]!.consult_id;
    }),
  );
}
