/**
 * async-consult-http.test.ts — Async-Consult slice HTTP integration tests.
 *
 * Exercises the state-mutating + read handlers via Fastify inject() with
 * Bearer JWT auth. Closes the test-coverage gap surfaced 2026-05-08:
 * the slice had only `async-consult-cross-tenant-isolation.test.ts`
 * (4 RLS/I-025 cases) and `async-consult-plugin-wiring.test.ts`
 * (module registration) — no end-to-end HTTP coverage of the lifecycle
 * + guard + auth + idempotency + PHI-projection contracts.
 *
 * Coverage in this file (6 groups, 13 cases):
 *
 *   Group A — Happy path lifecycle (initiate, listEvents)
 *     A1 initiate program/async returns 201 + PHI-safe view
 *     A2 listEvents on a freshly-initiated consult returns the
 *        consult.initiated event with tenant_id stripped
 *
 *   Group B — State-machine guard violations
 *     B1 submit a non-existent consult_id → 404 tenant-blind
 *     B2 abandon a freshly-initiated consult → 422 (< 48h activity
 *        guard)
 *     B3 patient-responds on a consult in INTAKE state (wrong state
 *        for that transition) → 409 conflict
 *
 *   Group C — Auth failures
 *     C1 no Bearer JWT → 401
 *     C2 JWT account_id ≠ body.account_id → 400 (handler authz check)
 *
 *   Group D — Body validation
 *     D1 missing account_id → 400
 *     D2 invalid consult_type (not program|general) → 400
 *     D3 invalid modality (not async|sync) → 400
 *
 *   Group E — Idempotency replay
 *     E1 same key + same body → cached 201 replay
 *     E2 same key + different body → 409 body_mismatch
 *
 *   Group F — PHI projection
 *     F1 initiate response body never contains "tenant_id" or
 *        the operating-tenant identifier
 *
 * Auth pattern: uses `mintTokenForAccount` (direct issueAccessToken)
 * matching the established async-consult-cross-tenant-isolation.test.ts
 * pattern. Lighter than the OTP/login round-trip in consent-http.test.ts;
 * the goal here is to authenticate AS a known patient, not to exercise
 * the auth flow itself.
 *
 * Spec references:
 *   - src/modules/async-consult/internal/handlers/consults.ts (target)
 *   - Async Consult Slice PRD v1.0 §10
 *   - State Machines v1.1 §3 (transition table + guards)
 *   - I-025 (tenant-blind error envelopes)
 *   - IDEMPOTENCY v5.1 §1 (cache 4-tuple + replay/body-mismatch)
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 (no tenant_id on
 *     patient surfaces)
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { config } from '../../src/lib/config.ts';
import { asTenantId } from '../../src/lib/glossary.ts';
import { issueAccessToken } from '../../src/lib/jwt.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { createAccount } from '../../src/modules/identity/internal/repositories/account-repo.ts';
import { asAccountId, type AccountId } from '../../src/modules/identity/internal/types.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';

// ---------------------------------------------------------------------------
// Tenant + context fixtures (mirrors async-consult-cross-tenant-isolation.test.ts)
// ---------------------------------------------------------------------------

const T_US = asTenantId(TENANT_US);
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

// ---------------------------------------------------------------------------
// Auth + seeding helpers
// ---------------------------------------------------------------------------

/**
 * Seed an account via the identity repo. Bypasses the OTP/activation
 * round-trip used in consent-http.test.ts because the goal here is
 * just to have a JWT-resolvable accountId, not to exercise auth flow.
 */
async function seedAccount(): Promise<AccountId> {
  const accountId = asAccountId(ulid());
  const phone = uniquePhone('+1');
  await withTenantContext(T_US, () =>
    createAccount(
      {
        account_id: accountId,
        tenant_id: T_US,
        phone_e164: phone,
        first_name: 'A',
        last_name: 'B',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
        country_of_residence: US_CTX.countryOfCare,
        country_of_care: US_CTX.countryOfCare,
      },
      // No-op tx callback — the account row alone is all we need for
      // these tests; the txCallback hook is for callers who want to
      // emit an audit/event in the same tx.
      async () => {},
    ),
  );
  return accountId;
}

/**
 * Mint a Bearer JWT for an existing accountId in the US tenant.
 * Mirrors `mintTokenForAccount` in async-consult-cross-tenant-isolation.test.ts.
 */
function mintToken(accountId: AccountId): string {
  return issueAccessToken(
    {
      account_id: accountId,
      tenant_id: T_US,
      session_id: ulid(),
      country_of_care: 'US',
    },
    config.jwtSigningKey,
  );
}

interface SeedResult {
  accountId: AccountId;
  accessToken: string;
}

/** Seed an account + mint its JWT in one shot. */
async function seedAuthedPatient(): Promise<SeedResult> {
  const accountId = await seedAccount();
  return { accountId, accessToken: mintToken(accountId) };
}

/**
 * Assert that a response body — success OR error envelope — leaks
 * neither the literal `tenant_id` JSON key nor the operating-tenant
 * identifier (`Telecheck-US`) anywhere in its serialized body.
 *
 * Per Codex Sprint 34 PR-51 review 2026-05-08 (MEDIUM closure): PHI
 * projection is a contract for ALL responses, not just successes —
 * an error envelope that accidentally echoed `tenant_id` would still
 * leak the operating-tenant identifier to a patient surface (Master
 * PRD v1.10 §17 + Glossary v5.2 C3). Apply this guard to every
 * `app.inject()` response in this file.
 */
function expectNoTenantLeak(response: { body: string }): void {
  expect(response.body).not.toContain('"tenant_id"');
  expect(response.body).not.toContain('Telecheck-US');
}

/**
 * Initiate a consult via the HTTP path (not direct service call) so the
 * caller can chain follow-on transitions against a real created row.
 * Returns the new consult_id.
 */
async function initiateConsultViaHttp(accountId: AccountId, accessToken: string): Promise<string> {
  const response = await app!.inject({
    method: 'POST',
    url: '/v0/async-consult',
    headers: {
      host: 'localhost',
      authorization: `Bearer ${accessToken}`,
      'idempotency-key': ulid(),
    },
    payload: {
      account_id: accountId,
      consult_type: 'program',
      modality: 'async',
    },
  });
  expect(response.statusCode).toBe(201);
  // Per Codex Sprint 34 PR-51 r2 review 2026-05-08 (MEDIUM closure):
  // the all-responses tenant-leak invariant must be enforced at the
  // shared helper boundary too, otherwise future payload/header
  // changes here become a silent blind spot for callers (A2, B2, B3
  // depend on this helper).
  expectNoTenantLeak(response);
  const body = response.json<{ consult_id: string }>();
  return body.consult_id;
}

// ---------------------------------------------------------------------------
// Group A — Happy path lifecycle
// ---------------------------------------------------------------------------

describe('async-consult HTTP — Group A: happy path lifecycle', () => {
  it('A1 POST /v0/async-consult initiate returns 201 + PHI-safe view', async () => {
    const { accountId, accessToken } = await seedAuthedPatient();

    const response = await app!.inject({
      method: 'POST',
      url: '/v0/async-consult',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': ulid(),
      },
      payload: {
        account_id: accountId,
        consult_type: 'program',
        modality: 'async',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{
      consult_id: string;
      consult_type: string;
      modality: string;
      state: string;
    }>();
    expect(body.consult_id).toBeTruthy();
    expect(body.consult_type).toBe('program');
    expect(body.modality).toBe('async');
    // Per State Machines v1.1 §3, initiate creates the consult in
    // INITIATED. Asserting the exact canonical state — not just
    // truthy — so a handler regression returning some other non-empty
    // state string would fail this test. State-machine renames are a
    // spec-corpus event; if the canonical label changes, this test
    // updates alongside (Codex Sprint 34 PR-51 review MEDIUM closure
    // 2026-05-08). Field name is `state` per the Consult interface
    // in src/modules/async-consult/internal/types.ts:127, NOT `status`
    // (CI-revealed in r4 2026-05-08).
    expect(body.state).toBe('INITIATED');
    expectNoTenantLeak(response);
  });

  it('A2 GET /v0/async-consult/:id/events returns 200 + empty PHI-safe events array', async () => {
    const { accountId, accessToken } = await seedAuthedPatient();
    const consultId = await initiateConsultViaHttp(accountId, accessToken);

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/async-consult/${consultId}/events`,
      headers: { host: 'localhost', authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      events: Array<{ event_type: string; consult_id: string }>;
    }>();
    expect(Array.isArray(body.events)).toBe(true);
    // Initiate writes to audit_records + emits a domain event but does
    // NOT insert into the consult_events table — the consult_events
    // append-only log is for state-transition records ONLY (per
    // src/modules/async-consult/internal/services/consult-service.ts —
    // only `submit`, `abandon`, `resume`, etc. call
    // consultEventRepo.createStateTransitionEvent; `initiate` does not).
    // ConsultEventType per types.ts:139 is the singleton 'state_transition'.
    // So a freshly-initiated consult correctly returns an empty events
    // array. Pinning a non-empty event_type here would require driving
    // a transition first, which can't happen cleanly from HTTP without
    // 48h-aging or seeding a terminal forms_submission. Coverage of
    // event-row PHI projection on a non-empty result is left to
    // post-transition tests when those paths become exercisable
    // (e.g., when SI-001 forms_submission integration lands).
    //
    // CI-revealed in PR-51 r4 2026-05-08 — earlier r3 incorrectly
    // assumed initiate writes a consult_events row.
    expect(body.events.length).toBe(0);
    // PHI-projection: response body (even an empty events array) MUST
    // NOT carry tenant_id (Master PRD v1.10 §17 + Glossary v5.2 C3) or
    // the operating-tenant identifier.
    expectNoTenantLeak(response);
  });
});

// ---------------------------------------------------------------------------
// Group B — State-machine guard violations
// ---------------------------------------------------------------------------

describe('async-consult HTTP — Group B: state-machine guard violations', () => {
  it('B1 POST submit on a non-existent consult_id → 404 tenant-blind', async () => {
    const { accessToken } = await seedAuthedPatient();
    const fakeConsultId = ulid();

    const response = await app!.inject({
      method: 'POST',
      url: `/v0/async-consult/${fakeConsultId}/submit`,
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': ulid(),
      },
      payload: { intake_form_submission_id: ulid() },
    });

    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.not_found');
    expectNoTenantLeak(response);
  });

  it('B2 POST abandon on a freshly-initiated consult → 422 (< 48h guard)', async () => {
    const { accountId, accessToken } = await seedAuthedPatient();
    const consultId = await initiateConsultViaHttp(accountId, accessToken);

    const response = await app!.inject({
      method: 'POST',
      url: `/v0/async-consult/${consultId}/abandon`,
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': ulid(),
      },
      payload: {},
    });

    // The abandon guard requires >= 48h since last activity. A
    // freshly-initiated consult is 0h old → AbandonGuardNotSatisfiedError
    // → mapped to 422 internal.request.semantically_invalid per
    // mapServiceError in consults.ts.
    expect(response.statusCode).toBe(422);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.request.semantically_invalid');
    expectNoTenantLeak(response);
  });

  it('B3 POST patient-responds on a consult in INTAKE → 409 state conflict', async () => {
    const { accountId, accessToken } = await seedAuthedPatient();
    const consultId = await initiateConsultViaHttp(accountId, accessToken);

    // patient-responds is the AWAITING_DATA → UNDER_REVIEW transition
    // (State Machines v1.1 §3, transition #16). A freshly-initiated
    // consult is in INITIATED (or INTAKE if start_intake also fired) —
    // NOT AWAITING_DATA, so the optimistic-concurrency UPDATE matches
    // zero rows and ConsultStateConflictError fires.
    const response = await app!.inject({
      method: 'POST',
      url: `/v0/async-consult/${consultId}/patient-responds`,
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': ulid(),
      },
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.conflict');
    expectNoTenantLeak(response);
  });
});

// ---------------------------------------------------------------------------
// Group C — Auth failures
// ---------------------------------------------------------------------------

describe('async-consult HTTP — Group C: auth failures', () => {
  it('C1 POST initiate without Bearer JWT → 401', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/async-consult',
      headers: { host: 'localhost', 'idempotency-key': ulid() },
      payload: {
        account_id: ulid(),
        consult_type: 'program',
        modality: 'async',
      },
    });
    expect(response.statusCode).toBe(401);
    expectNoTenantLeak(response);
  });

  it('C2 POST initiate with body.account_id ≠ JWT.accountId → 400', async () => {
    const { accessToken } = await seedAuthedPatient();
    // Construct a DIFFERENT account_id in the body — the handler's
    // authorization check (consults.ts:228) compares body.account_id
    // to actor.accountId from the JWT and rejects mismatch with 400
    // `internal.request.invalid`.
    const otherAccountId = asAccountId(ulid());

    const response = await app!.inject({
      method: 'POST',
      url: '/v0/async-consult',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': ulid(),
      },
      payload: {
        account_id: otherAccountId,
        consult_type: 'program',
        modality: 'async',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.request.invalid');
    expectNoTenantLeak(response);
  });
});

// ---------------------------------------------------------------------------
// Group D — Body validation
// ---------------------------------------------------------------------------

describe('async-consult HTTP — Group D: body validation', () => {
  it('D1 missing account_id → 400', async () => {
    const { accessToken } = await seedAuthedPatient();
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/async-consult',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': ulid(),
      },
      payload: { consult_type: 'program', modality: 'async' },
    });
    expect(response.statusCode).toBe(400);
    expectNoTenantLeak(response);
  });

  it('D2 invalid consult_type → 400', async () => {
    const { accountId, accessToken } = await seedAuthedPatient();
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/async-consult',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': ulid(),
      },
      payload: {
        account_id: accountId,
        consult_type: 'made_up_type',
        modality: 'async',
      },
    });
    expect(response.statusCode).toBe(400);
    expectNoTenantLeak(response);
  });

  it('D3 invalid modality → 400', async () => {
    const { accountId, accessToken } = await seedAuthedPatient();
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/async-consult',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': ulid(),
      },
      payload: {
        account_id: accountId,
        consult_type: 'program',
        modality: 'made_up_modality',
      },
    });
    expect(response.statusCode).toBe(400);
    expectNoTenantLeak(response);
  });
});

// ---------------------------------------------------------------------------
// Group E — Idempotency replay
// ---------------------------------------------------------------------------

describe('async-consult HTTP — Group E: idempotency replay', () => {
  it('E1 same key + same body → cached 201 replay', async () => {
    const { accountId, accessToken } = await seedAuthedPatient();
    const idempotencyKey = ulid();
    const payload = {
      account_id: accountId,
      consult_type: 'program' as const,
      modality: 'async' as const,
    };

    const first = await app!.inject({
      method: 'POST',
      url: '/v0/async-consult',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': idempotencyKey,
      },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<{ consult_id: string }>();

    const second = await app!.inject({
      method: 'POST',
      url: '/v0/async-consult',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': idempotencyKey,
      },
      payload,
    });
    expect(second.statusCode).toBe(201);
    const secondBody = second.json<{ consult_id: string }>();
    // Replay returns the SAME consult_id — no new row was created.
    expect(secondBody.consult_id).toBe(firstBody.consult_id);
    expectNoTenantLeak(first);
    expectNoTenantLeak(second);
  });

  it('E2 same key + different body → 409 internal.idempotency.body_mismatch', async () => {
    const { accountId, accessToken } = await seedAuthedPatient();
    const idempotencyKey = ulid();

    const first = await app!.inject({
      method: 'POST',
      url: '/v0/async-consult',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': idempotencyKey,
      },
      payload: { account_id: accountId, consult_type: 'program', modality: 'async' },
    });
    expect(first.statusCode).toBe(201);

    const second = await app!.inject({
      method: 'POST',
      url: '/v0/async-consult',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': idempotencyKey,
      },
      // Same key, DIFFERENT body — modality flipped.
      payload: { account_id: accountId, consult_type: 'program', modality: 'sync' },
    });
    expect(second.statusCode).toBe(409);
    const body = second.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.idempotency.body_mismatch');
    expectNoTenantLeak(first);
    expectNoTenantLeak(second);
  });
});

// ---------------------------------------------------------------------------
// Group F — PHI projection
// ---------------------------------------------------------------------------

describe('async-consult HTTP — Group F: PHI projection', () => {
  it('F1 initiate response body contains no tenant_id and no operating-tenant identifier', async () => {
    const { accountId, accessToken } = await seedAuthedPatient();

    const response = await app!.inject({
      method: 'POST',
      url: '/v0/async-consult',
      headers: {
        host: 'localhost',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': ulid(),
      },
      payload: {
        account_id: accountId,
        consult_type: 'program',
        modality: 'async',
      },
    });

    expect(response.statusCode).toBe(201);
    // The handler projects via toPatientConsultView which strips
    // tenant_id (consults.ts:70). Patient surface MUST NOT render the
    // operating-tenant identifier per Master PRD v1.10 §17 + C3.
    expectNoTenantLeak(response);
  });
});
