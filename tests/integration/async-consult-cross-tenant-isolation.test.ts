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

import { describe, expect, it } from 'vitest';

import { asTenantId } from '../../src/lib/glossary.ts';
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
    const consultRepo = await import(
      '../../src/modules/async-consult/internal/repositories/consult-repo.ts'
    );
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
        consultService.process(
          US_CTX,
          { actorId: 'system_worker' },
          arbitraryConsultId,
        ),
      ),
    ).rejects.toThrow(consultService.AiServiceNotWiredError);
  });
});
