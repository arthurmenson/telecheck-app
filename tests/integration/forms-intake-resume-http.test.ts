/**
 * Forms/Intake — save-and-resume HTTP route-level integration tests.
 *
 * Closes the residual coverage gap on the resume read+restore handlers:
 * prior tests exercise `getResumeStateMetadata` + `resumeSubmission` at
 * the service layer, but did NOT prove the actual HTTP boundary
 * (`getResumeStateHandler` + `resumeSubmissionHandler` registered in
 * `src/modules/forms-intake/routes.ts`) round-trips identity headers
 * through the `resolveResumeOwnership` shim, that 4xx envelopes match
 * the I-025 tenant-blind shape, or that the success body is byte-clean
 * of `tenant_id` after Fastify serialization.
 *
 * **Test pattern:** mirrors `forms-intake-snapshot-http.test.ts` exactly
 * (buildApp + Fastify `inject`). The two helpers `findKeyAtAnyDepth` +
 * `assertNoTenantIdLeakage` are intentionally duplicated here rather
 * than extracted to a shared file — at this stage of the slice each
 * HTTP-level test file owns its own consistency surface, and Codex's
 * verify-r1 closure on the snapshot-http suite specifically calls out
 * keeping the assertions inline with each test.
 *
 * Spec references:
 *   - Slice PRD v2.1 §8 (save-and-resume), §8.4 (restore + replay protection)
 *   - I-013 immutability analog (in_progress → in_progress merge gate)
 *   - I-016 same-tx outbox (merge UPDATE + status flip + audit atomic)
 *   - I-023 tenant context resolution + RLS
 *   - I-025 tenant-blind 404 envelopes (every failure mode null/404 at the surface)
 *   - I-027 audit-records carry tenant_id
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 — patient surface MUST NOT
 *     render the operating-tenant identifier
 *   - Codex resume-r1 HIGH closure 2026-05-03 — resume token is no longer
 *     sole bearer of authorization; identity header is required
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { ulid } from '../../src/lib/ulid.ts';
import * as submissionService from '../../src/modules/forms-intake/internal/services/submission-service.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

// ---------------------------------------------------------------------------
// Test app lifecycle
// ---------------------------------------------------------------------------

let app: FastifyInstance | null = null;

beforeAll(async () => {
  // ALLOW_ACTOR_HEADER_AUTH gates the patient/actor shim at the handler
  // boundary; under NODE_ENV=test the shim accepts headers without the
  // opt-in. Confirm here that the test harness is configured as expected.
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
// Fixtures (mirror forms-intake-restore.test.ts's `pauseHelper` pipeline,
// inlined here so this test file is self-contained per the same convention
// used by forms-intake-snapshot-http.test.ts).
// ---------------------------------------------------------------------------

interface PausedFixture {
  templateId: string;
  deploymentId: string;
  patientId: string;
  submissionId: string;
  resumeStateId: string;
  resumeToken: string;
  resumeExpiresAt: string;
}

/**
 * Seed a published template + active deployment + start a submission via
 * the service, then pause it. Returns the resume token + identity needed
 * to drive the HTTP handlers. Pause goes through `submissionService.
 * pauseSubmission` so the same-tx outbox runs and the resume_state row +
 * encrypted partial responses + HMAC token are real (not seeded SQL).
 */
async function seedPausedSubmission(): Promise<PausedFixture> {
  const client = getTestClient();
  const programId = `prog_resume_http_${ulid().slice(0, 8)}`;
  const templateId = ulid();
  const deploymentId = ulid();
  const patientId = ulid();

  await withTenantContext(TENANT_US, async () => {
    await client.query(
      `INSERT INTO forms_template (
          template_id, tenant_id, program_id, country_of_care,
          template_version, status, name, created_by,
          presentation_content, branching_logic,
          eligibility_logic, approval_governance,
          published_at, created_at, updated_at
       ) VALUES (
          $1, $2, $3, $4,
          1, 'published', $5, $6,
          '{}'::jsonb, '{}'::jsonb,
          '{}'::jsonb, '{}'::jsonb,
          NOW(), NOW(), NOW()
       )`,
      [
        templateId,
        TENANT_US,
        programId,
        'US',
        `test-resume-http-${templateId.slice(0, 8)}`,
        ulid(),
      ],
    );
    await client.query(
      `INSERT INTO forms_deployment (
          deployment_id, tenant_id, template_id, program_id,
          deployed_by, deployed_at,
          created_at, updated_at
       ) VALUES (
          $1, $2, $3, $4,
          $5, NOW(),
          NOW(), NOW()
       )`,
      [deploymentId, TENANT_US, templateId, programId, ulid()],
    );
  });

  // Pass the TenantContext as an inline literal at each call site so
  // `countryOfCare: 'US'` narrows to the `'US' | 'GH'` literal union the
  // type requires. Mirrors the inline-literal pattern used by
  // forms-intake-snapshot-http.test.ts (consistency over DRY at this
  // stage of the slice).
  const submission = await withTenantContext(TENANT_US, () =>
    submissionService.startSubmission(
      {
        tenantId: TENANT_US as never,
        displayName: 'Telecheck-US',
        countryOfCare: 'US',
        kmsKeyAlias: 'alias/telecheck-us-data-key',
        consumerDba: 'Heros Health',
        legalEntity: 'Telecheck Health LLC',
        consumerSubdomain: 'heroshealth.com',
      },
      { actorId: 'op_resume_http', patientId, delegateId: null },
      { deploymentId },
      getTestClient(),
    ),
  );

  // Use a benign payload — the I-019 crisis gate runs on the merged set
  // before the pause commits; anything that trips the detector would
  // throw `forms.submission.crisis_detected` instead of yielding a token.
  const paused = await withTenantContext(TENANT_US, () =>
    submissionService.pauseSubmission(
      {
        tenantId: TENANT_US as never,
        displayName: 'Telecheck-US',
        countryOfCare: 'US',
        kmsKeyAlias: 'alias/telecheck-us-data-key',
        consumerDba: 'Heros Health',
        legalEntity: 'Telecheck Health LLC',
        consumerSubdomain: 'heroshealth.com',
      },
      { actorId: 'op_resume_http', patientId, delegateId: null },
      submission.submission_id,
      { responses: { field_a: 'value', field_b: 42 }, pause: true },
      getTestClient(),
    ),
  );

  return {
    templateId,
    deploymentId,
    patientId,
    submissionId: submission.submission_id,
    resumeStateId: paused.resumeState.resumeStateId,
    resumeToken: paused.resumeState.resumeToken,
    resumeExpiresAt: paused.resumeState.expiresAt,
  };
}

/**
 * Recursively scan a parsed JSON value for a key matching `targetKey`
 * (case-sensitive). Used to catch nested `tenant_id` leaks that a
 * top-level `not.toHaveProperty` check misses. Mirrors
 * `forms-intake-snapshot-http.test.ts` per Codex's verify-r1 closure on
 * that suite (consistency over DRY).
 */
function findKeyAtAnyDepth(value: unknown, targetKey: string): boolean {
  type Frame = unknown;
  const stack: Frame[] = [value];
  while (stack.length > 0) {
    const next = stack.pop();
    if (Array.isArray(next)) {
      for (const item of next) {
        stack.push(item);
      }
      continue;
    }
    if (next !== null && typeof next === 'object') {
      const obj = next as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (key === targetKey) {
          return true;
        }
        stack.push(obj[key]);
      }
    }
    // primitives — no key surface
  }
  return false;
}

/**
 * Assert that an HTTP response body is byte-clean of operating-tenant
 * identity at BOTH the JSON-key level (any depth) AND the raw-string
 * level (any nesting / serialization shape). Per Codex snapshot-http-r1
 * recommendation: "Assert against the actual serialized surface."
 */
function assertNoTenantIdLeakage(response: { body: string; json: <T>() => T }): void {
  // Raw-string: catch key OR value anywhere in the wire body, including
  // accidental nesting under any future field.
  expect(response.body).not.toContain('tenant_id');
  expect(response.body).not.toContain(TENANT_US);
  // Parsed: defense-in-depth for cases where the key happens to appear
  // inside an unrelated free-text field (the raw-string check would
  // false-positive there). The recursive scan catches a deliberate
  // nested object key.
  const parsed = response.json<unknown>();
  expect(findKeyAtAnyDepth(parsed, 'tenant_id')).toBe(false);
}

/**
 * Same byte-clean guarantee as `assertNoTenantIdLeakage` but tolerant of
 * empty / non-JSON bodies (some 401/4xx come back as empty strings).
 * Applied to every negative response in this suite per Codex
 * variants-resume-http-r1 closure 2026-05-03 — error envelopes are a
 * real PHI leak surface.
 */
function assertNoTenantIdLeakageInError(response: { body: string }): void {
  expect(response.body).not.toContain('tenant_id');
  expect(response.body).not.toContain(TENANT_US);
  if (response.body.trim().length === 0) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return;
  }
  expect(findKeyAtAnyDepth(parsed, 'tenant_id')).toBe(false);
}

/**
 * Strip volatile fields from an error envelope so cross-test envelope
 * shape can be compared.
 *
 * **Codex variants-resume-http-r2 closure 2026-05-03:** the volatile
 * fields the platform error envelope (`src/lib/error-envelope.ts`) emits
 * are `trace_id` (per-request unique) and `timestamp` (now()), NOT
 * `request_id`. Two separate `app.inject` calls would otherwise produce
 * different normalized objects even when the tenant-blind code/message
 * are identical. The previous version of this normalizer stripped the
 * wrong fields and would have made the equality tests timing-dependent
 * (passing only if timestamps happened to match at millisecond
 * resolution).
 *
 * The expected normalized shape for the resume tenant-blind paths:
 *   { error: { code: <static-string>, message: <static-string> } }
 * Anything else (a leaked detail field, a tenant-context entry) would
 * diverge from this shape and fail the equality assertion.
 */
function normalizeErrorEnvelope(response: { body: string }): unknown {
  if (response.body.trim().length === 0) return null;
  let parsed: { error?: Record<string, unknown> };
  try {
    parsed = JSON.parse(response.body) as { error?: Record<string, unknown> };
  } catch {
    return null;
  }
  if (parsed.error === undefined) return null;
  const error = parsed.error;
  /* eslint-disable @typescript-eslint/no-unused-vars */
  const {
    trace_id: _trace,
    timestamp: _ts,
    request_id: _reqId,
    statusCode: _sc,
    ...stable
  } = error;
  /* eslint-enable @typescript-eslint/no-unused-vars */
  return { error: stable };
}

// ---------------------------------------------------------------------------
// HTTP-level resume-metadata read path
// ---------------------------------------------------------------------------

describe('GET /v0/forms/resume/:resumeToken — HTTP-level', () => {
  it('returns 200 + patient-safe metadata (no tenant_id) for the owning patient', async () => {
    const { resumeToken, resumeStateId, deploymentId, patientId } = await seedPausedSubmission();

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/forms/resume/${resumeToken}`,
      headers: {
        host: 'localhost',
        'x-patient-id': patientId,
      },
    });

    expect(response.statusCode).toBe(200);

    // No-tenant_id-leak guarantee at every layer (any-depth nested key,
    // raw-body string, tenantId value).
    assertNoTenantIdLeakage(response);

    // Spot-check the projected metadata fields per `ResumeStateMetadata`
    // in src/modules/forms-intake/internal/types.ts.
    const body = response.json<Record<string, unknown>>();
    expect(body['resume_state_id']).toBe(resumeStateId);
    expect(body['deployment_id']).toBe(deploymentId);
    expect(body).toHaveProperty('current_section_index');
    expect(body).toHaveProperty('progress_percent');
    expect(body['status']).toBe('active');
    expect(body).toHaveProperty('expires_at');
    expect(body).toHaveProperty('last_saved_at');
  });

  it('returns 404 when a different patient presents a valid resume token (tenant-blind)', async () => {
    const { resumeToken } = await seedPausedSubmission();
    const wrongPatientId = ulid();

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/forms/resume/${resumeToken}`,
      headers: {
        host: 'localhost',
        'x-patient-id': wrongPatientId,
      },
    });

    expect(response.statusCode).toBe(404);
    // I-025 tenant-blind: shape doesn't differentiate "doesn't exist" from
    // "exists but cross-patient". The error envelope plugin's canonical
    // shape applies; we assert the envelope is present + tenant-blind
    // (no tenant_id leak via key OR value substring at any depth) per
    // Codex variants-resume-http-r1 closure 2026-05-03.
    assertNoTenantIdLeakageInError(response);
    const body = response.json<{ error?: { code?: string } }>();
    expect(body.error?.code).toBeDefined();
  });

  it('returns 404 when the token signature has been tampered with (tenant-blind)', async () => {
    const { resumeToken, patientId } = await seedPausedSubmission();

    // Flip a single character in the signature segment (post-`.`). Mirrors
    // the existing tampered-token pattern in
    // tests/integration/forms-intake-resume.test.ts and
    // tests/integration/forms-intake-restore.test.ts.
    const dotIdx = resumeToken.lastIndexOf('.');
    const sig = resumeToken.slice(dotIdx + 1);
    const flipped = sig[0] === 'A' ? 'B' : 'A';
    const tampered = resumeToken.slice(0, dotIdx + 1) + flipped + sig.slice(1);

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/forms/resume/${tampered}`,
      headers: {
        host: 'localhost',
        'x-patient-id': patientId,
      },
    });

    expect(response.statusCode).toBe(404);
    assertNoTenantIdLeakageInError(response);
    const body = response.json<{ error?: { code?: string } }>();
    expect(body.error?.code).toBeDefined();
  });

  it('returns 401 when neither x-patient-id nor x-device-anonymous-token is supplied', async () => {
    const { resumeToken } = await seedPausedSubmission();

    const response = await app!.inject({
      method: 'GET',
      url: `/v0/forms/resume/${resumeToken}`,
      headers: {
        host: 'localhost',
      },
    });

    expect(response.statusCode).toBe(401);
    assertNoTenantIdLeakageInError(response);
  });

  // Codex variants-resume-http-r1 closure 2026-05-03 — normalized envelope
  // equality across the three tenant-blind 404 paths (cross-patient,
  // tampered, replay-completed). All three should produce the EXACT same
  // envelope shape after stripping volatile fields like request_id; any
  // divergence would betray which underlying gate tripped, weakening
  // I-025 tenant-blindness.
  it('produces the same normalized error envelope shape for cross-patient and tampered-token 404s', async () => {
    const { resumeToken } = await seedPausedSubmission();

    // Cross-patient 404
    const crossPatient = await app!.inject({
      method: 'GET',
      url: `/v0/forms/resume/${resumeToken}`,
      headers: { host: 'localhost', 'x-patient-id': ulid() },
    });

    // Tampered-signature 404
    const dotIdx = resumeToken.lastIndexOf('.');
    const sig = resumeToken.slice(dotIdx + 1);
    const flipped = sig[0] === 'A' ? 'B' : 'A';
    const tampered = resumeToken.slice(0, dotIdx + 1) + flipped + sig.slice(1);
    const { patientId: tamperedPatient } = await seedPausedSubmission();
    const tamperedResp = await app!.inject({
      method: 'GET',
      url: `/v0/forms/resume/${tampered}`,
      headers: { host: 'localhost', 'x-patient-id': tamperedPatient },
    });

    expect(crossPatient.statusCode).toBe(404);
    expect(tamperedResp.statusCode).toBe(404);

    const aNorm = normalizeErrorEnvelope(crossPatient);
    const bNorm = normalizeErrorEnvelope(tamperedResp);
    expect(aNorm).toEqual(bNorm);
  });
});

// ---------------------------------------------------------------------------
// HTTP-level resume-restore write path
// ---------------------------------------------------------------------------

describe('POST /v0/forms/resume — HTTP-level', () => {
  it('returns 200 + patient-safe submission view (no tenant_id) for the owning patient', async () => {
    const { resumeToken, submissionId, deploymentId, patientId } = await seedPausedSubmission();

    const response = await app!.inject({
      method: 'POST',
      url: `/v0/forms/resume`,
      headers: {
        host: 'localhost',
        'x-patient-id': patientId,
        'x-actor-id': 'op_resume_http',
        'content-type': 'application/json',
      },
      payload: { resumeToken },
    });

    expect(response.statusCode).toBe(200);

    // Same byte-clean guarantee as the GET path.
    assertNoTenantIdLeakage(response);

    // The restore handler returns `PatientFormSubmissionView` (=
    // `Omit<FormSubmission, 'tenant_id'>`). Spot-check the kept fields
    // and confirm `snapshot_id` is NOT present (snapshots are written
    // by submitSubmission, not restore).
    const body = response.json<Record<string, unknown>>();
    expect(body['submission_id']).toBe(submissionId);
    expect(body['deployment_id']).toBe(deploymentId);
    expect(body['patient_id']).toBe(patientId);
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('responses');
    expect(body).not.toHaveProperty('snapshot_id');
    expect(body).not.toHaveProperty('tenant_id');
  });

  it('returns 404 when a different patient presents a valid resume token (tenant-blind)', async () => {
    const { resumeToken } = await seedPausedSubmission();
    const wrongPatientId = ulid();

    const response = await app!.inject({
      method: 'POST',
      url: `/v0/forms/resume`,
      headers: {
        host: 'localhost',
        'x-patient-id': wrongPatientId,
        'x-actor-id': 'op_resume_http_wrong',
        'content-type': 'application/json',
      },
      payload: { resumeToken },
    });

    expect(response.statusCode).toBe(404);
    assertNoTenantIdLeakageInError(response);
    const body = response.json<{ error?: { code?: string } }>();
    expect(body.error?.code).toBeDefined();
  });

  it('returns 404 on second restore attempt with the same token (replay protection)', async () => {
    const { resumeToken, patientId } = await seedPausedSubmission();

    // First restore — must succeed.
    const first = await app!.inject({
      method: 'POST',
      url: `/v0/forms/resume`,
      headers: {
        host: 'localhost',
        'x-patient-id': patientId,
        'x-actor-id': 'op_resume_http_replay',
        'content-type': 'application/json',
      },
      payload: { resumeToken },
    });
    expect(first.statusCode).toBe(200);

    // Second restore with the same token — the resume_state row was
    // flipped to status='completed' inside the first restore's outer
    // tx. Repo's markResumeStateCompleted predicate trips the
    // RESUME_STATE_NOT_RESTORABLE sentinel; service maps to null;
    // handler maps null to a tenant-blind 404 per I-025.
    const second = await app!.inject({
      method: 'POST',
      url: `/v0/forms/resume`,
      headers: {
        host: 'localhost',
        'x-patient-id': patientId,
        'x-actor-id': 'op_resume_http_replay',
        'content-type': 'application/json',
      },
      payload: { resumeToken },
    });
    expect(second.statusCode).toBe(404);
    assertNoTenantIdLeakageInError(second);
    const body = second.json<{ error?: { code?: string } }>();
    expect(body.error?.code).toBeDefined();
  });

  it('returns 401 when neither x-patient-id nor x-device-anonymous-token is supplied', async () => {
    const { resumeToken } = await seedPausedSubmission();

    // Note: x-actor-id is also required by `resolveActorId`, but
    // `resolveResumeOwnership` is invoked AFTER `resolveActorId` in the
    // POST handler — meaning a request with neither identity header trips
    // the actor-id 401 first. Either way the surface is 401, which is
    // what this case asserts. (The GET handler does NOT require an
    // actor-id, so the GET-side 401 case above is a clean
    // ownership-shim 401.)
    const response = await app!.inject({
      method: 'POST',
      url: `/v0/forms/resume`,
      headers: {
        host: 'localhost',
        'content-type': 'application/json',
      },
      payload: { resumeToken },
    });

    expect(response.statusCode).toBe(401);
    assertNoTenantIdLeakageInError(response);
  });

  it('returns 400 when the body is missing the resumeToken field', async () => {
    // Don't seed — the body validation runs before the service does any
    // lookup, so a paused submission isn't required to exercise this path.
    const patientId = ulid();
    const response = await app!.inject({
      method: 'POST',
      url: `/v0/forms/resume`,
      headers: {
        host: 'localhost',
        'x-patient-id': patientId,
        'x-actor-id': 'op_resume_http_bad_body',
        'content-type': 'application/json',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    assertNoTenantIdLeakageInError(response);
  });

  // Codex variants-resume-http-r1 normalized-envelope check on the
  // POST tenant-blind 404 paths: cross-patient + replay must produce
  // the same envelope shape after stripping volatile fields.
  it('produces the same normalized error envelope shape for cross-patient and replay 404s', async () => {
    // Cross-patient
    const seedA = await seedPausedSubmission();
    const crossPatient = await app!.inject({
      method: 'POST',
      url: `/v0/forms/resume`,
      headers: {
        host: 'localhost',
        'x-patient-id': ulid(),
        'x-actor-id': 'op_norm_xpat',
        'content-type': 'application/json',
      },
      payload: { resumeToken: seedA.resumeToken },
    });

    // Replay (paused -> restored once, then restored again)
    const seedB = await seedPausedSubmission();
    const firstRestore = await app!.inject({
      method: 'POST',
      url: `/v0/forms/resume`,
      headers: {
        host: 'localhost',
        'x-patient-id': seedB.patientId,
        'x-actor-id': 'op_norm_replay_first',
        'content-type': 'application/json',
      },
      payload: { resumeToken: seedB.resumeToken },
    });
    expect(firstRestore.statusCode).toBe(200);
    const replay = await app!.inject({
      method: 'POST',
      url: `/v0/forms/resume`,
      headers: {
        host: 'localhost',
        'x-patient-id': seedB.patientId,
        'x-actor-id': 'op_norm_replay_second',
        'content-type': 'application/json',
      },
      payload: { resumeToken: seedB.resumeToken },
    });

    expect(crossPatient.statusCode).toBe(404);
    expect(replay.statusCode).toBe(404);

    const aNorm = normalizeErrorEnvelope(crossPatient);
    const bNorm = normalizeErrorEnvelope(replay);
    expect(aNorm).toEqual(bNorm);
  });
});
