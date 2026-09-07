import { describe, expect, it, vi } from 'vitest';

import type { ClassifiedEnvelope } from '../../../../lib/classified-kms.js';
import type { DbTransaction } from '../../../../lib/db.js';
import { asTenantId } from '../../../../lib/glossary.js';
import type { CareConsentPatientContext } from '../../../consent/index.js';

import {
  createCareIntakeService,
  type BoundCareIntake,
  type CareConsentAdmission,
} from './clinical-intake.js';

const patient = '01K5BFNXP505NB6KS229BKCNQ3';
const consult = '01K5BFNXP505NB6KS229BKCNQ4';
const submission = '01K5BFNXP505NB6KS229BKCNQ5';
const template = '01K5BFNXP505NB6KS229BKCNQ6';
const deployment = '01K5BFNXP505NB6KS229BKCNQ7';
const tx = { query: vi.fn() } as DbTransaction;

function setup(country: 'US' | 'GH' = 'US') {
  const context = {
    tenant: { tenantId: asTenantId(`Telecheck-${country}`), countryOfCare: country },
    accountId: patient,
    sessionId: '01K5BFNXP505NB6KS229BKCNQ8',
    actorNonce: 'trusted-test-nonce',
  } as CareConsentPatientContext;
  const binding: BoundCareIntake = {
    consult_id: consult,
    patient_id: patient,
    consult_type: 'general',
    program_id: null,
    definition: {
      deployment_id: deployment,
      template_id: template,
      template_version: 1,
      schema_hash: 'a'.repeat(64),
      program_id: '01K5BFNXP505NB6KS229BKCNQ9',
      country_of_care: country,
      development_only: true,
      presentation: {
        contract_version: 'consult_intake_v1',
        kind: 'general_consult',
        locale: country === 'US' ? 'en-US' : 'en-GH',
        title: 'Synthetic intake',
        fields: [
          { id: 'symptoms', type: 'text', label: 'Symptoms', required: true, max_length: 100 },
        ],
        elements: [],
      },
    },
  };
  const input = {
    definition: {
      deployment_id: deployment,
      template_id: template,
      template_version: 1,
      schema_hash: 'a'.repeat(64),
    },
    answers: { symptoms: 'Synthetic text.' },
  };
  let current = structuredClone(binding);
  let consentStatus: CareConsentAdmission = {
    publication_id: template,
    policy_hash: 'b'.repeat(64),
    required_care_active: true,
    ai_interpretation_active: false,
    terms: [{ term_key: 'care', decision_id: deployment, active: true }],
  };
  const envelope = {
    ciphertext: Buffer.from('controlled-provider-envelope'),
  } as ClassifiedEnvelope;
  const calls: string[] = [];
  const repository = {
    authorize: vi.fn(async () => {
      calls.push('authorize');
      return structuredClone(current);
    }),
    append: vi.fn(async () => {
      calls.push('append');
    }),
    evidence: vi.fn(async () => {
      calls.push('evidence');
    }),
  };
  const validate = vi.fn(async () => ({ definition: binding.definition, answers: input.answers }));
  const consent = vi.fn(async () => {
    calls.push('consent');
    return structuredClone(consentStatus);
  });
  let duringProvider = async () => {};
  const encrypt = vi.fn(
    async (
      _tx: DbTransaction,
      _record: unknown,
      _data: unknown,
      authorize: () => Promise<void>,
    ) => {
      calls.push('encrypt');
      await authorize();
      await duringProvider();
      await authorize();
      return envelope;
    },
  );
  const run = createCareIntakeService({
    repository,
    validate,
    consent,
    crypto: { encrypt },
    newId: () => submission,
  });
  return {
    run: (body: unknown = input) => run(tx, context, consult, body),
    input,
    binding,
    context,
    repository,
    validate,
    consent,
    encrypt,
    calls,
    envelope,
    changeBinding: (next: BoundCareIntake) => {
      current = next;
    },
    changeConsent: (next: Partial<CareConsentAdmission>) => {
      consentStatus = { ...consentStatus, ...next };
    },
    duringProvider: (operation: () => Promise<void>) => {
      duringProvider = operation;
    },
  };
}

describe('clinical intake integration ordering and confidentiality', () => {
  it.each(['US', 'GH'] as const)(
    'admits required care without optional AI in %s',
    async (country) => {
      const s = setup(country);
      expect(await s.run()).toEqual({ submission_id: submission, status: 'submitted' });
      expect(s.encrypt).toHaveBeenCalledWith(
        tx,
        { patientId: patient, rowId: submission, field: 'intake_payload' },
        {
          contract_version: 'consult_intake_record_v1',
          definition: s.input.definition,
          answers: s.input.answers,
        },
        expect.any(Function),
      );
      expect(s.repository.append).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          envelope: s.envelope,
          consent: expect.objectContaining({ ai_interpretation_active: false }),
        }),
      );
      expect(s.calls.indexOf('encrypt')).toBeLessThan(s.calls.indexOf('append'));
      const persisted = s.repository.append.mock.calls[0] as unknown as [
        DbTransaction,
        Record<string, unknown>,
      ];
      expect(persisted[1]).not.toHaveProperty('answers');
    },
  );
  it('requires the displayed binding rather than silently substituting a newer form', async () => {
    const s = setup();
    await expect(
      s.run({ ...s.input, definition: { ...s.input.definition, template_version: 2 } }),
    ).rejects.toThrow('care.form_review_required');
    expect(s.encrypt).not.toHaveBeenCalled();
  });
  it('rejects a forged patient from the owning repository before touching clinical bytes', async () => {
    const s = setup();
    s.changeBinding({ ...s.binding, patient_id: template });
    await expect(s.run()).rejects.toThrow('care.intake_unavailable');
    expect(s.encrypt).not.toHaveBeenCalled();
  });
  it('retirement discovered by Forms prevents encryption and persistence', async () => {
    const s = setup();
    s.validate.mockRejectedValueOnce(new Error('forms.definition_restart_required'));
    await expect(s.run()).rejects.toThrow('forms.definition_restart_required');
    expect(s.encrypt).not.toHaveBeenCalled();
    expect(s.repository.append).not.toHaveBeenCalled();
  });
  it('care withdrawal while the provider waits aborts before appending', async () => {
    const s = setup();
    s.duringProvider(async () => s.changeConsent({ required_care_active: false }));
    await expect(s.run()).rejects.toThrow('care.consent_required');
    expect(s.repository.append).not.toHaveBeenCalled();
    expect(s.repository.evidence).not.toHaveBeenCalled();
  });
  it('AI withdrawal while the provider waits preserves care and records its latest independent state', async () => {
    const s = setup();
    s.changeConsent({ ai_interpretation_active: true });
    s.duringProvider(async () => s.changeConsent({ ai_interpretation_active: false }));
    await s.run();
    expect(s.repository.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        consent: expect.objectContaining({
          required_care_active: true,
          ai_interpretation_active: false,
        }),
      }),
    );
  });
  it('binding changes while the provider waits cannot attach ciphertext to a different definition', async () => {
    const s = setup();
    s.duringProvider(async () =>
      s.changeBinding({
        ...s.binding,
        definition: { ...s.binding.definition, schema_hash: 'c'.repeat(64) },
      }),
    );
    await expect(s.run()).rejects.toThrow('care.form_review_required');
    expect(s.repository.append).not.toHaveBeenCalled();
  });
  it('session expiry during provider work cannot create a submission', async () => {
    const s = setup();
    s.duringProvider(async () => {
      s.repository.authorize.mockRejectedValue(new Error('PT401'));
    });
    await expect(s.run()).rejects.toThrow('PT401');
    expect(s.repository.append).not.toHaveBeenCalled();
  });
  it('KMS failure never substitutes plaintext or a fabricated envelope', async () => {
    const s = setup();
    s.encrypt.mockRejectedValueOnce(new Error('kms_unavailable'));
    await expect(s.run()).rejects.toThrow('kms_unavailable');
    expect(s.repository.append).not.toHaveBeenCalled();
  });
  it('evidence failure propagates to the caller-owned transaction', async () => {
    const s = setup();
    s.repository.evidence.mockRejectedValueOnce(new Error('audit_unavailable'));
    await expect(s.run()).rejects.toThrow('audit_unavailable');
  });
  it('legacy or mixed ciphertext fields are never admitted', async () => {
    const s = setup();
    await expect(s.run({ ...s.input, intake_payload_envelope: {} })).rejects.toThrow(
      'care.invalid_intake',
    );
    expect(s.repository.authorize).not.toHaveBeenCalled();
  });
});
