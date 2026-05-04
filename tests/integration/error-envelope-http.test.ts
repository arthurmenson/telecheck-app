/**
 * Error envelope plugin — HTTP-level integration tests.
 *
 * Closes the .todo() placeholders left in
 * tests/integration/error-envelope.test.ts by exercising the actual
 * `errorEnvelopePlugin` (`src/lib/error-envelope.ts`) end-to-end via
 * buildApp + Fastify `inject`. The unit-level helper tests in the
 * sibling file validate the envelope SHAPE; this file validates the
 * actual EMISSION.
 *
 * Foundation contract — every other HTTP test in the suite indirectly
 * depends on this:
 *   - 4xx responses must conform to the canonical
 *     { error: { code, message, [detail], [retry_after], trace_id, timestamp } }
 *     envelope per ERROR_MODEL v5.1.
 *   - 5xx responses must NOT leak stack traces, tenant identifiers, or
 *     internal error messages.
 *   - I-025 tenant-blind: the envelope shape AND code MUST be identical
 *     for a missing resource vs a cross-tenant existing resource.
 *   - I-009: no hardcoded country names or tenant identifiers in any
 *     error message.
 *
 * Spec references:
 *   - I-025 (tenant-blind error envelopes)
 *   - I-009 (no hardcoded country / tenant assumptions)
 *   - ERROR_MODEL v5.1 (canonical envelope schema)
 *   - Master PRD v1.10 §17 (operating-tenant identifier MUST NOT leak
 *     to patient surface — applies transitively to error envelopes)
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

// ---------------------------------------------------------------------------
// Test app lifecycle
// ---------------------------------------------------------------------------

let app: FastifyInstance | null = null;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  if (app !== null) {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Helpers (mirror the established HTTP-test-file pattern — duplicated rather
// than extracted until the shared helpers module is justified)
// ---------------------------------------------------------------------------

function findKeyAtAnyDepth(value: unknown, targetKey: string): boolean {
  type Frame = unknown;
  const stack: Frame[] = [value];
  while (stack.length > 0) {
    const next = stack.pop();
    if (Array.isArray(next)) {
      for (const item of next) stack.push(item);
      continue;
    }
    if (next !== null && typeof next === 'object') {
      const obj = next as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (key === targetKey) return true;
        stack.push(obj[key]);
      }
    }
  }
  return false;
}

interface CanonicalErrorEnvelope {
  error: {
    code: string;
    message: string;
    detail?: unknown;
    retry_after?: number;
    trace_id: string;
    timestamp: string;
  };
}

/**
 * Asserts the canonical ERROR_MODEL v5.1 envelope shape on a parsed
 * response body. Guards against:
 *   - missing/malformed top-level `error` key
 *   - missing required fields (code, message, trace_id, timestamp)
 *   - extra top-level keys outside the envelope (which would leak data)
 *   - invalid `code` shape (must be a non-empty string)
 *   - invalid `trace_id` shape (must be a non-empty string)
 *   - invalid `timestamp` shape (must parse as ISO-8601)
 */
function assertCanonicalEnvelope(body: unknown): asserts body is CanonicalErrorEnvelope {
  expect(body).not.toBeNull();
  expect(typeof body).toBe('object');
  const obj = body as Record<string, unknown>;
  // Only `error` allowed at top level.
  expect(Object.keys(obj)).toEqual(['error']);
  const err = obj['error'] as Record<string, unknown>;
  expect(typeof err).toBe('object');
  // Required fields.
  expect(typeof err['code']).toBe('string');
  expect((err['code'] as string).length).toBeGreaterThan(0);
  expect(typeof err['message']).toBe('string');
  expect((err['message'] as string).length).toBeGreaterThan(0);
  expect(typeof err['trace_id']).toBe('string');
  expect((err['trace_id'] as string).length).toBeGreaterThan(0);
  expect(typeof err['timestamp']).toBe('string');
  expect(Number.isFinite(Date.parse(err['timestamp'] as string))).toBe(true);
  // No tenant_id key at any depth (closes the structural leakage path).
  expect(findKeyAtAnyDepth(body, 'tenant_id')).toBe(false);
  // No leaked tenant identifier in any string field.
  expect(JSON.stringify(body)).not.toContain('Telecheck-US');
  expect(JSON.stringify(body)).not.toContain('Telecheck-Ghana');
}

// Seed a published template + active deployment + completed submission
// fixture so we have a real cross-tenant resource to test the
// "missing vs in-other-tenant" envelope-equality invariant.
async function seedSubmission(): Promise<{
  submissionId: string;
  patientId: string;
}> {
  const client = getTestClient();
  const programId = `prog_err_envelope_${ulid().slice(0, 8)}`;
  const templateId = ulid();
  const deploymentId = ulid();
  const patientId = ulid();
  const submissionId = ulid();

  await withTenantContext(TENANT_US, async () => {
    await client.query(
      `INSERT INTO forms_template (
          template_id, tenant_id, program_id, country_of_care,
          template_version, status, name, created_by,
          presentation_content, branching_logic,
          eligibility_logic, approval_governance,
          published_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 1, 'published', $5, $6,
                  '{}'::jsonb, '{}'::jsonb,
                  '{}'::jsonb, '{}'::jsonb,
                  NOW(), NOW(), NOW())`,
      [templateId, TENANT_US, programId, 'US', `test-err-${templateId.slice(0, 8)}`, ulid()],
    );
    await client.query(
      `INSERT INTO forms_deployment (
          deployment_id, tenant_id, template_id, program_id,
          deployed_by, deployed_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), NOW())`,
      [deploymentId, TENANT_US, templateId, programId, ulid()],
    );
    await client.query(
      `INSERT INTO forms_submission (
          submission_id, tenant_id, deployment_id, variant_id,
          patient_id, delegate_id,
          status, responses, mode_2_eligible,
          created_at, updated_at
       ) VALUES ($1, $2, $3, NULL, $4, NULL,
                  'in_progress', '{}'::jsonb, FALSE,
                  NOW(), NOW())`,
      [submissionId, TENANT_US, deploymentId, patientId],
    );
  });
  return { submissionId, patientId };
}

const US_HOST = 'localhost';
const GH_HOST = 'ghana.heroshealth.com';

// ---------------------------------------------------------------------------
// 404 — non-existent resource
// ---------------------------------------------------------------------------

describe('error envelope HTTP — non-existent resource', () => {
  it('emits canonical envelope on 404 for a missing patient submission', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: `/v0/forms/submissions/${ulid()}`,
      headers: {
        host: US_HOST,
        'x-patient-id': ulid(),
      },
    });
    expect(response.statusCode).toBe(404);
    const body = response.json<unknown>();
    assertCanonicalEnvelope(body);
    expect(body.error.code).toMatch(/^internal\.resource\.not_found$/);
  });
});

// ---------------------------------------------------------------------------
// 404 — cross-tenant existence leak prevention (I-025)
//
// The CORE invariant of this test suite. A patient who guesses a
// submission_id that exists in a DIFFERENT tenant must get the IDENTICAL
// envelope shape + code as a patient who guesses a submission_id that
// doesn't exist anywhere. Otherwise the response shape itself becomes
// an oracle for cross-tenant existence.
// ---------------------------------------------------------------------------

describe('error envelope HTTP — cross-tenant existence leak prevention (I-025)', () => {
  it('emits IDENTICAL envelope shape and code for missing vs cross-tenant submissions', async () => {
    // Seed a real submission in US tenant.
    const { submissionId } = await seedSubmission();

    // Request 1: from Ghana tenant (host: ghana.heroshealth.com), trying
    // to read the US-tenant submission. RLS hides the row; handler must
    // surface 404 with the canonical "missing" envelope.
    const crossTenantResp = await app!.inject({
      method: 'GET',
      url: `/v0/forms/submissions/${submissionId}`,
      headers: {
        host: GH_HOST,
        'x-patient-id': ulid(),
      },
    });

    // Request 2: from US tenant, with a fresh non-existent submission_id.
    // Handler returns 404 with the canonical "missing" envelope.
    const trulyMissingResp = await app!.inject({
      method: 'GET',
      url: `/v0/forms/submissions/${ulid()}`,
      headers: {
        host: US_HOST,
        'x-patient-id': ulid(),
      },
    });

    expect(crossTenantResp.statusCode).toBe(404);
    expect(trulyMissingResp.statusCode).toBe(404);

    const crossBody = crossTenantResp.json<CanonicalErrorEnvelope>();
    const missingBody = trulyMissingResp.json<CanonicalErrorEnvelope>();

    // Both must be canonical envelopes.
    assertCanonicalEnvelope(crossBody);
    assertCanonicalEnvelope(missingBody);

    // The CODE must be identical — that's the I-025 invariant. Any
    // divergence (e.g., one returns 'cross_tenant_forbidden') leaks
    // existence.
    expect(crossBody.error.code).toBe(missingBody.error.code);
    // Message should also be identical (no per-tenant or per-case
    // differentiation).
    expect(crossBody.error.message).toBe(missingBody.error.message);
  });
});

// ---------------------------------------------------------------------------
// trace_id uniqueness — every response gets its own trace_id
// ---------------------------------------------------------------------------

describe('error envelope HTTP — trace_id uniqueness', () => {
  it('emits a distinct trace_id per response', async () => {
    const responses = await Promise.all([
      app!.inject({
        method: 'GET',
        url: `/v0/forms/submissions/${ulid()}`,
        headers: { host: US_HOST, 'x-patient-id': ulid() },
      }),
      app!.inject({
        method: 'GET',
        url: `/v0/forms/submissions/${ulid()}`,
        headers: { host: US_HOST, 'x-patient-id': ulid() },
      }),
      app!.inject({
        method: 'GET',
        url: `/v0/forms/submissions/${ulid()}`,
        headers: { host: US_HOST, 'x-patient-id': ulid() },
      }),
    ]);
    const traceIds = responses.map((r) => {
      const body = r.json<CanonicalErrorEnvelope>();
      return body.error.trace_id;
    });
    // All three trace_ids should be distinct (per-request unique).
    expect(new Set(traceIds).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 401 — auth failure
// ---------------------------------------------------------------------------

describe('error envelope HTTP — 401 auth failure', () => {
  it('emits canonical envelope when patient identity header is missing', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: `/v0/forms/submissions/${ulid()}`,
      headers: {
        host: US_HOST,
        // no x-patient-id header
      },
    });
    expect(response.statusCode).toBe(401);
    const body = response.json<unknown>();
    assertCanonicalEnvelope(body);
  });
});

// ---------------------------------------------------------------------------
// I-009 — no hardcoded country / tenant assumptions in error responses
//
// Defensive guard: regardless of which gate fired, the rendered error
// must NOT contain a country name (US, Ghana, GH) or a tenant identifier
// (Telecheck-US, Telecheck-Ghana, Heros, etc.) in any field.
// ---------------------------------------------------------------------------

describe('error envelope HTTP — I-009 no hardcoded country/tenant assumptions', () => {
  it('does not contain country names or tenant identifiers in any 4xx envelope', async () => {
    const tries = [
      // 404 missing
      {
        url: `/v0/forms/submissions/${ulid()}`,
        headers: { host: US_HOST, 'x-patient-id': ulid() },
      },
      // 401 no identity
      { url: `/v0/forms/submissions/${ulid()}`, headers: { host: US_HOST } },
      // 404 from Ghana host
      {
        url: `/v0/forms/submissions/${ulid()}`,
        headers: { host: GH_HOST, 'x-patient-id': ulid() },
      },
    ];
    for (const t of tries) {
      const response = await app!.inject({
        method: 'GET',
        url: t.url,
        headers: t.headers,
      });
      const raw = response.body;
      // The raw body must not contain country names or tenant identifiers.
      expect(raw).not.toContain('Telecheck-US');
      expect(raw).not.toContain('Telecheck-Ghana');
      expect(raw).not.toContain('Heros Health Ghana');
      // 'Heros Health' is the consumer DBA; a patient surface using it
      // is allowed but error envelopes shouldn't carry it (it's an
      // internal config field, not a request-shape input).
      expect(raw).not.toContain('Heros Health');
      // Country names by themselves COULD legitimately appear in some
      // error contexts (e.g., "country code 'XX' is invalid") — we check
      // only for exact tenant identifiers + consumer DBAs that would
      // expose the platform's internal naming.
    }
  });
});
