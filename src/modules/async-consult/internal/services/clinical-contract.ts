import { z } from 'zod';

const id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const fieldKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u);
// Plain text. A stored note is never interpreted as markup.
// eslint-disable-next-line no-control-regex
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const validCharacters = (value: string) =>
  !controls.test(value) &&
  [...value].every((character) => {
    const point = character.codePointAt(0)!;
    return point < 0xd800 || point > 0xdfff;
  });
const text = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0 && validCharacters(value));

/** Claims about the displayed form, checked against Forms and persisted case binding. */
export const CareDefinitionClaimSchema = z
  .object({
    deployment_id: id,
    template_id: id,
    template_version: z.number().int().positive(),
    schema_hash: hash,
  })
  .strict();
const answer = z.union([
  z.string().max(4000).refine(validCharacters),
  z.boolean(),
  z.number().finite(),
  z.array(z.string().max(100).refine(validCharacters)).max(32),
]);
export const CareIntakeRequestSchema = z
  .object({
    definition: CareDefinitionClaimSchema,
    answers: z.record(fieldKey, answer).refine((answers) => Object.keys(answers).length <= 64),
  })
  .strict();

/** Initial advice workflow; other decisions require their actual downstream operations. */
export const CareAdviceSchema = z
  .object({
    clinical_note: text(8000),
    patient_message: text(8000),
    follow_up_plan: text(4000),
  })
  .strict();
export const CareDecisionRequestSchema = z
  .object({
    claim_id: id,
    decision_type: z.literal('recommend'),
    rationale: CareAdviceSchema,
  })
  .strict();
export const CareFollowUpRequestSchema = z.object({ message: text(4000) }).strict();
export const CareClaimReleaseRequestSchema = z
  .object({
    claim_id: id,
    reason: z.enum(['clinician_unavailable', 'clinical_scope_mismatch']),
  })
  .strict();

/** Explicit projection keeps the private clinical note out of patient result responses. */
export function patientAdvice(value: unknown) {
  const validated = CareAdviceSchema.parse(value);
  return { patient_message: validated.patient_message, follow_up_plan: validated.follow_up_plan };
}

export const MAX_ADMITTED_CARE_BODY_BYTES = 1024 * 1024;

/**
 * Scan every string in an admitted JSON body before business/schema validation.
 * This includes unknown fields and strings in an invalid answer type, so a
 * crisis-bearing malformed form cannot disappear behind an ordinary 400.
 * The HTTP route must enforce MAX_ADMITTED_CARE_BODY_BYTES before parsing.
 * This helper performs no persistence or detection and does not certify safety.
 */
export function collectClinicalInputText(body: unknown): string[] {
  const pending: unknown[] = [body];
  const seen = new WeakSet<object>();
  const strings: string[] = [];
  let visited = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    if (++visited > MAX_ADMITTED_CARE_BODY_BYTES)
      throw new Error('care_body_outside_admission_limit');
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value, 'utf8');
      if (bytes > MAX_ADMITTED_CARE_BODY_BYTES)
        throw new Error('care_body_outside_admission_limit');
      strings.push(value);
    } else if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) throw new Error('care_body_is_not_json');
      seen.add(value);
      // Iteration avoids recursion overflow on malformed deeply nested input.
      for (const child of Object.values(value)) pending.push(child);
    }
  }
  return strings;
}
