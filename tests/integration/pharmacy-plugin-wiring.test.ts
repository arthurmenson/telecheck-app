/**
 * pharmacy slice — plugin wiring smoke test.
 *
 * Sprint 1 / TLC-001 (Pharmacy module skeleton, blocked-aware) initially;
 * updated Sprint 35 post-P-011 / SI-001 closure 2026-05-11.
 *
 * SI-001 (MedicationRequest schema gap) is RATIFIED — CDM v1.3 §4.16 +
 * State Machines v1.2 §19 + AUDIT_EVENTS v5.3 + DOMAIN_EVENTS v5.2
 * in-place are canonical in the spec corpus (Promotion Ledger P-011;
 * telecheckONE commit 879cd57). The pharmacy scaffold (migration 025 +
 * branded ID types + I-012-gated state machine + audit emitter v5.3)
 * landed via PR #110 (commit a8c9b99).
 *
 * The HANDLER SURFACE is the remaining gap — tracked as Sprint 35-36 /
 * TLC-055 (pharmacy slice handler implementation + repository layer +
 * supersession reciprocity constraint trigger). Until TLC-055 lands:
 *   - `/health` reports `phase: 'schema_ratified_handlers_pending'` +
 *     `schema_ratified: true` + `handlers_wired: false` for operator
 *     monitoring.
 *   - `/ready` returns 503 with `pending: 'TLC-055'`. The Kubernetes/
 *     load-balancer readiness probe keeps traffic away from the module's
 *     real routes (which don't exist yet) so a premature production
 *     deploy surfaces the pending status rather than masquerading as a
 *     working module.
 *
 * This test asserts both endpoints carry the post-P-011 messaging.
 *
 * Spec references:
 *   - docs/SI-001-MedicationRequest-Schema-Gap.md (status: RATIFIED 2026-05-11)
 *   - CDM v1.3 §4.16 (in telecheckONE; commit 879cd57)
 *   - migrations/025_medication_requests.sql
 *   - src/modules/pharmacy/routes.ts (v0.2)
 *   - ADR-001 (modular monolith)
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';

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

describe('pharmacy slice — §1 plugin wiring (post-PR-D: reads + patient-write live, clinician writes pending)', () => {
  it('§1a GET /v0/pharmacy/health returns 200 with reads + patient-write wired + clinician writes pending', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/pharmacy/health',
      headers: { host: 'localhost' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{
      status: string;
      module: string;
      phase: string;
      schema_ratified: boolean;
      schema_ratified_at: string;
      schema_ratified_by: string;
      read_surface_wired: boolean;
      read_surface_wired_at: string;
      read_surface_wired_by: string;
      patient_write_surface_wired: boolean;
      patient_write_surface_wired_at: string;
      patient_write_surface_wired_by: string;
      i012_first_gated_activation_wired: boolean;
      i012_first_gated_activation_wired_by: string;
      engine_writeback_wired: boolean;
      engine_writeback_wired_at: string;
      engine_writeback_wired_by: string;
      supersession_wired: boolean;
      supersession_wired_at: string;
      supersession_wired_by: string;
      clinician_modify_wired: boolean;
      clinician_modify_wired_at: string;
      clinician_modify_wired_by: string;
      handlers_wired_at: string;
      handlers_wired_by: string;
      clinician_write_surface_complete: boolean;
      clinician_write_surface_complete_at: string;
      clinician_write_surface_complete_by: string;
      handlers_wired: boolean;
      handlers_wired_tracking: string;
    }>();
    expect(body.status).toBe('ok');
    expect(body.module).toBe('pharmacy');
    // Post-PR-K: slice is fully production-ready. Every clinician
    // transition from State Machines v1.2 §19 has an HTTP handler.
    expect(body.phase).toBe('fully_ready_post_tlc055');
    expect(body.schema_ratified).toBe(true);
    expect(body.schema_ratified_at).toBe('2026-05-11');
    expect(body.schema_ratified_by).toBe('P-011');
    expect(body.read_surface_wired).toBe(true);
    expect(body.read_surface_wired_at).toBe('2026-05-13');
    expect(body.read_surface_wired_by).toBe('TLC-055 PR C');
    expect(body.patient_write_surface_wired).toBe(true);
    expect(body.patient_write_surface_wired_at).toBe('2026-05-13');
    expect(body.patient_write_surface_wired_by).toBe('TLC-055 PR D');
    expect(body.clinician_write_surface_complete).toBe(true);
    expect(body.clinician_write_surface_complete_by).toBe(
      'TLC-055 PR E (draft + submit) + PR F (discontinue) + PR G (approve) + PR H (decline) + PR J (supersede) + PR K (modify)',
    );
    expect(body.i012_first_gated_activation_wired).toBe(true);
    expect(body.i012_first_gated_activation_wired_by).toBe('TLC-055 PR G (clinician_approve)');
    expect(body.engine_writeback_wired).toBe(true);
    expect(body.engine_writeback_wired_at).toBe('2026-05-13');
    expect(body.engine_writeback_wired_by).toBe(
      'TLC-055 PR I (service-callable; no HTTP surface at v1.0)',
    );
    expect(body.supersession_wired).toBe(true);
    expect(body.supersession_wired_by).toBe('TLC-055 PR J');
    expect(body.clinician_modify_wired).toBe(true);
    expect(body.clinician_modify_wired_by).toBe('TLC-055 PR K');
    expect(body.handlers_wired).toBe(true);
    expect(body.handlers_wired_by).toBe('TLC-055 PR K — slice complete; /ready flips to 200');
  });

  it('§1b GET /v0/pharmacy/ready returns 200 (slice fully production-ready post-TLC-055 PR K)', async () => {
    const r = await app!.inject({
      method: 'GET',
      url: '/v0/pharmacy/ready',
      headers: { host: 'localhost' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{
      status: string;
      module: string;
      phase: string;
      ready_at: string;
      ready_by: string;
      notes: string;
    }>();
    expect(body.status).toBe('ready');
    expect(body.module).toBe('pharmacy');
    expect(body.phase).toBe('fully_ready_post_tlc055');
    expect(body.ready_by).toContain('TLC-055 PR K');
    expect(body.notes).toContain('fully production-ready');
    expect(body.notes).toContain('clinician_modify');
    expect(body.notes).not.toContain('schema not yet ratified');
  });
});
