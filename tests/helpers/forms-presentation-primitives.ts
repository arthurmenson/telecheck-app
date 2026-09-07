import type { ConsultPresentation } from '../../src/modules/forms-intake/internal/services/consult-definition.js';

/** Contains every presentation container/leaf, field type and condition source type. */
export function primitivePresentation(country: 'US' | 'GH'): ConsultPresentation {
  return {
    contract_version: 'consult_intake_v1',
    kind: 'program',
    locale: `en-${country}`,
    title: 'Synthetic primitive contract',
    description: 'Synthetic description',
    fields: [
      { id: 'true', type: 'boolean', label: 'Question', help_text: 'Help', required: true },
      {
        id: 'choice',
        type: 'select',
        label: 'Choice',
        required: false,
        options: [
          { value: 'true', label: 'True' },
          { value: 'false', label: 'False' },
        ],
      },
      {
        id: 'notes',
        type: 'text',
        label: 'Notes',
        required: false,
        max_length: 200,
        visible_when: { field_id: 'true', equals: true },
      },
      { id: 'count', type: 'number', label: 'Count', required: false, min: 0, max: 100 },
      {
        id: 'many',
        type: 'multiselect',
        label: 'Many',
        required: true,
        max_selections: 2,
        options: [
          { value: 'true', label: 'True' },
          { value: 'false', label: 'False' },
        ],
      },
      {
        id: 'conditional',
        type: 'text',
        label: 'Conditional',
        required: false,
        max_length: 100,
        visible_when: { field_id: 'choice', equals: 'true' },
      },
    ],
    elements: [
      { copy_classification: 'program_level', text: 'Synthetic copy' },
      {
        copy_classification: 'molecule_level',
        marketing_copy_id: '11111111-1111-4111-8111-111111111111',
        content_hash: 'a'.repeat(64),
      },
    ],
  };
}

const replacements: [string, unknown][] = [
  ['missing', undefined],
  ['null', null],
  ['true', true],
  ['false', false],
  ['zero', 0],
  ['one', 1],
  ['negative', -1],
  ['fraction', 1.5],
  ['empty', ''],
  ['text', 'text'],
  ['true-string', 'true'],
  ['false-string', 'false'],
  ['empty-array', []],
  ['array', ['x']],
  ['empty-object', {}],
  ['object', { x: 'y' }],
];
function paths(value: unknown, prefix: string[] = []): string[][] {
  return [
    prefix,
    ...(value !== null && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, entry]) => paths(entry, [...prefix, key]))
      : []),
  ];
}
export function presentationPrimitiveMutations(country: 'US' | 'GH') {
  const original = primitivePresentation(country);
  return paths(original).flatMap((path) =>
    replacements.map(([name, value]) => {
      let presentation: unknown = structuredClone(original);
      if (path.length === 0) presentation = value;
      else {
        let node = presentation as Record<string, unknown>;
        for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
        if (value === undefined) delete node[path.at(-1)!];
        else node[path.at(-1)!] = value;
      }
      return { name: `${path.join('.') || 'root'}/${name}`, presentation };
    }),
  );
}

/** Each example formerly passed SQL creation; boolean strings are positive controls. */
export function identifierPrimitiveCases(country: 'US' | 'GH') {
  const examples: { name: string; presentation: unknown }[] = [];
  const original = primitivePresentation(country);
  for (const field of original.fields.slice(0, 5)) {
    for (const value of [true, false]) {
      const unconditional = { ...field };
      delete unconditional.visible_when;
      examples.push({
        name: `${field.type}-id-${value}`,
        presentation: {
          ...original,
          fields: [{ ...unconditional, id: value }],
          elements: [],
        },
      });
    }
  }
  for (const type of ['select', 'multiselect']) {
    for (const value of [true, false]) {
      examples.push({
        name: `${type}-option-${value}`,
        presentation: {
          ...original,
          fields: [
            {
              id: 'choice',
              type,
              label: 'Choice',
              required: true,
              ...(type === 'multiselect' ? { max_selections: 2 } : {}),
              options: [
                { value, label: 'Boolean' },
                { value: 'other', label: 'Other' },
              ],
            },
          ],
          elements: [],
        },
      });
    }
  }
  for (const value of [true, false]) {
    examples.push({
      name: `condition-source-${value}`,
      presentation: {
        ...original,
        fields: [
          { id: String(value), type: 'boolean', label: 'Question', required: true },
          {
            id: 'detail',
            type: 'text',
            label: 'Detail',
            required: false,
            max_length: 100,
            visible_when: { field_id: value, equals: true },
          },
        ],
        elements: [],
      },
    });
  }
  examples.push({
    name: 'numeric-marketing-content-hash',
    presentation: {
      ...original,
      elements: [
        {
          copy_classification: 'molecule_level',
          marketing_copy_id: '11111111-1111-4111-8111-111111111111',
          content_hash: 1e63,
        },
      ],
    },
  });
  return examples;
}
