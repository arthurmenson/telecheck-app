/**
 * glossary.ts — TypeScript brand types enforcing Contracts Pack v5.2 GLOSSARY.
 *
 * Purpose:
 *   Compile-time canonical vocabulary enforcement per I-014.
 *   Branded primitive types make forbidden aliases a type error at the call site.
 *   Runtime `assertCanonicalTerm()` covers places where types cannot reach
 *   (dynamic strings from external inputs, config files, DB values).
 *
 * Spec references:
 *   - I-014: canonical vocabulary is enforced; forbidden aliases listed in GLOSSARY v5.2.
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 brand-structure rules:
 *       * Operating-tenant IDs = `Telecheck-{country}` format.
 *       * Bare `Heros` as tenant/operator identifier is FORBIDDEN outside §17 carve-outs.
 *       * Patient-facing surfaces source consumer DBA from `tenant.consumer_dba`.
 *   - GLOSSARY v5.2 forbidden aliases:
 *       * `prescription` → `medication_request`
 *       * `chatbot` / `Mode 1` text in code → `conversational_assistant` discriminator
 *       * `customer` → `tenant`
 *       * Bare `Heros` as tenant ID → `Telecheck-{country}` format
 *   - WORKLOAD_TAXONOMY v5.2: `conversational_assistant`, `protocol_execution` (not `ai_mode_1`/`ai_mode_2` in new code).
 *
 * Design decisions:
 *   - Brand types use the `__brand` phantom property pattern (no runtime cost).
 *   - `assertCanonicalTerm()` throws `GlossaryViolationError` (not silently returns
 *     false) — violations must not be swallowed.
 *   - TenantId format guard validates `Telecheck-{country}` pattern at runtime.
 *
 * Open questions for Engineering Lead:
 *   - Should `MedicationRequestId` be a ULID brand only, or should it also
 *     enforce the `mrx_` prefix from TYPES v5.2 ID conventions? Currently
 *     it brands the raw ID string only; prefix validation left to DB layer.
 */

// ---------------------------------------------------------------------------
// Brand type helper
// ---------------------------------------------------------------------------

declare const __brand: unique symbol;
type Brand<T, TBrand extends string> = T & { readonly [__brand]: TBrand };

// ---------------------------------------------------------------------------
// GlossaryViolationError
// ---------------------------------------------------------------------------

export class GlossaryViolationError extends Error {
  constructor(term: string, reason: string) {
    super(`Glossary violation [I-014]: term "${term}" — ${reason}`);
    this.name = 'GlossaryViolationError';
  }
}

// ---------------------------------------------------------------------------
// Canonical branded types
// ---------------------------------------------------------------------------

/**
 * MedicationRequestId — the canonical identifier for a medication request.
 *
 * FORBIDDEN alias: `PrescriptionId`.
 * Per GLOSSARY v5.2: the entity is `medication_request`; the term `prescription`
 * is a forbidden alias in code, schemas, and APIs.
 */
export type MedicationRequestId = Brand<string, 'MedicationRequestId'>;

// There is intentionally no `PrescriptionId` export. Any code that tries to
// import `PrescriptionId` will get a compile-time error directing to this file.

/**
 * Canonical MedicationRequestId pattern: `mrx_` prefix + 26-char Crockford
 * base32 ULID (per src/lib/ulid.ts canonical alphabet 0-9A-HJKMNPQRSTVWXYZ
 * with I/L/O/U excluded).
 *
 * Tightened 2026-05-03 per Codex glossary-r0 HIGH (verify-r1): prior
 * implementation only checked the prefix, which let `mrx_` (empty
 * suffix), `mrx_not-a-ulid`, and arbitrary trailing payloads brand
 * successfully. Full validation is appropriate at the type-construction
 * boundary because invalid IDs should never cross into persistence/API
 * layers regardless of whether RLS or schema constraints would later
 * catch them.
 */
const MEDICATION_REQUEST_ID_PATTERN = /^mrx_[0-9A-HJKMNPQRSTVWXYZ]{26}$/;

/** Type constructor — validates the full mrx_<ULID> shape. */
export function asMedicationRequestId(raw: string): MedicationRequestId {
  if (!MEDICATION_REQUEST_ID_PATTERN.test(raw)) {
    throw new GlossaryViolationError(
      raw,
      'MedicationRequestId must match the canonical mrx_<26-char Crockford-base32 ULID> ' +
        'shape (TYPES v5.2 + ulid.ts canonical alphabet 0-9A-HJKMNPQRSTVWXYZ excluding I/L/O/U). ' +
        'Bare "mrx_" prefix is not sufficient.',
    );
  }
  return raw as MedicationRequestId;
}

/**
 * TenantId — operating-tenant identifier in `Telecheck-{Country}` format.
 *
 * FORBIDDEN values: bare `Heros`, `Heros-Health`, `customer`, `Heros-Ghana`.
 * Per Master PRD v1.10 §17 + Glossary v5.2 C3 brand structure.
 *
 * Valid examples: `Telecheck-US`, `Telecheck-Ghana`.
 * Patient-facing surfaces MUST source consumer DBA from `tenant.consumer_dba`,
 * never from `tenant.id`.
 */
export type TenantId = Brand<string, 'TenantId'>;

const TENANT_ID_PATTERN = /^Telecheck-[A-Z][A-Za-z]+$/;

/** Runtime-validated TenantId constructor. Throws on format violation. */
export function asTenantId(raw: string): TenantId {
  if (!TENANT_ID_PATTERN.test(raw)) {
    throw new GlossaryViolationError(
      raw,
      'TenantId must match Telecheck-{Country} format (e.g. Telecheck-US, Telecheck-Ghana). ' +
        'Bare "Heros" identifiers and customer/customer-id formats are forbidden per Master PRD §17.',
    );
  }
  // Additional forbidden-alias guard
  const lower = raw.toLowerCase();
  if (lower === 'heros' || lower === 'heros-health' || lower === 'customer') {
    throw new GlossaryViolationError(
      raw,
      'Bare "Heros", "Heros-Health", and "customer" are forbidden tenant identifiers per Glossary v5.2.',
    );
  }
  return raw as TenantId;
}

/**
 * Mode1 / Mode2 — canonical labels for AI modes.
 *
 * FORBIDDEN alias in code: `chatbot`.
 * In audit/schema/code these are: `conversational_assistant` (Mode 1), `protocol_execution` (Mode 2).
 * The human-readable "Mode 1" / "Mode 2" labels are allowed in operator-facing copy.
 *
 * These types represent the canonical discriminator values, not human-readable labels.
 */
export type Mode1WorkloadType = 'conversational_assistant';
export type Mode2WorkloadType = 'protocol_execution';
export type AIWorkloadType =
  | Mode1WorkloadType
  | Mode2WorkloadType
  | 'autonomous_agent' // RESERVED per WORKLOAD_TAXONOMY v5.2 §3.1
  | 'multi_agent_supervisor' // RESERVED per WORKLOAD_TAXONOMY v5.2 §3.2
  | 'tool_using_agent' // RESERVED per WORKLOAD_TAXONOMY v5.2 §3.3
  | 'rejected_invalid_attempt' // SENTINEL — audit envelope only on *.execution_rejected events
  | 'n/a'; // SENTINEL — I-012 clinician-only approval records only

export type AutonomyLevel =
  | 'advisory' // active at v1.0
  | 'suggestion' // active at v1.0
  | 'action_with_confirm' // active at v1.0
  | 'action_with_audit_only' // RESERVED — requires ADR-030
  | 'fully_autonomous' // RESERVED — requires ADR-030 + I-012 successor
  | 'rejected_invalid_attempt' // SENTINEL — audit envelope only on *.execution_rejected
  | 'n/a'; // SENTINEL — I-012 clinician-only approval records only

// ---------------------------------------------------------------------------
// Forbidden-alias detection helper (compile-time)
// ---------------------------------------------------------------------------

/**
 * ForbiddenAlias<T> — produces `never` for any forbidden string literal,
 * making it a compile-time error to use.
 *
 * Usage in type-level assertions:
 *   type _Check = ForbiddenAlias<'prescription'>; // → never → compile error if used
 */
type ForbiddenAliases =
  | 'prescription'
  | 'PrescriptionId'
  | 'chatbot'
  | 'customer'
  | 'Heros'
  | 'Heros-Health';

export type ForbiddenAlias<T extends string> = T extends ForbiddenAliases ? never : T;

// ---------------------------------------------------------------------------
// Runtime assertCanonicalTerm — for dynamic strings types cannot validate
// ---------------------------------------------------------------------------

// Runtime forbidden-alias set. Every entry must also have a coverage row
// in tests/integration/glossary.test.ts so a future addition trips the
// test suite if anyone forgets to extend the matching test inventory.
//
// Tightened 2026-05-03 per Codex glossary-r0 MED (verify-r1):
//   - Added `heros-ghana` — bare "Heros" + country-suffix forms are
//     documented as forbidden in the asTenantId JSDoc above; the runtime
//     alias check should mirror the docstring.
//
// SPEC ISSUE candidate: Codex r0 also flagged that the canonical glossary
// in the spec corpus lists additional forbidden aliases (renewal /
// reorder / re-prescription on the medication-action axis;
// auto-approved / automated-prescription / AI-prescribed on the
// AI-vs-clinician axis). Those need verification against the
// authoritative `Telecheck_Contracts_Pack_v5_00_GLOSSARY.md` text in
// the spec corpus before adding here — pinned for follow-up; the test
// suite documents the gap.
const FORBIDDEN_RUNTIME_ALIASES: ReadonlySet<string> = new Set([
  'prescription',
  'prescriptionid',
  'chatbot',
  'customer',
  'heros', // bare Heros (case-insensitive check below)
  'heros-health',
  'heros-ghana', // bare "Heros-Ghana" — operating-tenant slot must use Telecheck-Ghana
  'ai_mode_1', // deprecated actor_type alias — new code MUST use actor_type=ai_workload
  'ai_mode_2', // deprecated actor_type alias — new code MUST use actor_type=ai_workload
]);

/**
 * assertCanonicalTerm — runtime invariant check for places types cannot reach.
 *
 * Throws `GlossaryViolationError` if `term` (case-insensitive) is a forbidden
 * alias per Glossary v5.2.
 *
 * Does NOT check all possible violations — use for dynamic inputs at trust
 * boundaries (user-supplied strings, external API fields, config values).
 */
export function assertCanonicalTerm(term: string, context?: string): void {
  if (FORBIDDEN_RUNTIME_ALIASES.has(term.toLowerCase())) {
    throw new GlossaryViolationError(
      term,
      `Forbidden alias detected${context ? ` in ${context}` : ''}. ` +
        'See Contracts Pack v5.2 GLOSSARY for canonical replacements.',
    );
  }
}

/**
 * isTenantIdFormat — non-throwing format check (useful in guards/validators).
 */
export function isTenantIdFormat(value: string): boolean {
  return TENANT_ID_PATTERN.test(value);
}
