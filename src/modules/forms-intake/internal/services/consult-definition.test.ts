import { describe, it, expect } from 'vitest';

import { presentationTextBoundaries } from '../../../../../tests/helpers/forms-presentation-boundaries.js';
import {
  identifierPrimitiveCases,
  primitivePresentation,
} from '../../../../../tests/helpers/forms-presentation-primitives.js';

import {
  ConsultPresentationSchema,
  validateAnswers,
  type ConsultPresentation,
} from './consult-definition.js';

describe('presentation identifier primitives shared with SQL acceptance', () => {
  for (const country of ['US', 'GH'] as const) {
    for (const example of identifierPrimitiveCases(country)) {
      it(`${country} rejects ${example.name}`, () => {
        expect(ConsultPresentationSchema.safeParse(example.presentation).success).toBe(false);
      });
    }
    it(`${country} retains string true/false and false/zero answers`, () => {
      const presentation = primitivePresentation(country);
      expect(ConsultPresentationSchema.safeParse(presentation).success).toBe(true);
      expect(
        validateAnswers(
          presentation,
          { true: false, count: 0, choice: 'false', many: ['true', 'false'] },
          'submit',
        ),
      ).toEqual({ true: false, count: 0, choice: 'false', many: ['true', 'false'] });
    });
  }
});

describe('presentation Unicode bounds shared with SQL acceptance', () => {
  for (const country of ['US', 'GH'] as const) {
    for (const example of presentationTextBoundaries(country)) {
      it(`${country} ${String(example.name)} accepts exactly ${example.limit} UTF-16 units: ${example.units}`, () => {
        expect(ConsultPresentationSchema.safeParse(example.presentation).success).toBe(
          example.valid,
        );
      });
    }
  }
});

const presentation: ConsultPresentation = {
  contract_version: 'consult_intake_v1',
  kind: 'general_consult',
  locale: 'en-US',
  title: 'General consultation',
  elements: [],
  fields: [
    {
      id: 'concern',
      type: 'text',
      label: 'What brings you here?',
      required: true,
      max_length: 4000,
    },
    {
      id: 'medication_recorded',
      type: 'boolean',
      label: 'Do you take medication?',
      required: true,
    },
    {
      id: 'medication_details',
      type: 'text',
      label: 'Medication details',
      required: true,
      max_length: 4000,
      visible_when: { field_id: 'medication_recorded', equals: true },
    },
    { id: 'duration', type: 'number', label: 'Days', required: false, min: 0, max: 365 },
    {
      id: 'severity',
      type: 'select',
      label: 'Severity',
      required: true,
      options: [
        { value: 'mild', label: 'Mild' },
        { value: 'moderate', label: 'Moderate' },
      ],
    },
    {
      id: 'preferences',
      type: 'multiselect',
      label: 'Preferences',
      required: false,
      max_selections: 2,
      options: [
        { value: 'morning', label: 'Morning' },
        { value: 'evening', label: 'Evening' },
      ],
    },
  ],
};
const valid = { concern: 'Persistent concern', medication_recorded: false, severity: 'mild' };

describe('published consult answer contract', () => {
  it('admits a complete typed response without coercion or persistence', () => {
    expect(ConsultPresentationSchema.parse(presentation)).toEqual(presentation);
    expect(validateAnswers(presentation, valid, 'submit')).toEqual(valid);
  });
  it('drafts allow missing required fields but preserve type constraints', () => {
    expect(validateAnswers(presentation, {}, 'draft')).toEqual({});
    expect(() => validateAnswers(presentation, { medication_recorded: 'false' }, 'draft')).toThrow(
      'forms.invalid_answers',
    );
  });
  it.each([
    ['unknown', { unknown: 'x' }],
    ['text number', { concern: 1 }],
    ['boolean string', { medication_recorded: 'false' }],
    ['number string', { duration: '1' }],
    ['nan', { duration: NaN }],
    ['infinity', { duration: Infinity }],
    ['range', { duration: -1 }],
    ['invalid option', { severity: 'unknown' }],
    ['empty required', { concern: '   ' }],
    ['duplicate selection', { preferences: ['morning', 'morning'] }],
    ['array object', { preferences: [{}] }],
    ['hidden answer', { medication_details: 'old answer' }],
    ['missing conditional', { medication_recorded: true }],
    ['oversized text', { concern: 'x'.repeat(4001) }],
    ['nested object', { concern: { text: 'x' } }],
    ['control character', { concern: '\u0000' }],
  ])('rejects %s', (_name, changes) => {
    expect(() => validateAnswers(presentation, { ...valid, ...changes }, 'submit')).toThrow(
      'forms.invalid_answers',
    );
  });
  it('accepts false and zero as recorded answers and conditional text when visible', () => {
    expect(
      validateAnswers(
        presentation,
        { ...valid, duration: 0, medication_recorded: true, medication_details: 'Details' },
        'submit',
      ),
    ).toMatchObject({ duration: 0, medication_details: 'Details' });
  });
  it('bounds total free text, including drafts', () => {
    const many = {
      ...presentation,
      fields: Array.from({ length: 5 }, (_, i) => ({
        id: `field_${i}`,
        type: 'text' as const,
        label: 'Question',
        required: false,
        max_length: 4000,
      })),
    };
    expect(() =>
      validateAnswers(
        many,
        Object.fromEntries(many.fields.map((f) => [f.id, 'x'.repeat(4000)])),
        'draft',
      ),
    ).toThrow();
  });
  it.each([
    ['unknown schema', { ...presentation, expression: 'anything' }],
    [
      'research field',
      { ...presentation, fields: [{ ...presentation.fields[0], id: 'research_consent_status' }] },
    ],
    [
      'duplicate field',
      { ...presentation, fields: [presentation.fields[0], presentation.fields[0]] },
    ],
    [
      'forward dependency',
      {
        ...presentation,
        fields: [
          {
            ...presentation.fields[0],
            visible_when: { field_id: 'medication_recorded', equals: true },
          },
          presentation.fields[1],
        ],
      },
    ],
    [
      'wrong condition type',
      {
        ...presentation,
        fields: [
          presentation.fields[1],
          {
            ...presentation.fields[2],
            visible_when: { field_id: 'medication_recorded', equals: 'true' },
          },
        ],
      },
    ],
    ['markup', { ...presentation, title: '<script>alert(1)</script>' }],
  ])('rejects publication %s', (_name, value) =>
    expect(ConsultPresentationSchema.safeParse(value).success).toBe(false),
  );
});
