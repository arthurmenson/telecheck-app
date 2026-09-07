import { createHash } from 'node:crypto';

import { z } from 'zod';

const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const key = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u);
// Plain text only. Rendering never interprets policy copy as HTML or an expression.
// eslint-disable-next-line no-control-regex
const forbiddenControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        value.trim().length > 0 &&
        !forbiddenControls.test(value) &&
        [...value].every((character) => {
          const codePoint = character.codePointAt(0)!;
          return codePoint < 0xd800 || codePoint > 0xdfff;
        }),
    );
const section = z.object({ heading: text(120), body: text(6000) }).strict();
const commonTerm = {
  key,
  version_label: z.string().regex(/^v[0-9]{1,4}\.[0-9]{1,4}(\.[0-9]{1,4})?$/u),
  title: text(160),
  summary: text(1000),
  sections: z.array(section).min(1).max(8),
  withdrawal_effect: text(1500),
  duration: z.literal('until_withdrawn'),
};

/** Optional data use is never a prerequisite for admission to ordinary care. */
export const CarePolicyTermSchema = z.discriminatedUnion('consent_type', [
  z.object({ ...commonTerm, consent_type: z.literal('platform'), scope_id: z.null() }).strict(),
  z.object({ ...commonTerm, consent_type: z.literal('care'), scope_id: ulid.nullable() }).strict(),
  z
    .object({
      ...commonTerm,
      consent_type: z.literal('jurisdictional'),
      scope_id: key,
      regulatory_reference: text(1000),
    })
    .strict(),
  z
    .object({
      ...commonTerm,
      consent_type: z.literal('data_use'),
      scope_id: z.literal('ai_interpretation'),
      decline_effect: text(1500),
    })
    .strict(),
]);

export type CarePolicyTerm = z.infer<typeof CarePolicyTermSchema>;

/**
 * A proposal is not a publication or legal approval. The publication owner must
 * bind the exact hash to an independent, live authorized review and the tenant's
 * market configuration before any patient may accept it.
 */
export const CarePolicyProposalSchema = z
  .object({
    contract_version: z.literal('care_consent_v1'),
    country_of_care: z.string().regex(/^[A-Z]{2}$/u),
    locale: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/u),
    program_id: ulid.nullable(),
    development_only: z.boolean(),
    jurisdictional_review: z
      .object({
        artifact_reference: text(500),
        conclusion: z.enum(['no_additional_consent', 'requirements_listed']),
      })
      .strict(),
    terms: z.array(CarePolicyTermSchema).min(2).max(11),
  })
  .strict()
  .superRefine((proposal, ctx) => {
    const keys = new Set<string>();
    const scopes = new Set<string>();
    for (const [index, term] of proposal.terms.entries()) {
      if (keys.has(term.key)) {
        ctx.addIssue({ code: 'custom', path: ['terms', index, 'key'], message: 'Duplicate term.' });
      }
      keys.add(term.key);
      const scope = JSON.stringify([term.consent_type, term.scope_id]);
      if (scopes.has(scope)) {
        ctx.addIssue({
          code: 'custom',
          path: ['terms', index],
          message: 'Duplicate consent scope.',
        });
      }
      scopes.add(scope);
      if (term.consent_type === 'care' && term.scope_id !== proposal.program_id) {
        ctx.addIssue({ code: 'custom', path: ['terms', index], message: 'Care scope mismatch.' });
      }
    }
    for (const type of ['platform', 'care']) {
      if (proposal.terms.filter((term) => term.consent_type === type).length !== 1) {
        ctx.addIssue({ code: 'custom', path: ['terms'], message: `One ${type} term is required.` });
      }
    }
    const jurisdictional = proposal.terms.filter((term) => term.consent_type === 'jurisdictional');
    if (
      (proposal.jurisdictional_review.conclusion === 'no_additional_consent') !==
      (jurisdictional.length === 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['jurisdictional_review'],
        message: 'Review mismatch.',
      });
    }
    if (Buffer.byteLength(JSON.stringify(proposal), 'utf8') > 64 * 1024) {
      ctx.addIssue({ code: 'custom', message: 'Consent policy exceeds the byte limit.' });
    }
  });

export type CarePolicyProposal = z.infer<typeof CarePolicyProposalSchema>;

/** Keys sorted recursively; array order and every character of displayed text are retained. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((name) => `${JSON.stringify(name)}:${canonicalJson(record[name])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Hash only validated content; the database publication record additionally binds the tenant. */
export function hashCarePolicy(input: unknown): string {
  const policy = CarePolicyProposalSchema.parse(input);
  return createHash('sha256').update(canonicalJson(policy), 'utf8').digest('hex');
}

export const CareConsentChoicesSchema = z
  .object({
    publication_id: ulid,
    policy_hash: z.string().regex(/^[a-f0-9]{64}$/u),
    choices: z
      .array(z.object({ term_key: key, accepted: z.boolean() }).strict())
      .min(2)
      .max(11),
  })
  .strict();

export type CareConsentChoices = z.infer<typeof CareConsentChoicesSchema>;

/**
 * Used only after the owner resolves the current, published policy and exact ID.
 * A false decision is preserved. It never becomes an implicit grant and does
 * not hide the separate optional AI decision from the patient.
 */
export function evaluateCareConsentChoices(policy: CarePolicyProposal, input: unknown) {
  const choices = CareConsentChoicesSchema.parse(input);
  if (choices.policy_hash !== hashCarePolicy(policy)) {
    throw new CareConsentContractError('consent.policy_changed');
  }
  const byKey = new Map(choices.choices.map((choice) => [choice.term_key, choice.accepted]));
  if (
    byKey.size !== choices.choices.length ||
    byKey.size !== policy.terms.length ||
    policy.terms.some((term) => !byKey.has(term.key))
  ) {
    throw new CareConsentContractError('consent.invalid_choices');
  }
  const decisions = policy.terms.map((term) => ({
    term_key: term.key,
    consent_type: term.consent_type,
    scope_id: term.scope_id,
    accepted: byKey.get(term.key) === true,
  }));
  return {
    publication_id: choices.publication_id,
    policy_hash: choices.policy_hash,
    decisions,
    required_care_accepted: decisions.every(
      (term) => term.consent_type === 'data_use' || term.accepted,
    ),
    ai_interpretation_accepted: decisions.some(
      (term) => term.consent_type === 'data_use' && term.accepted,
    ),
  };
}

export class CareConsentContractError extends Error {
  constructor(readonly code: 'consent.policy_changed' | 'consent.invalid_choices') {
    super(code);
    this.name = 'CareConsentContractError';
  }
}
