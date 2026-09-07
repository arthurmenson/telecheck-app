import { describe, expect, it } from 'vitest';

import {
  CareConsentChoicesSchema,
  CarePolicyProposalSchema,
  evaluateCareConsentChoices,
  hashCarePolicy,
} from './care-policy-contract.js';

const publication = '01KKKKKKKKKKKKKKKKKKKKKKKK';
const program = '01PPPPPPPPPPPPPPPPPPPPPPPP';
const copy = {
  version_label: 'v1.0',
  title: 'Synthetic test terms',
  summary: 'Development fixture only.',
  sections: [{ heading: 'Services', body: 'Synthetic terms for engineering verification.' }],
  withdrawal_effect: 'Development fixture withdrawal explanation.',
  duration: 'until_withdrawn',
};
const proposal = () => ({
  contract_version: 'care_consent_v1',
  country_of_care: 'GH',
  locale: 'en-GH',
  program_id: null,
  development_only: true,
  jurisdictional_review: {
    artifact_reference: 'synthetic-fixture-review',
    conclusion: 'no_additional_consent',
  },
  terms: [
    { ...copy, key: 'platform', consent_type: 'platform', scope_id: null },
    { ...copy, key: 'care', consent_type: 'care', scope_id: null },
    {
      ...copy,
      key: 'ai',
      consent_type: 'data_use',
      scope_id: 'ai_interpretation',
      decline_effect: 'Manual care remains available without personalized AI preparation.',
    },
  ],
});
const decisions = (policy: unknown, accepted: boolean[] = [true, true, false]) => ({
  publication_id: publication,
  policy_hash: hashCarePolicy(policy),
  choices: ['platform', 'care', 'ai'].map((term_key, index) => ({
    term_key,
    accepted: accepted[index],
  })),
});

describe('care consent policy boundary', () => {
  it('admits care when optional personalized AI is explicitly declined', () => {
    const policy = CarePolicyProposalSchema.parse(proposal());
    const result = evaluateCareConsentChoices(policy, decisions(policy));
    expect(result.required_care_accepted).toBe(true);
    expect(result.ai_interpretation_accepted).toBe(false);
    expect(result.decisions[2]).toMatchObject({ accepted: false, scope_id: 'ai_interpretation' });
  });

  it.each([
    [false, true, true],
    [true, false, true],
  ])('preserves a declined required term and blocks care admission (%j)', (...accepted) => {
    const policy = CarePolicyProposalSchema.parse(proposal());
    const result = evaluateCareConsentChoices(policy, decisions(policy, accepted));
    expect(result.required_care_accepted).toBe(false);
    expect(result.ai_interpretation_accepted).toBe(true);
    expect(result.decisions.some((term) => !term.accepted)).toBe(true);
  });

  it('binds care to the selected program and rejects a grant for another program', () => {
    const input = proposal();
    expect(CarePolicyProposalSchema.safeParse({ ...input, program_id: program }).success).toBe(
      false,
    );
    const terms = input.terms.map((term) =>
      term.consent_type === 'care' ? { ...term, scope_id: program } : term,
    );
    expect(
      CarePolicyProposalSchema.safeParse({ ...input, program_id: program, terms }).success,
    ).toBe(true);
  });

  it.each(['marketing', 'research', 'anonymized_analytics', 'pharmacy_sharing'])(
    'does not admit unrelated %s data use through the initial care consent contract',
    (scope_id) => {
      const input = proposal();
      const terms = input.terms.map((term) =>
        term.consent_type === 'data_use' ? { ...term, scope_id } : term,
      );
      expect(CarePolicyProposalSchema.safeParse({ ...input, terms }).success).toBe(false);
    },
  );

  it('does not let an operator turn an optional data-use term into a required care gate', () => {
    const input = proposal();
    const terms = input.terms.map((term) => ({ ...term, required: true }));
    expect(CarePolicyProposalSchema.safeParse({ ...input, terms }).success).toBe(false);
  });

  it('requires an explicit consistent jurisdictional review even when no extra terms apply', () => {
    const input = proposal();
    expect(
      CarePolicyProposalSchema.safeParse({ ...input, jurisdictional_review: undefined }).success,
    ).toBe(false);
    expect(
      CarePolicyProposalSchema.safeParse({
        ...input,
        jurisdictional_review: {
          ...input.jurisdictional_review,
          conclusion: 'requirements_listed',
        },
      }).success,
    ).toBe(false);
    const terms = [
      ...input.terms,
      {
        ...copy,
        key: 'jurisdiction',
        consent_type: 'jurisdictional',
        scope_id: 'test_reporting',
        regulatory_reference: 'Synthetic reference',
      },
    ];
    expect(CarePolicyProposalSchema.safeParse({ ...input, terms }).success).toBe(false);
    const policy = CarePolicyProposalSchema.parse({
      ...input,
      terms,
      jurisdictional_review: { ...input.jurisdictional_review, conclusion: 'requirements_listed' },
    });
    const choices = decisions(policy);
    choices.choices.push({ term_key: 'jurisdiction', accepted: false });
    expect(evaluateCareConsentChoices(policy, choices).required_care_accepted).toBe(false);
  });

  it('rejects duplicate term keys and same-type/scope aliases', () => {
    const input = proposal();
    expect(
      CarePolicyProposalSchema.safeParse({ ...input, terms: [...input.terms, input.terms[2]] })
        .success,
    ).toBe(false);
    expect(
      CarePolicyProposalSchema.safeParse({
        ...input,
        terms: [...input.terms, { ...input.terms[2], key: 'another_ai' }],
      }).success,
    ).toBe(false);
  });

  it.each(['platform', 'care'])('requires exactly one %s term', (type) => {
    const input = proposal();
    expect(
      CarePolicyProposalSchema.safeParse({
        ...input,
        terms: input.terms.filter((term) => term.consent_type !== type),
      }).success,
    ).toBe(false);
  });

  it('bounds actual UTF-8 bytes rather than only JavaScript string length', () => {
    const input = proposal();
    const terms = input.terms.map((term) => ({
      ...term,
      sections: Array.from({ length: 8 }, () => ({
        heading: 'Synthetic',
        body: '🧪'.repeat(2500),
      })),
    }));
    expect(CarePolicyProposalSchema.safeParse({ ...input, terms }).success).toBe(false);
  });

  it('rejects blank copy and control characters', () => {
    const input = proposal();
    for (const summary of ['   ', 'copy\u0000suffix']) {
      expect(
        CarePolicyProposalSchema.safeParse({
          ...input,
          terms: input.terms.map((term) => ({ ...term, summary })),
        }).success,
      ).toBe(false);
    }
  });

  it('requires deliberate development status and rejects unrecognized metadata', () => {
    const input = proposal();
    expect(
      CarePolicyProposalSchema.safeParse({ ...input, development_only: undefined }).success,
    ).toBe(false);
    expect(CarePolicyProposalSchema.safeParse({ ...input, approved: true }).success).toBe(false);
  });

  it('hashes displayed characters, order, locale, scope, development flag and review reference', () => {
    const input = proposal();
    const baseline = hashCarePolicy(input);
    const variants = [
      { ...input, locale: 'en-US' },
      { ...input, country_of_care: 'US' },
      { ...input, development_only: false },
      { ...input, terms: [...input.terms].reverse() },
      { ...input, terms: input.terms.map((term) => ({ ...term, summary: `${term.summary} ` })) },
      {
        ...input,
        jurisdictional_review: {
          ...input.jurisdictional_review,
          artifact_reference: 'new-reference',
        },
      },
    ];
    for (const variant of variants) expect(hashCarePolicy(variant)).not.toBe(baseline);
    expect(hashCarePolicy(Object.fromEntries(Object.entries(input).reverse()))).toBe(baseline);
  });

  it('rejects stale displayed policy content before accepting a choice', () => {
    const policy = CarePolicyProposalSchema.parse(proposal());
    const choices = decisions(policy);
    policy.terms[0]!.summary += ' Revised';
    expect(() => evaluateCareConsentChoices(policy, choices)).toThrow('consent.policy_changed');
  });

  it.each(['omitted', 'duplicate', 'unknown'])(
    'rejects %s choices without silently inferring consent',
    (fault) => {
      const policy = CarePolicyProposalSchema.parse(proposal());
      const input = decisions(policy);
      if (fault === 'omitted') input.choices.pop();
      if (fault === 'duplicate') input.choices[2] = { ...input.choices[1]! };
      if (fault === 'unknown') input.choices[2] = { term_key: 'unseen', accepted: true };
      expect(() => evaluateCareConsentChoices(policy, input)).toThrow('consent.invalid_choices');
    },
  );

  it('maps choices by exact key, regardless of request order', () => {
    const policy = CarePolicyProposalSchema.parse(proposal());
    const input = decisions(policy);
    input.choices.reverse();
    expect(
      evaluateCareConsentChoices(policy, input).decisions.map((term) => term.accepted),
    ).toEqual([true, true, false]);
  });

  it.each(['evidence', 'expires_at', 'account_id', 'tenant_id'])(
    'rejects caller-supplied %s',
    (field) => {
      const input = decisions(proposal());
      expect(
        CareConsentChoicesSchema.safeParse({ ...input, [field]: 'caller-selected' }).success,
      ).toBe(false);
    },
  );

  it.each([1, 'true', null])('does not coerce %j into affirmation', (accepted) => {
    const input = decisions(proposal());
    const choices = input.choices.map((choice) => ({ ...choice, accepted }));
    expect(CareConsentChoicesSchema.safeParse({ ...input, choices }).success).toBe(false);
  });
});
