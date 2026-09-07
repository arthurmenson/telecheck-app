import { describe, expect, it } from 'vitest';

import {
  CareDecisionRequestSchema,
  CareFollowUpRequestSchema,
  CareIntakeRequestSchema,
  collectClinicalInputText,
  MAX_ADMITTED_CARE_BODY_BYTES,
  patientAdvice,
} from './clinical-contract.js';

const id = '01M1WMWRNAAS9GKR0P99D22QD8';
const intake = {
  definition: {
    deployment_id: id,
    template_id: id,
    template_version: 1,
    schema_hash: 'a'.repeat(64),
  },
  answers: { symptoms: 'Mild discomfort', duration: 2, prior_visit: false },
};
const rationale = {
  clinical_note: 'PRIVATE synthetic clinical note.',
  patient_message: 'Patient-facing advice.',
  follow_up_plan: 'Patient-facing follow-up plan.',
};
describe('protected care ingress contracts', () => {
  it.each(['\u0000', '\u007f', '\ud800', '\udc00'])(
    'rejects invalid clinical answer characters without changing their bytes',
    (value) => {
      expect(
        CareIntakeRequestSchema.safeParse({ ...intake, answers: { symptoms: value } }).success,
      ).toBe(false);
      expect(
        CareIntakeRequestSchema.safeParse({ ...intake, answers: { symptoms: [value] } }).success,
      ).toBe(false);
    },
  );
  it('accepts plaintext form claims and preserves explicit false/zero answers', () => {
    expect(
      CareIntakeRequestSchema.parse({ ...intake, answers: { ...intake.answers, duration: 0 } })
        .answers,
    ).toEqual({ symptoms: 'Mild discomfort', duration: 0, prior_visit: false });
  });
  it.each([
    'intake_payload_envelope',
    'patient_id',
    'tenant_id',
    'consent_active',
    'payment_verified',
  ])('rejects caller-authoritative %s', (key) => {
    expect(CareIntakeRequestSchema.safeParse({ ...intake, [key]: 'forged' }).success).toBe(false);
  });
  it('rejects legacy-only ciphertext bodies', () => {
    expect(
      CareIntakeRequestSchema.safeParse({
        template_id: id,
        template_version: '1',
        intake_payload_envelope: {},
      }).success,
    ).toBe(false);
  });
  it('extracts crisis-bearing text even when later schema validation rejects an unknown field', () => {
    const raw = { ...intake, unexpected: { nested: ['I want to hurt myself'] } };
    expect(CareIntakeRequestSchema.safeParse(raw).success).toBe(false);
    expect(collectClinicalInputText(raw)).toContain('I want to hurt myself');
  });
  it('retains an overlong answer for crisis processing before business validation', () => {
    const raw = { ...intake, answers: { symptoms: 'x'.repeat(5000) + ' I want to hurt myself' } };
    expect(CareIntakeRequestSchema.safeParse(raw).success).toBe(false);
    expect(
      collectClinicalInputText(raw).some((value) => value.includes('I want to hurt myself')),
    ).toBe(true);
  });
  it('traverses deeply nested admitted JSON without recursive stack overflow', () => {
    let nested: unknown = 'crisis-bearing text';
    for (let i = 0; i < 10000; i++) nested = [nested];
    expect(collectClinicalInputText(nested)).toEqual(['crisis-bearing text']);
  });
  it('rejects non-JSON cycles and input outside the admission byte limit without echoing content', () => {
    const circular: unknown[] = [];
    circular.push(circular);
    expect(() => collectClinicalInputText(circular)).toThrow('care_body_is_not_json');
    expect(() => collectClinicalInputText('x'.repeat(MAX_ADMITTED_CARE_BODY_BYTES + 1))).toThrow(
      'care_body_outside_admission_limit',
    );
  });
  it.each(['prescribe', 'decline', 'request_more_data', 'refer', 'escalate_to_sync'])(
    'does not invent the downstream %s workflow',
    (decision_type) => {
      expect(
        CareDecisionRequestSchema.safeParse({ claim_id: id, decision_type, rationale }).success,
      ).toBe(false);
    },
  );
  it('accepts explicit clinical and patient-facing advice fields', () => {
    expect(
      CareDecisionRequestSchema.parse({ claim_id: id, decision_type: 'recommend', rationale })
        .rationale,
    ).toEqual(rationale);
  });
  it('patient projection excludes the clinical-only note', () => {
    expect(patientAdvice(rationale)).toEqual({
      patient_message: rationale.patient_message,
      follow_up_plan: rationale.follow_up_plan,
    });
    expect(JSON.stringify(patientAdvice(rationale))).not.toContain('PRIVATE');
  });
  it.each(['', ' ', '\u0000', '\ud800', 'x'.repeat(4001)])(
    'rejects empty, invalid Unicode/control or overlong follow-up text',
    (message) => {
      expect(CareFollowUpRequestSchema.safeParse({ message }).success).toBe(false);
    },
  );
  it('preserves valid supplementary Unicode at the exact UTF-16 limit', () => {
    const message = '\u{1f600}'.repeat(2000);
    expect(CareFollowUpRequestSchema.parse({ message }).message).toBe(message);
  });
});
