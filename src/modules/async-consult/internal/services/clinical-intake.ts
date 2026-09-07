import type { ClassifiedEnvelope } from '../../../../lib/classified-kms.js';
import type { DbTransaction } from '../../../../lib/db.js';
import { ulid } from '../../../../lib/ulid.js';
import { getCareConsentStatus, type CareConsentPatientContext } from '../../../consent/index.js';
import {
  validateConsultIntake,
  type ConsultIntakeDefinition,
} from '../../../forms-intake/index.js';

import { CareIntakeRequestSchema } from './clinical-contract.js';
import { consultClinicalCrypto } from './clinical-crypto.js';

export class CareIntakeError extends Error {
  constructor(
    readonly code:
      | 'care.invalid_intake'
      | 'care.form_review_required'
      | 'care.consent_required'
      | 'care.intake_unavailable',
  ) {
    super(code);
  }
}

export interface BoundCareIntake {
  consult_id: string;
  patient_id: string;
  program_id: string | null;
  consult_type: 'general' | 'program_pathway';
  definition: ConsultIntakeDefinition;
}
export interface CareConsentAdmission {
  publication_id: string;
  policy_hash: string;
  required_care_active: boolean;
  ai_interpretation_active: boolean;
  terms: Array<{ term_key: string; decision_id: string | null; active: boolean }>;
}
export interface EncryptedCareSubmission {
  submissionId: string;
  binding: BoundCareIntake;
  envelope: ClassifiedEnvelope;
  consent: CareConsentAdmission;
}

/**
 * SQL implementation owns paid status, current case state, immutable form
 * binding and final consent checks. Both reads authorize the actual patient.
 * append() must acquire patient/consult locks only AFTER encryption and retain
 * them through audit/outbox/cache completion. Its deferred constraints validate
 * live authority and the correlated evidence at transaction completion.
 */
export interface CareIntakeRepository {
  authorize(tx: DbTransaction, consultId: string): Promise<BoundCareIntake>;
  append(tx: DbTransaction, input: EncryptedCareSubmission): Promise<void>;
  evidence(tx: DbTransaction, input: EncryptedCareSubmission): Promise<void>;
}

interface CareIntakeDependencies {
  repository: CareIntakeRepository;
  consent?: typeof getCareConsentStatus;
  validate?: typeof validateConsultIntake;
  crypto?: Pick<typeof consultClinicalCrypto, 'encrypt'>;
  newId?: () => string;
}

function sameBinding(a: BoundCareIntake, b: BoundCareIntake): boolean {
  return (
    a.consult_id === b.consult_id &&
    a.patient_id === b.patient_id &&
    a.program_id === b.program_id &&
    a.consult_type === b.consult_type &&
    a.definition.deployment_id === b.definition.deployment_id &&
    a.definition.template_id === b.definition.template_id &&
    a.definition.template_version === b.definition.template_version &&
    a.definition.schema_hash === b.definition.schema_hash &&
    a.definition.program_id === b.definition.program_id &&
    a.definition.country_of_care === b.definition.country_of_care
  );
}

/**
 * Normal clinical write core. The HTTP admission boundary must first run the
 * persisted platform crisis gate over the entire admitted body. A crisis is a
 * committed interruption; it must never be rolled back with an ordinary form
 * validation error. This core runs only after that gate returned no detection.
 * Nothing here generates or claims an AI preparation or a clinical conclusion.
 */
export function createCareIntakeService(dependencies: CareIntakeDependencies) {
  const consent = dependencies.consent ?? getCareConsentStatus;
  const validate = dependencies.validate ?? validateConsultIntake;
  const crypto = dependencies.crypto ?? consultClinicalCrypto;
  const newId = dependencies.newId ?? ulid;

  return async function submit(
    tx: DbTransaction,
    ctx: CareConsentPatientContext,
    consultId: string,
    input: unknown,
  ): Promise<{ submission_id: string; status: 'submitted' }> {
    const parsed = CareIntakeRequestSchema.safeParse(input);
    if (!parsed.success) throw new CareIntakeError('care.invalid_intake');
    const binding = await dependencies.repository.authorize(tx, consultId);
    if (
      binding.consult_id !== consultId ||
      binding.patient_id !== ctx.accountId ||
      binding.definition.country_of_care !== ctx.tenant.countryOfCare
    )
      throw new CareIntakeError('care.intake_unavailable');
    const claimed = parsed.data.definition;
    if (
      claimed.deployment_id !== binding.definition.deployment_id ||
      claimed.template_id !== binding.definition.template_id ||
      claimed.template_version !== binding.definition.template_version ||
      claimed.schema_hash !== binding.definition.schema_hash
    )
      throw new CareIntakeError('care.form_review_required');

    const context = {
      tenantId: ctx.tenant.tenantId,
      accountId: ctx.accountId,
      sessionId: ctx.sessionId,
      actorNonce: ctx.actorNonce,
      countryOfCare: binding.definition.country_of_care,
    };
    const kind = binding.consult_type === 'general' ? 'general_consult' : 'program';
    const validated = await validate(
      tx,
      context,
      binding.definition,
      kind,
      parsed.data.answers,
      'submit',
    );
    // The repository explicitly rebinds trusted context before each SQL/KMS
    // stage. It does not depend on a nested helper's previous tenant context.
    const verify = async () => {
      const current = await dependencies.repository.authorize(tx, consultId);
      if (!sameBinding(binding, current)) throw new CareIntakeError('care.form_review_required');
      const status = await consent(tx, ctx, binding.program_id);
      if (!status.required_care_active) throw new CareIntakeError('care.consent_required');
      return status;
    };
    let admission = await verify();
    const submissionId = newId();
    const envelope = await crypto.encrypt(
      tx,
      { patientId: ctx.accountId, rowId: submissionId, field: 'intake_payload' },
      {
        contract_version: 'consult_intake_record_v1',
        definition: {
          deployment_id: validated.definition.deployment_id,
          template_id: validated.definition.template_id,
          template_version: validated.definition.template_version,
          schema_hash: validated.definition.schema_hash,
        },
        answers: validated.answers,
      },
      async () => {
        admission = await verify();
      },
    );
    // Do not assume an injected provider performed its verification callback.
    // More importantly, capture the latest independent AI choice after all
    // provider waits. Declining AI never prevents ordinary care submission.
    admission = await verify();
    const record = { submissionId, binding, envelope, consent: admission };
    await dependencies.repository.append(tx, record);
    await dependencies.repository.evidence(tx, record);
    return { submission_id: submissionId, status: 'submitted' };
  };
}
