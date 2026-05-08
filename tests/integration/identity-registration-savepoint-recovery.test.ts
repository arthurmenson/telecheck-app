/**
 * identity-registration-savepoint-recovery.test.ts —
 * Sprint 33 PR-F3 r4-r5 SAVEPOINT recovery contract.
 *
 * Codifies the SAVEPOINT-based aborted-tx recovery in
 * `src/modules/identity/internal/handlers/registration.ts:282-330`
 * (the `phone_take_check` savepoint that wraps `createAccount` inside
 * `registrationVerifyHandler`'s `withIdempotency` body callback).
 *
 * The pattern under test:
 *   1. Body callback enters `withIdempotency` reservation
 *   2. `tx.query('SAVEPOINT phone_take_check')`
 *   3. `accountService.createAccount` may throw SQLSTATE 23505 on
 *      `uq_account_tenant_phone` (UNIQUE violation)
 *   4. Postgres aborts the transaction → ANY subsequent statement
 *      except ROLLBACK / SAVEPOINT / RELEASE fails with
 *      "current transaction is aborted"
 *   5. Handler catches the 23505 + constraint match, runs
 *      `ROLLBACK TO SAVEPOINT phone_take_check` + `RELEASE SAVEPOINT
 *      phone_take_check`, returns `{ status: 400, view:
 *      makeErrorEnvelope(req.id, PHONE_TAKEN, ...) }`
 *   6. `withIdempotency` then runs its UPDATE-to-completed against
 *      the now-healthy outer tx — cache row commits with status=400
 *      and the PHONE_TAKEN envelope as response_body
 *   7. A retry under the same Idempotency-Key replays the cached 400
 *      from the cache layer without re-running the body
 *
 * The fragility this guards against: if the SAVEPOINT release is
 * missed, the rollback runs against the wrong save-point name, OR
 * the catch swallows a different 23505 (e.g., account_id PK
 * collision) by mistake, the next `withIdempotency` UPDATE fails
 * with aborted-tx and the cached envelope never lands. Pre-r4-r5
 * this surfaced as a 500 rather than the deterministic 400.
 *
 * Why integration-level (real DB):
 *   The recovery behavior depends on Postgres semantics that mocks
 *   cannot honestly model:
 *     - `current transaction is aborted` after a failed INSERT
 *     - SAVEPOINT scope + RELEASE behavior
 *     - 23505 + constraint name surfacing on the pg DatabaseError
 *     - withIdempotency UPDATE-to-completed against a recovered tx
 *   Real DB integration is the only honest test surface.
 *
 * Coverage in this file (4 cases):
 *   §1a Happy path: fresh phone → 201 + cached row state='completed'
 *       with response_status=201 (proves SAVEPOINT was released
 *       cleanly on the success path)
 *   §1b SAVEPOINT recovery: pre-seeded phone → 400 PHONE_TAKEN +
 *       cached row state='completed' with response_status=400 AND
 *       response_body containing the PHONE_TAKEN code (proves the
 *       outer tx was NOT aborted by the failed INSERT — the
 *       UPDATE-to-completed ran successfully after the rollback)
 *   §1c Cached replay: same Idempotency-Key retried after §1b → 400
 *       replay from cache (proves the cached PHONE_TAKEN envelope
 *       is reachable; the cache row from §1b is queryable)
 *   §1d PHI projection on the PHONE_TAKEN envelope: no `tenant_id`
 *       or operating-tenant identifier leak in the error body
 *
 * Spec references:
 *   - src/modules/identity/internal/handlers/registration.ts:282-330
 *     (the SAVEPOINT recovery code path under test)
 *   - docs/PROJECT_CONVENTIONS.md r5 §3.8 (return-cached-vs-throw
 *     discipline; the PHONE_TAKEN envelope is the canonical example
 *     of a deterministic 4xx outcome that returns-as-cached rather
 *     than throwing)
 *   - docs/SI-006-Idempotency-Reserve-Then-Execute-Redesign.md
 *     v0.3 (Implementation Closure section)
 *   - I-025 (tenant-blind error envelopes)
 *   - IDEMPOTENCY v5.1 §1 (cache 4-tuple + replay semantics)
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import type { TenantId } from '../../src/lib/glossary.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import * as accountService from '../../src/modules/identity/internal/services/account-service.ts';
import * as otpService from '../../src/modules/identity/internal/services/otp-service.ts';
import { asAccountId, asOtpId } from '../../src/modules/identity/internal/types.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';
import { getTestClient } from '../setup.ts';

const T_US = TENANT_US as TenantId;
const US_CTX: TenantContext = {
  tenantId: T_US,
  displayName: 'Telecheck-US',
  countryOfCare: 'US',
  kmsKeyAlias: 'alias/telecheck-us-data-key',
  consumerDba: 'Heros Health',
  legalEntity: 'Telecheck Health LLC',
  consumerSubdomain: 'heroshealth.com',
};

let app: FastifyInstance | null = null;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  if (app !== null) {
    await app.close();
  }
});

/**
 * Issue a registration OTP via the service (so we know the plaintext
 * code) for a given phone. Mirrors the pattern in
 * identity-registration-http.test.ts §2a / §3.
 */
async function issueRegistrationOtp(phone: string): Promise<string> {
  const otpId = asOtpId(ulid());
  const { codePlaintext } = await withTenantContext(T_US, () =>
    otpService.issueOtp(
      US_CTX,
      { actorId: 'op_seed' },
      { otp_id: otpId, phone_e164: phone, purpose: 'registration' },
      getTestClient(),
    ),
  );
  return codePlaintext;
}

/**
 * Seed an account with the given phone — pre-conditions the
 * registration-verify call to hit the `uq_account_tenant_phone`
 * UNIQUE violation when it tries to createAccount with the same phone.
 */
async function seedExistingAccount(phone: string): Promise<void> {
  await withTenantContext(T_US, () =>
    accountService.createAccount(
      US_CTX,
      { actorId: 'op_seed' },
      {
        account_id: asAccountId(ulid()),
        phone_e164: phone,
        first_name: 'Existing',
        last_name: 'Patient',
        date_of_birth: '1985-03-15',
        gender: 'prefer_not_to_say',
      },
      getTestClient(),
    ),
  );
}

/**
 * Inspect the idempotency_keys row for a given (tenant, key,
 * endpoint, actor) tuple. Returns null if no row exists. Used to
 * prove the cache row reached 'completed' state — which is only
 * possible if the outer tx was healthy at the UPDATE-to-completed
 * step (i.e., the SAVEPOINT recovery worked).
 */
async function readIdempotencyRow(
  idempotencyKey: string,
): Promise<{ processing_state: string; response_status: number; response_body: unknown } | null> {
  const result = await getTestClient().query<{
    processing_state: string;
    response_status: number;
    response_body: unknown;
  }>(
    `SELECT processing_state, response_status, response_body
       FROM idempotency_keys
      WHERE tenant_id = $1
        AND key = $2
        AND endpoint = '/v0/identity/registration/verify'
      ORDER BY created_at DESC
      LIMIT 1`,
    [T_US, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// §1 — SAVEPOINT recovery contract on POST /v0/identity/registration/verify
// ---------------------------------------------------------------------------

describe('identity registration — SAVEPOINT recovery contract (PR-F3 r4-r5)', () => {
  it('§1a happy path: fresh phone → 201 + cached row state="completed" status=201', async () => {
    // No pre-seeded account; OTP is issued; createAccount succeeds;
    // SAVEPOINT is RELEASEd on the success path; withIdempotency
    // UPDATE-to-completed lands a cached 201.
    const phone = uniquePhone('+1');
    const code = await issueRegistrationOtp(phone);
    const idempotencyKey = ulid();

    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/registration/verify',
      headers: { host: 'localhost', 'idempotency-key': idempotencyKey },
      payload: {
        otp_id: ulid(), // body field; verifyOtp matches by phone+code, not otp_id
        code,
        phone_e164: phone,
        first_name: 'Test',
        last_name: 'Patient',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
      },
    });

    expect(response.statusCode).toBe(201);

    // Cache-row introspection: response_status=201 AND state='completed'
    // proves the outer tx was healthy through the UPDATE-to-completed.
    // If the SAVEPOINT had been mishandled (e.g., released without a
    // matching open) the entire tx would have been corrupted and this
    // row would either be missing or stuck in 'pending'.
    const row = await readIdempotencyRow(idempotencyKey);
    expect(row).not.toBeNull();
    expect(row!.processing_state).toBe('completed');
    expect(row!.response_status).toBe(201);
  });

  it('§1b SAVEPOINT recovery: pre-seeded phone → 400 PHONE_TAKEN + cached row state="completed" status=400', async () => {
    // The core regression test for PR-F3 r4-r5. With a pre-seeded
    // account holding the phone, registrationVerifyHandler's body
    // callback hits 23505 on uq_account_tenant_phone. Without the
    // SAVEPOINT recovery path the outer tx aborts and
    // withIdempotency's UPDATE-to-completed fails with "current
    // transaction is aborted" — surfacing as 500. With the recovery
    // path, the rollback restores tx health and the UPDATE lands a
    // cached 400 PHONE_TAKEN envelope.
    const phone = uniquePhone('+1');
    await seedExistingAccount(phone);
    const code = await issueRegistrationOtp(phone);
    const idempotencyKey = ulid();

    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/registration/verify',
      headers: { host: 'localhost', 'idempotency-key': idempotencyKey },
      payload: {
        otp_id: ulid(),
        code,
        phone_e164: phone,
        first_name: 'Test',
        last_name: 'Patient',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
      },
    });

    expect(response.statusCode).toBe(400);
    const errorBody = response.json<{ error: { code: string } }>();
    expect(errorBody.error.code).toBe('identity.registration.phone_taken');

    // Cache-row introspection: state='completed' + response_status=400
    // is the load-bearing assertion. If the SAVEPOINT recovery had
    // failed (any of: SAVEPOINT not opened, ROLLBACK TO SAVEPOINT
    // missed, RELEASE missed, swallow caught the wrong 23505), the
    // outer tx would be aborted at the UPDATE-to-completed step.
    // Postgres would return "current transaction is aborted, commands
    // ignored" — withIdempotency would re-throw to the handler →
    // Fastify global 500 → response body would NOT contain the
    // PHONE_TAKEN envelope AND no completed cache row would exist.
    const row = await readIdempotencyRow(idempotencyKey);
    expect(row).not.toBeNull();
    expect(row!.processing_state).toBe('completed');
    expect(row!.response_status).toBe(400);
    // The cached body MUST contain the PHONE_TAKEN code so retries
    // (§1c) can replay the deterministic envelope.
    expect(JSON.stringify(row!.response_body)).toContain('identity.registration.phone_taken');
  });

  it('§1c cached replay: same Idempotency-Key retried after §1b → cached 400 replay', async () => {
    // Proves the cached PHONE_TAKEN envelope is reachable via
    // withIdempotency's preHandler cache-replay path. A second call
    // with the same Idempotency-Key + same body short-circuits at the
    // preHandler — body callback does NOT run, so no second OTP
    // verification, no second createAccount attempt, no second
    // SAVEPOINT cycle.
    const phone = uniquePhone('+1');
    await seedExistingAccount(phone);
    const code = await issueRegistrationOtp(phone);
    const idempotencyKey = ulid();
    const payload = {
      otp_id: ulid(),
      code,
      phone_e164: phone,
      first_name: 'Test',
      last_name: 'Patient',
      date_of_birth: '1990-01-01',
      gender: 'prefer_not_to_say',
    };

    // First request: lands the cached 400 (same as §1b).
    const first = await app!.inject({
      method: 'POST',
      url: '/v0/identity/registration/verify',
      headers: { host: 'localhost', 'idempotency-key': idempotencyKey },
      payload,
    });
    expect(first.statusCode).toBe(400);

    // Second request with same key + same body: replay from cache.
    const second = await app!.inject({
      method: 'POST',
      url: '/v0/identity/registration/verify',
      headers: { host: 'localhost', 'idempotency-key': idempotencyKey },
      payload,
    });
    expect(second.statusCode).toBe(400);
    const secondBody = second.json<{ error: { code: string } }>();
    expect(secondBody.error.code).toBe('identity.registration.phone_taken');

    // First and second response bodies are identical (same cached
    // envelope replayed verbatim).
    expect(second.body).toBe(first.body);
  });

  it('§1d PHI projection: PHONE_TAKEN error envelope has no tenant_id leak', async () => {
    // Tenant-blind per I-025 + Master PRD v1.10 §17 + Glossary v5.2
    // C3. The envelope is built via makeErrorEnvelope and does NOT
    // include tenant_id by construction, but pin it with an explicit
    // negative assertion to catch any future regression that adds
    // tenant context to the error envelope.
    const phone = uniquePhone('+1');
    await seedExistingAccount(phone);
    const code = await issueRegistrationOtp(phone);
    const idempotencyKey = ulid();

    const response = await app!.inject({
      method: 'POST',
      url: '/v0/identity/registration/verify',
      headers: { host: 'localhost', 'idempotency-key': idempotencyKey },
      payload: {
        otp_id: ulid(),
        code,
        phone_e164: phone,
        first_name: 'Test',
        last_name: 'Patient',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('"tenant_id"');
    expect(response.body).not.toContain('Telecheck-US');
  });
});
