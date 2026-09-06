/**
 * Local regex component for PII spec Layer 4. The clinical resolver supplies
 * the required tenant binding and durable decision recorder around this scan.
 *
 * No NER or network imports. Names and prose addresses remain outside the
 * regex library's coverage; this component does not lift the Day-0 NER gate.
 */
import { createHash } from 'node:crypto';

import { isLuhnValid, PII_PATTERNS } from '../../../../lib/pii-screener/patterns.js';

import type { ActiveLLMWorkloadType, LLMCompletionRequest, LLMMessage } from './types.js';

export const VENDOR_REDACTION_TOKEN = '[REDACTED:PII]';
// Replacements can expose a previously hidden word boundary. Bound the work
// if a future pattern repeatedly matches our own token; exhaustion fails closed.
const MAX_SCREENING_PASSES = 16;
// Bump when screening/serialization semantics or validator dependencies change.
// Current regexes, validators and their Luhn helper are included below too.
const SCREENING_VERSION = 'layer4-v1';

export interface VendorRequestScope {
  readonly tenantId: string;
  readonly workloadType: ActiveLLMWorkloadType;
  readonly model?: string;
}

interface ScreeningSummary {
  /** Library identifiers only; never candidate strings or matched values. */
  readonly patternIds: readonly string[];
  readonly hitCount: number;
  /** Internal retry identity only. Never persist this value in an audit row. */
  readonly candidateFingerprint: string | null;
}

export type VendorScreeningResult = ScreeningSummary &
  (
    | { action: 'block'; reason: 'high_confidence_match' | 'screening_failed' }
    | { action: 'pass' | 'redact'; request: LLMCompletionRequest }
  );

// Adding a request field must force an explicit screening decision at build
// time. Runtime extensions are rejected until that decision is implemented.
const REQUEST_FIELDS = {
  workload_type: true,
  messages: true,
  max_output_tokens: true,
  temperature: true,
  tenant_id: true,
} satisfies Record<keyof LLMCompletionRequest, true>;

const MESSAGE_FIELDS = { role: true, content: true } satisfies Record<keyof LLMMessage, true>;

/** Copy only data properties, rejecting accessors and unrecognized fields. */
function fields(value: unknown, expected: object): Record<string, unknown> {
  if (value === null || typeof value !== 'object') throw new Error('invalid shape');
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error('invalid shape');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== Object.keys(expected).length) throw new Error('invalid shape');
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string' || !Object.hasOwn(expected, key)) throw new Error('invalid shape');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) throw new Error('invalid shape');
    result[key] = descriptor.value as unknown;
  }
  return result;
}

/**
 * Inspect the current provider request shape, including the exact system
 * concatenation used by Anthropic. Return a fresh request only when sendable;
 * blocked results deliberately have no payload, matches, or error messages.
 * The caller still owes durable audit and must honor action before dispatch.
 */
export function screenVendorRequest(
  request: LLMCompletionRequest,
  scope?: VendorRequestScope,
): VendorScreeningResult {
  try {
    const input = fields(request, REQUEST_FIELDS);
    if (
      (input.workload_type !== 'conversational_assistant' &&
        input.workload_type !== 'protocol_execution') ||
      typeof input.tenant_id !== 'string' ||
      typeof input.max_output_tokens !== 'number' ||
      !Number.isSafeInteger(input.max_output_tokens) ||
      input.max_output_tokens <= 0 ||
      typeof input.temperature !== 'number' ||
      !Number.isFinite(input.temperature) ||
      input.temperature < 0 ||
      input.temperature > 1 ||
      (scope !== undefined &&
        (input.tenant_id !== scope.tenantId || input.workload_type !== scope.workloadType)) ||
      !Array.isArray(input.messages)
    ) {
      throw new Error('invalid shape');
    }

    const systems: string[] = [];
    const messages: LLMMessage[] = [];
    for (const candidate of input.messages as unknown[]) {
      const message = fields(candidate, MESSAGE_FIELDS);
      if (
        (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') ||
        typeof message.content !== 'string'
      ) {
        throw new Error('invalid shape');
      }
      if (message.role === 'system') systems.push(message.content);
      else messages.push({ role: message.role, content: message.content });
    }
    // The adapter joins system messages with two newlines. Checking them
    // individually misses context-bound patterns spanning that separator.
    if (systems.length > 0) messages.unshift({ role: 'system', content: systems.join('\n\n') });

    // Only serialize freshly constructed data from the validated snapshot.
    // Serializing the raw caller object could invoke getters/toJSON or include
    // unsupported candidate-bearing fields. The digest remains internal to the
    // marker key; provider and decision metadata are added by the recorder.
    const candidateFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          version: SCREENING_VERSION,
          luhnValidator: isLuhnValid.toString(),
          model: scope?.model ?? null,
          rules: PII_PATTERNS.map((pattern) => [
            pattern.id,
            pattern.confidence,
            pattern.regex.source,
            pattern.regex.flags,
            pattern.validate?.toString() ?? null,
          ]),
          tenant: input.tenant_id,
          workload: input.workload_type,
          maxTokens: input.max_output_tokens,
          temperature: input.temperature,
          messages,
        }),
      )
      .digest('hex');

    const patternIds = new Set<string>();
    let hitCount = 0;
    let highConfidence = false;
    let sanitized = messages;
    for (let pass = 0; pass < MAX_SCREENING_PASSES; pass++) {
      let passHits = 0;
      sanitized = sanitized.map((message): LLMMessage => {
        const spans: { start: number; end: number }[] = [];
        for (const pattern of PII_PATTERNS) {
          // A fresh regex keeps concurrent/repeated calls independent of the
          // shared library's lastIndex. All patterns inspect original text,
          // so a low-confidence replacement cannot hide a high-confidence hit.
          const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
          for (const match of message.content.matchAll(regex)) {
            if (pattern.validate && !pattern.validate(match[0])) continue;
            patternIds.add(pattern.id);
            hitCount++;
            passHits++;
            if (pattern.confidence === 'high_confidence') highConfidence = true;
            spans.push({ start: match.index, end: match.index + match[0].length });
          }
        }
        // Merge overlapping intervals before replacing. IPv4-mapped IPv6 can
        // match both network patterns; replacing twice corrupts the token.
        spans.sort((a, b) => a.start - b.start || b.end - a.end);
        const merged: { start: number; end: number }[] = [];
        for (const span of spans) {
          const previous = merged[merged.length - 1];
          if (previous && span.start < previous.end)
            previous.end = Math.max(previous.end, span.end);
          else merged.push({ ...span });
        }
        let cursor = 0;
        let content = '';
        for (const span of merged) {
          content += message.content.slice(cursor, span.start) + VENDOR_REDACTION_TOKEN;
          cursor = span.end;
        }
        content += message.content.slice(cursor);
        return { role: message.role, content };
      });

      const summary = { patternIds: [...patternIds].sort(), hitCount, candidateFingerprint };
      if (highConfidence) return { ...summary, action: 'block', reason: 'high_confidence_match' };
      // Only release content after a complete pass finds no accepted match.
      // For example, replacing ::1 in ::1MRN 543210 exposes a high-confidence
      // identifier; replacing ::1 in ::1passport no. AB1234567 exposes a low one.
      if (passHits === 0)
        return {
          ...summary,
          action: hitCount > 0 ? 'redact' : 'pass',
          request: {
            workload_type: input.workload_type,
            tenant_id: input.tenant_id,
            max_output_tokens: input.max_output_tokens,
            temperature: input.temperature,
            messages: sanitized,
          },
        };
    }
    throw new Error('screening did not converge');
  } catch {
    // Never expose a validator/getter/shape failure's candidate-bearing text.
    return {
      action: 'block',
      reason: 'screening_failed',
      patternIds: [],
      hitCount: 0,
      candidateFingerprint: null,
    };
  }
}
