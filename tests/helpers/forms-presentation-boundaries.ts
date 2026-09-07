import type { ConsultPresentation } from '../../src/modules/forms-intake/internal/services/consult-definition.js';

/** Identical examples exercise SQL creation/publication and the runtime parser. */
export function presentationTextBoundaries(country: 'US' | 'GH') {
  return [
    ['title', 200],
    ['description', 1000],
    ['label', 200],
    ['help_text', 500],
    ['option', 100],
    ['element', 1000],
  ].flatMap(([name, bound]) => {
    const limit = Number(bound);
    return [
      'a'.repeat(limit),
      'a'.repeat(limit + 1),
      '\u{1f33f}'.repeat(limit / 2),
      '\u{1f33f}'.repeat(limit / 2) + 'a',
      'a\u0301'.repeat(limit / 2),
    ].map((text) => {
      const presentation: ConsultPresentation = {
        contract_version: 'consult_intake_v1',
        kind: 'program',
        locale: `en-${country}`,
        title: 'Synthetic text boundary',
        fields: [
          {
            id: 'choice',
            type: 'select',
            label: 'Choose',
            required: true,
            options: [
              { value: 'first', label: 'First' },
              { value: 'second', label: 'Second' },
            ],
          },
        ],
        elements: [{ copy_classification: 'program_level', text: 'Synthetic program information' }],
      };
      const field = presentation.fields[0]!;
      if (name === 'title') presentation.title = text;
      else if (name === 'description') presentation.description = text;
      else if (name === 'label') field.label = text;
      else if (name === 'help_text') field.help_text = text;
      else if (name === 'option' && field.type === 'select') field.options[0]!.label = text;
      else if (name === 'element')
        presentation.elements = [{ copy_classification: 'program_level', text }];
      return { name, limit, units: text.length, valid: text.length <= limit, presentation };
    });
  });
}
