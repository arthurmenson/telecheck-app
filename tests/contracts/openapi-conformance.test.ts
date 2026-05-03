/**
 * OpenAPI v0.2 conformance tests — skeleton.
 *
 * Contract under test: Telecheck_OpenAPI_v0_2.md (187 endpoints across 22 modules).
 *
 * Spec references:
 *   - Telecheck_OpenAPI_v0_2.md (OpenAPI v0.2 — canonical endpoint contracts)
 *   - CLAUDE.md §Workflow: "CI runs lint, type-check, tests, OpenAPI validation,
 *     schema migration validation."
 *   - tests/README.md §OpenAPI conformance tests run in CI
 *   - CLAUDE.md app.ts: buildApp() is available for Fastify inject()
 *
 * Why it.todo() for almost all assertions:
 *   No real route handlers exist beyond GET /health. The skeleton is authored
 *   now so:
 *     1. The pattern is established (Fastify inject + schema match).
 *     2. Slice implementers know exactly where to add conformance tests.
 *     3. The spec path resolution is wired and testable immediately.
 *   As each slice lands (Forms/Intake first per EHBG §10), the corresponding
 *   it.todo() is promoted to a real test by the implementing agent.
 *
 * Pattern for implementing a conformance test (when a real endpoint exists):
 *   1. Import buildApp from src/app.ts.
 *   2. const app = await buildApp({ logger: false });
 *   3. const response = await app.inject({
 *        method: 'GET',
 *        url: '/patients/pat_001',
 *        headers: { 'x-tenant-id': 'Telecheck-US', Authorization: 'Bearer <token>' },
 *      });
 *   4. const schema = getEndpointResponseSchema('/patients/{patient_id}', 'get', 200);
 *   5. Validate response.json() against schema using zod or ajv.
 *   6. Assert response.statusCode matches the OpenAPI-declared status code.
 *
 * DEPENDS ON:
 *   - src/app.ts (buildApp — available at bootstrap)
 *   - Telecheck_OpenAPI_v0_2.md at TELECHECK_SPEC_PATH or default sibling path
 *   - ajv or zod (not yet in devDependencies; add when first real conformance test lands)
 *   - All 187 endpoint route handlers (written per-slice by implementing agents)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Spec path resolution
//
// TELECHECK_SPEC_PATH env var or default sibling location per CLAUDE.md:
//   <workspace>/telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE/
// ---------------------------------------------------------------------------

const SPEC_BUNDLE_DIR =
  process.env['TELECHECK_SPEC_PATH'] ??
  resolve(
    import.meta.dirname ?? __dirname,
    '../../../Telecheck Master Bundle FINAL US REGION BASELINE',
  );

const OPENAPI_SPEC_PATH = join(SPEC_BUNDLE_DIR, 'Telecheck_OpenAPI_v0_2.md');

function specExists(): boolean {
  return existsSync(OPENAPI_SPEC_PATH);
}

// ---------------------------------------------------------------------------
// Spec loading (skeleton — real parsing added when first endpoint test lands)
// ---------------------------------------------------------------------------

interface OpenApiEndpoint {
  path: string;
  method: string;
  operationId: string;
  requestBodySchema?: unknown;
  responseSchemas: Record<number, unknown>;
}

/**
 * Minimal OpenAPI spec loader (skeleton).
 *
 * The OpenAPI v0.2 spec is in Markdown format (not a standalone YAML/JSON file).
 * Full parsing requires either:
 *   (a) Extracting the YAML code blocks from the Markdown and parsing with js-yaml.
 *   (b) Converting the spec to a standalone OpenAPI YAML file at build time.
 *
 * TODO: implement full parsing when the first real conformance test lands.
 *       For now, this skeleton function returns an empty endpoint list.
 *       The CI openapi:validate script in package.json should be wired to
 *       a swagger-cli validate call against the extracted YAML.
 *
 * DEPENDS ON: js-yaml (add to devDependencies when implementing).
 */
function loadOpenApiEndpoints(): OpenApiEndpoint[] {
  // TODO: extract YAML blocks from OPENAPI_SPEC_PATH and parse.
  return [];
}

// ---------------------------------------------------------------------------
// /health conformance — the one real endpoint that exists at bootstrap
// ---------------------------------------------------------------------------

describe('OpenAPI conformance — GET /health (only real endpoint at bootstrap)', () => {
  it('should respond 200 with { status: "ok" } from the Fastify health route', async () => {
    // Dynamically import buildApp to avoid issues when the module has not yet
    // been fully wired (appsec-expert agent may add middleware that causes
    // import-time side effects).
    const { buildApp } = await import('../../src/app.ts');
    const app = await buildApp({ logger: false });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string }>();
    expect(body.status).toBe('ok');

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Spec file presence check
// ---------------------------------------------------------------------------

describe('OpenAPI conformance — spec file resolution', () => {
  it('should be able to locate the OpenAPI v0.2 spec file', () => {
    if (!specExists()) {
      // Not a hard failure — the spec may be at a non-default path.
      // Log a clear warning and skip.
      console.warn(
        `[openapi-conformance] OpenAPI spec not found at: ${OPENAPI_SPEC_PATH}\n` +
          'Set TELECHECK_SPEC_PATH env var to the spec bundle directory, ' +
          'or clone arthurmenson/telecheckONE to a sibling directory.',
      );
      return;
    }
    const content = readFileSync(OPENAPI_SPEC_PATH, 'utf8');
    // Basic sanity: the spec contains at least one endpoint definition.
    expect(content).toContain('openapi');
    expect(content.length).toBeGreaterThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Skeleton: per-endpoint conformance assertions (all it.todo until slices land)
// ---------------------------------------------------------------------------

describe('OpenAPI conformance — endpoint coverage (skeleton; promote it.todo() per slice)', () => {
  // Forms/Intake Engine — first slice per EHBG §10
  it.todo('POST /intake/forms — request body matches IntakeFormCreate schema');
  it.todo('GET /intake/forms/{form_id} — response matches IntakeForm schema');
  it.todo('POST /intake/forms/{form_id}/versions — publishes new IntakeFormVersion');
  it.todo('POST /intake/responses — accepts IntakeResponse; returns 201 with response_id');

  // Patients
  it.todo('POST /patients — creates patient; returns 201 with patient_id');
  it.todo('GET /patients/{patient_id} — returns 200 with Patient schema or 404 tenant-blind');

  // Prescribing / medication_request
  it.todo('POST /medication-requests — initiates medication_request; triggers I-012 gate');
  it.todo(
    'POST /medication-requests/{mr_id}/approve — clinician approval; emits prescribing.approved',
  );
  it.todo(
    'POST /medication-requests/{mr_id}/decline — clinician decline; emits prescribing.declined',
  );

  // Research exports (I-029)
  it.todo(
    'POST /research/exports/initiate — initiates export; validates 6-condition initiation guard',
  );
  it.todo('POST /research/exports/{export_id}/complete — completion; triggers I-029 gate');

  // Audit
  it.todo('GET /audit/records — tenant-scoped audit retrieval; honors I-027');

  // Admin
  it.todo('POST /admin/tenants — creates new tenant (Platform Admin only per RBAC v1.1)');

  // Catch-all: dynamic test generation from parsed spec (runs when spec parsing is implemented)
  it('should have 0 endpoints to test from parsed spec (skeleton state)', () => {
    // This test will fail once loadOpenApiEndpoints() returns real endpoints.
    // At that point: replace this test with the dynamic forEach below.
    const endpoints = loadOpenApiEndpoints();
    expect(endpoints).toHaveLength(0);

    /*
     * TODO: promote this block when loadOpenApiEndpoints() is implemented:
     *
     * for (const endpoint of endpoints) {
     *   it(`${endpoint.method.toUpperCase()} ${endpoint.path} — response schema conformance`, async () => {
     *     const { buildApp } = await import('../../src/app.ts');
     *     const app = await buildApp({ logger: false });
     *     // ... inject, validate schema, close app
     *   });
     * }
     */
  });
});
