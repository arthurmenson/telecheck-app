/**
 * Cross-tenant isolation — async-consult service (I-023 / I-024 / I-025).
 *
 * Sprint 10 / TLC-021f. Mirrors `consent-cross-tenant-isolation.test.ts`
 * pattern. Direct service-layer test of three-layer isolation: RLS +
 * composite FKs + explicit tenant predicates.
 *
 * Coverage in this file (1 section, 4 cases):
 *   §1a Ghana initiate; US findById returns null (RLS-filtered)
 *   §1b Ghana initiate; US listEvents throws ConsultNotFoundError
 *       (cross-tenant treated tenant-blind same as cross-patient)
 *   §1c Same-tenant cross-patient: US patient A initiates; US patient B
 *       listEvents throws ConsultPatientOwnershipError (mapped to 404
 *       at handler per I-025)
 *   §1d Same-tenant cross-patient: US patient A initiates; US patient B
 *       abandon throws ConsultPatientOwnershipError (write path)
 *
 * Spec references:
 *   - I-023 (three-layer tenant isolation)
 *   - I-024 (cross-actor / break-glass discipline)
 *   - I-025 (tenant-blind error envelopes; ConsultPatientOwnershipError
 *     mapped to 404 at handler, NOT 403, so cross-patient existence is
 *     not leaked)
 *   - Async Consult Slice PRD v1.0
 *   - Codex async-consult-r9..r13 closures (defense-in-depth posture)
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { config } from '../../src/lib/config.ts';
import { asTenantId, type TenantId } from '../../src/lib/glossary.ts';
import { issueAccessToken } from '../../src/lib/jwt.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import * as consultService from '../../src/modules/async-consult/internal/services/consult-service.ts';
import { asConsultId } from '../../src/modules/async-consult/internal/types.ts';
import { createAccount } from '../../src/modules/identity/internal/repositories/account-repo.ts';
import { asAccountId, type AccountId } from '../../src/modules/identity/internal/types.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';

const T_US = asTenantId(TENANT_US);
const T_GH = asTenantId(TENANT_GHANA);

const US_CTX: TenantContext = {
  tenantId: T_US,
  displayName: 'Telecheck-US',
  countryOfCare: 'US',
  kmsKeyAlias: 'alias/telecheck-us-data-key',
  consumerDba: 'Heros Health',
  legalEntity: 'Telecheck Health LLC',
  consumerSubdomain: 'heroshealth.com',
};

const GH_CTX: TenantContext = {
  tenantId: T_GH,
  displayName: 'Telecheck-Ghana',
  countryOfCare: 'GH',
  kmsKeyAlias: 'alias/telecheck-gh-data-key',
  consumerDba: 'Heros Health Ghana',
  legalEntity: 'Telecheck-Ghana Ltd.',
  consumerSubdomain: 'ghana.heroshealth.com',
};

async function seedAccount(ctx: TenantContext, phonePrefix: string): Promise<AccountId> {
  const accountId = asAccountId(ulid());
  const phone = uniquePhone(phonePrefix);
  await withTenantContext(ctx.tenantId, () =>
    createAccount(
      {
        account_id: accountId,
        tenant_id: ctx.tenantId,
        phone_e164: phone,
        first_name: 'A',
        last_name: 'B',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
        country_of_residence: ctx.countryOfCare,
        country_of_care: ctx.countryOfCare,
      },
      // createAccount's required txCallback runs inside the same
      // transaction as the INSERT; test seeding doesn't need
      // post-INSERT side effects so this is a no-op.
      async () => {
        /* no-op */
      },
    ),
  );
  return accountId;
}

/**
 * Mint a JWT access token for a seeded patient account. Sprint 21 /
 * TLC-040 closure: replaces the legacy `x-actor-id` header stub that
 * stopped working when the auth-context plugin migrated to JWT-based
 * auth (per Identity & Authentication Spec v1.0 §3.3). Tests that
 * exercise HTTP handlers requiring `requireActorContext()` MUST mint
 * a token via this helper and pass it as `Authorization: Bearer
 * <token>`.
 *
 * Uses `issueAccessToken` directly (no OTP/login round-trip) since
 * the goal here is to authenticate as a known patient for the
 * handler-precedence test, not to exercise the full auth flow.
 */
function mintTokenForAccount(tenantId: TenantId, accountId: AccountId): string {
  return issueAccessToken(
    {
      account_id: accountId,
      tenant_id: tenantId,
      session_id: ulid(),
      country_of_care: tenantId === T_US ? 'US' : 'GH',
    },
    config.jwtSigningKey,
  );
}

// ---------------------------------------------------------------------------
// §1 cross-tenant + cross-patient isolation
// ---------------------------------------------------------------------------

describe('async-consult cross-tenant isolation — §1 service-layer (I-023 + I-025)', () => {
  it('§1a Ghana initiate; US findConsultById returns null (RLS-filtered)', async () => {
    // Seed Ghana patient + initiate Ghana consult
    const ghPatient = await seedAccount(GH_CTX, '+233');
    const ghConsult = await withTenantContext(T_GH, () =>
      consultService.initiate(
        GH_CTX,
        { actorId: ghPatient },
        {
          account_id: ghPatient,
          consult_type: 'general',
          modality: 'async',
          current_program_catalog_entry_id: null,
        },
      ),
    );

    // US tenant attempts to read by Ghana consult_id — should return null
    // (RLS + composite FK + explicit tenant predicate filter cross-tenant
    // out at the repo layer; service throws ConsultNotFoundError if it
    // tries to load — but findConsultById itself returns null directly)
    const consultRepo =
      await import('../../src/modules/async-consult/internal/repositories/consult-repo.ts');
    const found = await withTenantContext(T_US, () =>
      consultRepo.findConsultById(T_US, ghConsult.consult_id),
    );
    expect(found).toBeNull();
  });

  it('§1b Ghana initiate; US listEvents throws ConsultNotFoundError', async () => {
    const ghPatient = await seedAccount(GH_CTX, '+233');
    const ghConsult = await withTenantContext(T_GH, () =>
      consultService.initiate(
        GH_CTX,
        { actorId: ghPatient },
        {
          account_id: ghPatient,
          consult_type: 'general',
          modality: 'async',
          current_program_catalog_entry_id: null,
        },
      ),
    );

    // Construct a US patient (separate from Ghana) for the actor
    const usPatient = await seedAccount(US_CTX, '+1');

    // US tenant + US patient calling listEvents on Ghana consult_id —
    // should throw ConsultNotFoundError (NOT ConsultPatientOwnershipError;
    // cross-tenant is filtered before ownership check)
    await expect(
      withTenantContext(T_US, () =>
        consultService.listEvents(US_CTX, { accountId: usPatient }, ghConsult.consult_id),
      ),
    ).rejects.toThrow(consultService.ConsultNotFoundError);
  });

  it('§1c Same-tenant cross-patient: patient B reading patient A consult events throws ConsultPatientOwnershipError', async () => {
    const patientA = await seedAccount(US_CTX, '+1');
    const patientB = await seedAccount(US_CTX, '+1');

    const consultA = await withTenantContext(T_US, () =>
      consultService.initiate(
        US_CTX,
        { actorId: patientA },
        {
          account_id: patientA,
          consult_type: 'general',
          modality: 'async',
          current_program_catalog_entry_id: null,
        },
      ),
    );

    // Patient B (same tenant, different patient) tries to read A's events
    // — should throw ConsultPatientOwnershipError (handler maps to 404
    // per I-025 tenant-blind cross-patient envelope)
    await expect(
      withTenantContext(T_US, () =>
        consultService.listEvents(US_CTX, { accountId: patientB }, consultA.consult_id),
      ),
    ).rejects.toThrow(consultService.ConsultPatientOwnershipError);
  });

  it('§1d Same-tenant cross-patient: patient B abandoning patient A consult throws ConsultPatientOwnershipError', async () => {
    const patientA = await seedAccount(US_CTX, '+1');
    const patientB = await seedAccount(US_CTX, '+1');

    const consultA = await withTenantContext(T_US, () =>
      consultService.initiate(
        US_CTX,
        { actorId: patientA },
        {
          account_id: patientA,
          consult_type: 'general',
          modality: 'async',
          current_program_catalog_entry_id: null,
        },
      ),
    );

    // Patient B tries to abandon A's consult — write-path ownership check
    await expect(
      withTenantContext(T_US, () =>
        consultService.abandon(
          US_CTX,
          { actorId: patientB, accountId: patientB },
          consultA.consult_id,
        ),
      ),
    ).rejects.toThrow(consultService.ConsultPatientOwnershipError);
  });
});

// ---------------------------------------------------------------------------
// §2 fail-closed transitions (Codex r9 + r11 closure regression tests)
// ---------------------------------------------------------------------------

describe('async-consult fail-closed transitions — §2 SI-006 + SI-007 gates', () => {
  it('§2a startIntake throws PaymentNotVerifiedError (SI-006 gate)', async () => {
    const patient = await seedAccount(US_CTX, '+1');
    const consult = await withTenantContext(T_US, () =>
      consultService.initiate(
        US_CTX,
        { actorId: patient },
        {
          account_id: patient,
          consult_type: 'general',
          modality: 'async',
          current_program_catalog_entry_id: null,
        },
      ),
    );

    await expect(
      withTenantContext(T_US, () =>
        consultService.startIntake(
          US_CTX,
          { actorId: patient, accountId: patient },
          consult.consult_id,
        ),
      ),
    ).rejects.toThrow(consultService.PaymentNotVerifiedError);
  });

  it('§2b process throws AiServiceNotWiredError (SI-007 gate)', async () => {
    // process is fail-closed regardless of consult state — caller doesn't
    // even need a real consult. Use an arbitrary ULID.
    const arbitraryConsultId = asConsultId(ulid());

    await expect(
      withTenantContext(T_US, () =>
        consultService.process(US_CTX, { actorId: 'system_worker' }, arbitraryConsultId),
      ),
    ).rejects.toThrow(consultService.AiServiceNotWiredError);
  });
});

// ---------------------------------------------------------------------------
// §3 Handler-level tenant-blind 404 (Codex async-consult-r15 MEDIUM closure)
//
// The trust boundary that matters for I-025 is the HTTP response. The
// service-level assertions in §1 prove the right error class is thrown;
// these handler-level assertions prove the right HTTP envelope is
// returned: 404 internal.resource.not_found for BOTH cross-tenant +
// cross-patient mismatch — byte-identical to a "doesn't exist" response.
// A handler regression that returned 403 (or any distinguishing
// envelope) would surface here, even if the service-level tests still
// passed.
// ---------------------------------------------------------------------------

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

describe('async-consult HTTP — §3 handler-level tenant-blind 404 (I-025)', () => {
  it('§3a same-tenant cross-patient GET /:id/events returns 404 (NOT 403)', async () => {
    const patientA = await seedAccount(US_CTX, '+1');
    const patientB = await seedAccount(US_CTX, '+1');

    // Seed patient A's consult via the service layer (initiate works
    // without payment guard since it's the INITIAL INSERT, not a
    // start_intake transition).
    const consultA = await withTenantContext(T_US, () =>
      consultService.initiate(
        US_CTX,
        { actorId: patientA },
        {
          account_id: patientA,
          consult_type: 'general',
          modality: 'async',
          current_program_catalog_entry_id: null,
        },
      ),
    );

    // Patient B (same tenant, different patient) attempts to read A's
    // events via the HTTP handler. Sprint 21 / TLC-040: mint a JWT for
    // patient B (auth-context plugin migrated from x-actor-id header
    // stubs to JWT-based auth per Identity Spec v1.0 §3.3). Auth
    // succeeds (token belongs to a real same-tenant account); the
    // 404 must come from the SERVICE LAYER's
    // ConsultPatientOwnershipError (mapped to tenant-blind 404 per
    // I-025), not from auth.
    const tokenB = mintTokenForAccount(T_US, patientB);
    const r = await app!.inject({
      method: 'GET',
      url: `/v0/async-consult/${consultA.consult_id}/events`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${tokenB}`,
      },
    });

    // Tenant-blind 404 — the handler MUST NOT distinguish "doesn't
    // exist" from "exists but not yours" per I-025.
    expect(r.statusCode).toBe(404);
    const body = r.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.not_found');
  });

  it('§3b same-tenant cross-patient POST /:id/abandon returns 404 (write-path tenant-blind)', async () => {
    const patientA = await seedAccount(US_CTX, '+1');
    const patientB = await seedAccount(US_CTX, '+1');

    const consultA = await withTenantContext(T_US, () =>
      consultService.initiate(
        US_CTX,
        { actorId: patientA },
        {
          account_id: patientA,
          consult_type: 'general',
          modality: 'async',
          current_program_catalog_entry_id: null,
        },
      ),
    );

    // Patient B abandons A's consult via HTTP — must 404, not 403.
    // Sprint 21 / TLC-040: JWT auth migration (see §3a comment).
    // POST also needs explicit empty-body + content-type so Fastify's
    // default body-parser doesn't 400 the request before reaching the
    // handler precedence test (TLC-040 r2 fix-forward).
    const tokenB = mintTokenForAccount(T_US, patientB);
    const r = await app!.inject({
      method: 'POST',
      url: `/v0/async-consult/${consultA.consult_id}/abandon`,
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${tokenB}`,
        'content-type': 'application/json',
      },
      payload: {},
    });

    expect(r.statusCode).toBe(404);
    const body = r.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('internal.resource.not_found');
  });
});
