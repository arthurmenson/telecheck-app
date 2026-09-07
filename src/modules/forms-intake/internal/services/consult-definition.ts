import { z } from 'zod';

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import type { DbClient } from '../../../../lib/db.js';
import type { TenantId } from '../../../../lib/glossary.js';
import { withTenantContext } from '../../../../lib/rls.js';

// Reject raw control characters without interpreting caller-provided patterns.
// eslint-disable-next-line no-control-regex
const forbiddenControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u;
const id = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
// Publication SQL uses the same UTF-16 unit count, including supplementary text.
const safeText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !/[<>]/u.test(s) && !forbiddenControls.test(s));
const condition = z
  .object({ field_id: id, equals: z.union([z.boolean(), z.string().max(100)]) })
  .strict();
const base = {
  id,
  label: safeText(200),
  help_text: safeText(500).optional(),
  required: z.boolean(),
  visible_when: condition.optional(),
};
const option = z.object({ value: id, label: safeText(100) }).strict();
export const ConsultFieldSchema = z.discriminatedUnion('type', [
  z
    .object({ ...base, type: z.literal('text'), max_length: z.number().int().min(1).max(4000) })
    .strict(),
  z.object({ ...base, type: z.literal('boolean') }).strict(),
  z
    .object({
      ...base,
      type: z.literal('number'),
      min: z.number().finite().min(-1e15).max(1e15),
      max: z.number().finite().min(-1e15).max(1e15),
    })
    .strict(),
  z
    .object({ ...base, type: z.literal('select'), options: z.array(option).min(2).max(32) })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('multiselect'),
      options: z.array(option).min(2).max(32),
      max_selections: z.number().int().min(1).max(32),
    })
    .strict(),
]);
export type ConsultIntakeField = z.infer<typeof ConsultFieldSchema>;

/** Closed vocabulary: there is no expression interpreter or arbitrary HTML. */
export const ConsultPresentationSchema = z
  .object({
    contract_version: z.literal('consult_intake_v1'),
    kind: z.enum(['general_consult', 'program']),
    locale: z.enum(['en-US', 'en-GH']),
    title: safeText(200),
    description: safeText(1000).optional(),
    fields: z.array(ConsultFieldSchema).min(1).max(64),
    elements: z
      .array(
        z.discriminatedUnion('copy_classification', [
          z
            .object({ copy_classification: z.literal('program_level'), text: safeText(1000) })
            .strict(),
          z
            .object({
              copy_classification: z.literal('molecule_level'),
              marketing_copy_id: z.uuid(),
              content_hash: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .strict(),
        ]),
      )
      .max(16),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Map<string, ConsultIntakeField>();
    value.fields.forEach((field, index) => {
      const invalid = (message: string) =>
        context.addIssue({ code: 'custom', path: ['fields', index], message });
      if (seen.has(field.id) || /research|consent/iu.test(field.id))
        invalid('Field identifiers must be unique and cannot represent consent state.');
      if (field.type === 'number' && field.min > field.max) invalid('Invalid number range.');
      if (
        'options' in field &&
        new Set(field.options.map((o) => o.value)).size !== field.options.length
      )
        invalid('Option values must be unique.');
      if (field.type === 'multiselect' && field.max_selections > field.options.length)
        invalid('Invalid selection limit.');
      if (field.visible_when !== undefined) {
        const source = seen.get(field.visible_when.field_id);
        // One-way references to earlier unconditional fields prevent cycles and hidden chains.
        if (
          source === undefined ||
          source.visible_when !== undefined ||
          !(
            (source.type === 'boolean' && typeof field.visible_when.equals === 'boolean') ||
            (source.type === 'select' &&
              source.options.some((o) => o.value === field.visible_when?.equals))
          )
        ) {
          invalid('Conditions must reference a prior unconditional boolean or select field.');
        }
      }
      seen.set(field.id, field);
    });
  });

export type ConsultPresentation = z.infer<typeof ConsultPresentationSchema>;
export interface ConsultIntakeDefinition {
  template_id: string;
  template_version: number;
  deployment_id: string;
  program_id: string;
  country_of_care: 'US' | 'GH';
  schema_hash: string;
  development_only: boolean;
  presentation: ConsultPresentation;
}
export interface ConsultDefinitionContext {
  tenantId: TenantId;
  accountId: string;
  sessionId: string;
  actorNonce: string;
  countryOfCare: 'US' | 'GH';
}
export interface ConsultDefinitionSelection {
  deploymentId?: string;
  kind: 'general_consult' | 'program';
  programId?: string;
  /** Set only from the consult's persisted binding, never a client-supplied flag. */
  existingBinding?: boolean;
}
export class ConsultDefinitionError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code:
      | 'forms.definition_unavailable'
      | 'forms.definition_restart_required'
      | 'forms.invalid_answers',
    statusCode = 400,
  ) {
    super(code);
    this.statusCode = statusCode;
  }
}

/** Public contract fetch. SQL authenticates the real actor, session and tenant. */
export async function resolveConsultIntakeDefinition(
  tx: DbClient,
  context: ConsultDefinitionContext,
  selection: ConsultDefinitionSelection,
): Promise<ConsultIntakeDefinition> {
  return withTenantContext(tx, context.tenantId, () =>
    withActorContext(tx, context.actorNonce, async () => {
      const result = await tx
        .query<{
          definition: ConsultIntakeDefinition;
        }>('SELECT public.forms_resolve_consult_definition($1, $2, $3, $4, $5, $6) AS definition', [
          context.accountId,
          context.sessionId,
          selection.deploymentId ?? null,
          selection.kind,
          selection.programId ?? null,
          selection.existingBinding ?? false,
        ])
        .catch((error: unknown) => {
          if ((error as { code?: string })?.code === '02000' && selection.existingBinding)
            throw new ConsultDefinitionError('forms.definition_restart_required', 409);
          throw error;
        });
      const definition = result.rows[0]?.definition;
      if (!definition || definition.country_of_care !== context.countryOfCare)
        throw new ConsultDefinitionError('forms.definition_unavailable', 404);
      if (definition.development_only && process.env['NODE_ENV'] === 'production')
        throw new ConsultDefinitionError('forms.definition_unavailable', 404);
      const parsed = ConsultPresentationSchema.safeParse(definition.presentation);
      if (!parsed.success) throw new ConsultDefinitionError('forms.definition_unavailable', 409);
      return { ...definition, presentation: parsed.data };
    }),
  );
}

export type ConsultIntakeAnswers = Record<string, string | number | boolean | string[]>;

/** No persistence: the care owner encrypts the returned bounded answers exactly once. */
export function validateAnswers(
  definition: ConsultPresentation,
  answers: unknown,
  mode: 'draft' | 'submit',
): ConsultIntakeAnswers {
  if (
    answers === null ||
    typeof answers !== 'object' ||
    Array.isArray(answers) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(answers) as object | null)
  )
    throw new ConsultDefinitionError('forms.invalid_answers');
  const entries = Object.entries(answers);
  if (entries.length > 64) throw new ConsultDefinitionError('forms.invalid_answers');
  const fields = new Map(definition.fields.map((field) => [field.id, field]));
  const clean: ConsultIntakeAnswers = Object.create(null) as ConsultIntakeAnswers;
  let characters = 0;
  for (const [key, value] of entries) {
    const field = fields.get(key);
    if (field === undefined) throw new ConsultDefinitionError('forms.invalid_answers');
    let valid = false;
    switch (field.type) {
      case 'text':
        valid =
          typeof value === 'string' &&
          value.length <= field.max_length &&
          !forbiddenControls.test(value);
        break;
      case 'boolean':
        valid = typeof value === 'boolean';
        break;
      case 'number':
        valid =
          typeof value === 'number' &&
          Number.isFinite(value) &&
          value >= field.min &&
          value <= field.max;
        break;
      case 'select':
        valid = typeof value === 'string' && field.options.some((o) => o.value === value);
        break;
      case 'multiselect':
        valid =
          Array.isArray(value) &&
          value.length <= field.max_selections &&
          new Set(value).size === value.length &&
          value.every(
            (item) => typeof item === 'string' && field.options.some((o) => o.value === item),
          );
        break;
    }
    if (!valid) throw new ConsultDefinitionError('forms.invalid_answers');
    const admitted = value as string | number | boolean | string[];
    if (typeof admitted === 'string') characters += admitted.length;
    else if (Array.isArray(admitted))
      characters += admitted.reduce((total, item) => total + item.length, 0);
    if (characters > 16_000) throw new ConsultDefinitionError('forms.invalid_answers');
    clean[key] = Array.isArray(admitted) ? [...admitted] : admitted;
  }
  for (const field of definition.fields) {
    const visible =
      field.visible_when === undefined ||
      clean[field.visible_when.field_id] === field.visible_when.equals;
    const value = clean[field.id];
    // Hidden stale answers are rejected, not interpreted as a negative response.
    if (!visible && value !== undefined) throw new ConsultDefinitionError('forms.invalid_answers');
    if (
      mode === 'submit' &&
      visible &&
      field.required &&
      (value === undefined ||
        (typeof value === 'string' && value.trim().length === 0) ||
        (Array.isArray(value) && value.length === 0))
    )
      throw new ConsultDefinitionError('forms.invalid_answers');
  }
  return clean;
}

export async function validateConsultIntake(
  tx: DbClient,
  context: ConsultDefinitionContext,
  binding: Pick<
    ConsultIntakeDefinition,
    'template_id' | 'template_version' | 'deployment_id' | 'schema_hash' | 'program_id'
  >,
  kind: ConsultDefinitionSelection['kind'],
  answers: unknown,
  mode: 'draft' | 'submit',
): Promise<{ definition: ConsultIntakeDefinition; answers: ConsultIntakeAnswers }> {
  const definition = await resolveConsultIntakeDefinition(tx, context, {
    deploymentId: binding.deployment_id,
    kind,
    programId: binding.program_id,
    existingBinding: true,
  });
  if (
    definition.template_id !== binding.template_id ||
    definition.template_version !== binding.template_version ||
    definition.schema_hash !== binding.schema_hash
  )
    throw new ConsultDefinitionError('forms.definition_restart_required', 409);
  return { definition, answers: validateAnswers(definition.presentation, answers, mode) };
}
