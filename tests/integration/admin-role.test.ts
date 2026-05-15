/**
 * admin-role.ts — direct unit-coverage on the `requireAdminRole` shim.
 *
 * Until this commit the function had ZERO direct test coverage; every
 * exercised path was via HTTP integration tests (deployments-http,
 * variants-http, templates-http) which only assert the COMPOSITE
 * behavior of `resolveActorId → requireAdminRole → handler` and don't
 * surface the per-branch contract of the role/tenant-scope matrix.
 *
 * Why this matters:
 *   `requireAdminRole` is the authorization boundary for every admin
 *   surface (templates, deployments, variants — any tenant_admin or
 *   platform_admin endpoint). A regression that silently relaxes the
 *   tenant-scope check (e.g., letting tenant_admin for tenant A admin
 *   tenant B) is a direct cross-tenant administration breach — a
 *   higher-severity equivalent to the I-023 floor on PHI access.
 *   Pinning each branch directly catches the regression at unit-test
 *   speed, before any handler-level test would even reach the function.
 *
 * Coverage in this file (matrix of role × tenant-binding × env):
 *
 *   §1 Production gate (no ALLOW_ACTOR_HEADER_AUTH opt-in)
 *      - 1a NODE_ENV=production, no opt-in → throws unauthorized (401)
 *      - 1b NODE_ENV=production, opt-in=true → proceeds normally
 *
 *   §2 No-identity / no-roles paths
 *      - 2a Missing x-actor-roles header → throws forbidden (403)
 *      - 2b Empty x-actor-roles header → throws forbidden (403)
 *      - 2c Whitespace-only x-actor-roles → throws forbidden (403)
 *      - 2d Non-admin roles (patient, clinician) → throws forbidden (403)
 *      - 2e Comma-separated non-admin roles → throws forbidden (403)
 *
 *   §3 platform_admin (global)
 *      - 3a `platform_admin` alone, no x-actor-admin-tenant → returns 'platform_admin'
 *        (platform_admin is global — no tenant binding required).
 *      - 3b `platform_admin` + x-actor-admin-tenant=Telecheck-US → still
 *        returns 'platform_admin' (header is ignored for platform role).
 *      - 3c `platform_admin` + mismatched x-actor-admin-tenant → still
 *        returns 'platform_admin' (header is ignored).
 *
 *   §4 tenant_admin tenant-scope enforcement (the cross-tenant-admin
 *      hole closure — Codex admin-auth-r1 2026-05-03)
 *      - 4a `tenant_admin` without x-actor-admin-tenant → 403
 *      - 4b `tenant_admin` with empty x-actor-admin-tenant → 403
 *      - 4c `tenant_admin` with whitespace x-actor-admin-tenant → 403
 *      - 4d `tenant_admin` with mismatched x-actor-admin-tenant → 403
 *      - 4e `tenant_admin` with matching x-actor-admin-tenant → returns 'tenant_admin'
 *
 *   §5 Multi-role precedence (the for-loop's first-match-wins behavior)
 *      - 5a `tenant_admin,platform_admin` (order matters?) — pin behavior
 *      - 5b `clinician,tenant_admin` with matching binding → returns
 *        'tenant_admin' (non-admin role skipped, admin matched)
 *      - 5c `patient,tenant_admin` with mismatched binding + then a
 *        platform_admin → returns 'platform_admin' (continues past the
 *        tenant_admin mismatch, finds platform_admin)
 *
 *   §6 Cross-tenant scenario
 *      - 6a Resolved tenant = US, header binding = Ghana, role =
 *        tenant_admin → 403 (the cross-tenant-administration floor)
 *
 * Spec references:
 *   - RBAC v1.1 (admin role names + scope semantics)
 *   - I-023 / I-024 (tenant isolation; admin scope is per-tenant unless
 *     platform-global)
 *   - Codex admin-auth-r1 closure 2026-05-03 (tenant-scope enforcement)
 */

import type { FastifyError, FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { requireAdminRole } from '../../src/lib/admin-role.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';

// ---------------------------------------------------------------------------
// Helpers — minimal FastifyRequest stub with the surface area
// `requireAdminRole` actually reads.
// ---------------------------------------------------------------------------

/**
 * Build a minimal req stub. The function reads req.headers,
 * req.tenantContext, and req.server.httpErrors. All other Fastify
 * fields are unreached. Cast to FastifyRequest so the stub passes
 * the function's type contract; the runtime shape is a strict subset.
 */
function makeReq(opts: {
  tenantId: string;
  headers?: Record<string, string | undefined>;
  /**
   * Phase 2 admin JWT widening (2026-05-15): optional actorContext +
   * bearerTokenPresented to exercise requireAdminRole's Tier 1 JWT
   * branch + the bearerTokenPresented fail-closed branch. When
   * actorContext is supplied, the function returns the admin role
   * directly without consulting headers; when bearerTokenPresented
   * is true but actorContext is absent, the function 401s without
   * consulting headers (rejected-JWT fail-closed).
   */
  actorContext?: {
    accountId: string;
    sessionId: string;
    tenantId: string;
    role: 'patient' | 'clinician' | 'tenant_admin' | 'platform_admin';
    countryOfCare: 'US' | 'GH';
    delegateId: string | null;
    adminTenantBinding: string | null;
    adminHomeTenantId: string | null;
  };
  bearerTokenPresented?: boolean;
}): FastifyRequest {
  const tenantContext: TenantContext = {
    tenantId: opts.tenantId as TenantContext['tenantId'],
    displayName: 'Test',
    countryOfCare: 'US',
    kmsKeyAlias: 'alias/test',
    consumerDba: 'Test',
    legalEntity: 'Test',
    consumerSubdomain: 'test.example.com',
  };
  const stub = {
    headers: opts.headers ?? {},
    tenantContext,
    actorContext: opts.actorContext,
    bearerTokenPresented: opts.bearerTokenPresented ?? false,
    server: {
      httpErrors: {
        unauthorized: (msg: string): FastifyError => {
          const err = new Error(msg) as FastifyError;
          err.statusCode = 401;
          err.code = 'FST_ERR_UNAUTHORIZED';
          err.name = 'UnauthorizedError';
          return err;
        },
        forbidden: (msg: string): FastifyError => {
          const err = new Error(msg) as FastifyError;
          err.statusCode = 403;
          err.code = 'FST_ERR_FORBIDDEN';
          err.name = 'ForbiddenError';
          return err;
        },
      },
    },
  };
  return stub as unknown as FastifyRequest;
}

const TENANT_US = 'Telecheck-US';
const TENANT_GHANA = 'Telecheck-Ghana';

/**
 * Asserts that `requireAdminRole(req)` throws an error whose
 * `statusCode` matches the expected HTTP code (401 or 403).
 * Vitest's `.toThrow` doesn't directly let us read err.statusCode,
 * so we capture and assert manually.
 */
function expectThrowsWithStatus(req: FastifyRequest, expectedStatus: number): void {
  let caught: unknown;
  try {
    requireAdminRole(req);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  const fastifyErr = caught as FastifyError;
  expect(fastifyErr.statusCode).toBe(expectedStatus);
}

// ---------------------------------------------------------------------------
// Save/restore env so production-gate tests don't leak state.
// ---------------------------------------------------------------------------

let savedNodeEnv: string | undefined;
let savedOptIn: string | undefined;

beforeEach(() => {
  savedNodeEnv = process.env['NODE_ENV'];
  savedOptIn = process.env['ALLOW_ACTOR_HEADER_AUTH'];
});

afterEach(() => {
  if (savedNodeEnv === undefined) delete process.env['NODE_ENV'];
  else process.env['NODE_ENV'] = savedNodeEnv;
  if (savedOptIn === undefined) delete process.env['ALLOW_ACTOR_HEADER_AUTH'];
  else process.env['ALLOW_ACTOR_HEADER_AUTH'] = savedOptIn;
});

// ---------------------------------------------------------------------------
// §1 Production gate
// ---------------------------------------------------------------------------

describe('requireAdminRole — production gate', () => {
  it('§1a throws 401 in production WITHOUT ALLOW_ACTOR_HEADER_AUTH opt-in', () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['ALLOW_ACTOR_HEADER_AUTH'];
    const req = makeReq({
      tenantId: TENANT_US,
      // Even valid admin headers don't matter — the prod gate fires first.
      headers: {
        'x-actor-roles': 'platform_admin',
      },
    });
    expectThrowsWithStatus(req, 401);
  });

  it('§1b proceeds normally in production WITH opt-in (header shim allowed)', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['ALLOW_ACTOR_HEADER_AUTH'] = 'true';
    const req = makeReq({
      tenantId: TENANT_US,
      headers: { 'x-actor-roles': 'platform_admin' },
    });
    expect(requireAdminRole(req)).toBe('platform_admin');
  });
});

// ---------------------------------------------------------------------------
// §2 No-identity / no-admin-role
// ---------------------------------------------------------------------------

describe('requireAdminRole — no admin role', () => {
  beforeEach(() => {
    process.env['NODE_ENV'] = 'test';
  });

  it('§2a throws 403 when x-actor-roles header is missing', () => {
    expectThrowsWithStatus(makeReq({ tenantId: TENANT_US, headers: {} }), 403);
  });

  it('§2b throws 403 when x-actor-roles header is the empty string', () => {
    expectThrowsWithStatus(makeReq({ tenantId: TENANT_US, headers: { 'x-actor-roles': '' } }), 403);
  });

  it('§2c throws 403 when x-actor-roles is whitespace-only', () => {
    expectThrowsWithStatus(
      makeReq({ tenantId: TENANT_US, headers: { 'x-actor-roles': '   ' } }),
      403,
    );
  });

  it('§2d throws 403 when only non-admin roles are present (patient)', () => {
    expectThrowsWithStatus(
      makeReq({ tenantId: TENANT_US, headers: { 'x-actor-roles': 'patient' } }),
      403,
    );
  });

  it('§2d2 throws 403 when only non-admin roles are present (clinician)', () => {
    expectThrowsWithStatus(
      makeReq({ tenantId: TENANT_US, headers: { 'x-actor-roles': 'clinician' } }),
      403,
    );
  });

  it('§2e throws 403 when several non-admin roles are present (comma-separated)', () => {
    expectThrowsWithStatus(
      makeReq({
        tenantId: TENANT_US,
        headers: { 'x-actor-roles': 'patient,clinician,delegate' },
      }),
      403,
    );
  });
});

// ---------------------------------------------------------------------------
// §3 platform_admin (global)
// ---------------------------------------------------------------------------

describe('requireAdminRole — platform_admin (global, no tenant binding)', () => {
  beforeEach(() => {
    process.env['NODE_ENV'] = 'test';
  });

  it('§3a returns "platform_admin" with no x-actor-admin-tenant header', () => {
    const req = makeReq({
      tenantId: TENANT_US,
      headers: { 'x-actor-roles': 'platform_admin' },
    });
    expect(requireAdminRole(req)).toBe('platform_admin');
  });

  it('§3b returns "platform_admin" even with x-actor-admin-tenant matching ctx', () => {
    const req = makeReq({
      tenantId: TENANT_US,
      headers: {
        'x-actor-roles': 'platform_admin',
        'x-actor-admin-tenant': TENANT_US,
      },
    });
    expect(requireAdminRole(req)).toBe('platform_admin');
  });

  it('§3c returns "platform_admin" even with mismatched x-actor-admin-tenant (header ignored for platform role)', () => {
    // platform_admin is global — the header is intentionally not
    // consulted. A platform admin can act in any tenant context.
    const req = makeReq({
      tenantId: TENANT_US,
      headers: {
        'x-actor-roles': 'platform_admin',
        'x-actor-admin-tenant': TENANT_GHANA,
      },
    });
    expect(requireAdminRole(req)).toBe('platform_admin');
  });
});

// ---------------------------------------------------------------------------
// §4 tenant_admin tenant-scope enforcement
// ---------------------------------------------------------------------------

describe('requireAdminRole — tenant_admin tenant-scope enforcement', () => {
  beforeEach(() => {
    process.env['NODE_ENV'] = 'test';
  });

  it('§4a throws 403 when tenant_admin presents NO x-actor-admin-tenant binding', () => {
    expectThrowsWithStatus(
      makeReq({ tenantId: TENANT_US, headers: { 'x-actor-roles': 'tenant_admin' } }),
      403,
    );
  });

  it('§4b throws 403 when tenant_admin presents an EMPTY x-actor-admin-tenant', () => {
    expectThrowsWithStatus(
      makeReq({
        tenantId: TENANT_US,
        headers: { 'x-actor-roles': 'tenant_admin', 'x-actor-admin-tenant': '' },
      }),
      403,
    );
  });

  it('§4c throws 403 when tenant_admin presents a whitespace x-actor-admin-tenant', () => {
    // Whitespace-only is NOT trimmed by the implementation; it doesn't
    // match the resolved tenant_id. 403 either way.
    expectThrowsWithStatus(
      makeReq({
        tenantId: TENANT_US,
        headers: { 'x-actor-roles': 'tenant_admin', 'x-actor-admin-tenant': '   ' },
      }),
      403,
    );
  });

  it('§4d throws 403 when tenant_admin presents MISMATCHED x-actor-admin-tenant', () => {
    // Cross-tenant administration floor — the regression-guard for the
    // Codex admin-auth-r1 closure.
    expectThrowsWithStatus(
      makeReq({
        tenantId: TENANT_US,
        headers: {
          'x-actor-roles': 'tenant_admin',
          'x-actor-admin-tenant': TENANT_GHANA,
        },
      }),
      403,
    );
  });

  it('§4e returns "tenant_admin" when binding matches the resolved tenant', () => {
    const req = makeReq({
      tenantId: TENANT_US,
      headers: {
        'x-actor-roles': 'tenant_admin',
        'x-actor-admin-tenant': TENANT_US,
      },
    });
    expect(requireAdminRole(req)).toBe('tenant_admin');
  });

  it('§4f cross-tenant in the OPPOSITE direction (Ghana ctx, US binding) → 403', () => {
    // Symmetric pin — the rejection isn't accidentally one-directional.
    expectThrowsWithStatus(
      makeReq({
        tenantId: TENANT_GHANA,
        headers: {
          'x-actor-roles': 'tenant_admin',
          'x-actor-admin-tenant': TENANT_US,
        },
      }),
      403,
    );
  });
});

// ---------------------------------------------------------------------------
// §5 Multi-role precedence
// ---------------------------------------------------------------------------

describe('requireAdminRole — multi-role precedence (first-admin-match-wins)', () => {
  beforeEach(() => {
    process.env['NODE_ENV'] = 'test';
  });

  it('§5a tenant_admin first, platform_admin second, with matching tenant binding → returns "tenant_admin"', () => {
    // Order in the comma list determines which matches first; tenant_admin
    // matches with the binding header, so the loop returns it before
    // reaching platform_admin.
    const req = makeReq({
      tenantId: TENANT_US,
      headers: {
        'x-actor-roles': 'tenant_admin,platform_admin',
        'x-actor-admin-tenant': TENANT_US,
      },
    });
    expect(requireAdminRole(req)).toBe('tenant_admin');
  });

  it('§5b platform_admin first, tenant_admin second → returns "platform_admin"', () => {
    const req = makeReq({
      tenantId: TENANT_US,
      headers: {
        'x-actor-roles': 'platform_admin,tenant_admin',
        'x-actor-admin-tenant': TENANT_US,
      },
    });
    expect(requireAdminRole(req)).toBe('platform_admin');
  });

  it('§5c clinician + tenant_admin with matching binding → returns "tenant_admin" (non-admin skipped)', () => {
    const req = makeReq({
      tenantId: TENANT_US,
      headers: {
        'x-actor-roles': 'clinician,tenant_admin',
        'x-actor-admin-tenant': TENANT_US,
      },
    });
    expect(requireAdminRole(req)).toBe('tenant_admin');
  });

  it('§5d patient + tenant_admin (mismatched binding) + platform_admin → returns "platform_admin"', () => {
    // tenant_admin's mismatch causes the loop to `continue`, then
    // platform_admin matches unconditionally. Pins that the
    // tenant_admin failure does NOT short-circuit the whole function
    // with 403 — the loop keeps looking for an authorized role.
    const req = makeReq({
      tenantId: TENANT_US,
      headers: {
        'x-actor-roles': 'patient,tenant_admin,platform_admin',
        'x-actor-admin-tenant': TENANT_GHANA, // mismatch
      },
    });
    expect(requireAdminRole(req)).toBe('platform_admin');
  });

  it('§5e patient + tenant_admin (mismatched binding) — no platform_admin → 403', () => {
    // Same as §5d but without the platform_admin fallback. Confirms
    // the loop's "continue past tenant_admin mismatch" behavior
    // doesn't leak through as success when no other admin role matches.
    expectThrowsWithStatus(
      makeReq({
        tenantId: TENANT_US,
        headers: {
          'x-actor-roles': 'patient,tenant_admin',
          'x-actor-admin-tenant': TENANT_GHANA,
        },
      }),
      403,
    );
  });
});

// ---------------------------------------------------------------------------
// §6 Whitespace + canonical-form pins
// ---------------------------------------------------------------------------

describe('requireAdminRole — header parsing (whitespace, casing)', () => {
  beforeEach(() => {
    process.env['NODE_ENV'] = 'test';
  });

  it('§6a whitespace around comma-separated roles is trimmed', () => {
    const req = makeReq({
      tenantId: TENANT_US,
      headers: {
        'x-actor-roles': '  patient ,  platform_admin  ',
      },
    });
    expect(requireAdminRole(req)).toBe('platform_admin');
  });

  it('§6b uppercase role name is NOT case-folded — strict-matching only', () => {
    // Pin: the role-name set is case-sensitive ('platform_admin' lowercase).
    // 'PLATFORM_ADMIN' is NOT a member of ADMIN_ROLES so the loop skips
    // it and 403s. Documents the contract; if RBAC v1.1 ever case-folds,
    // this test prompts an explicit decision.
    expectThrowsWithStatus(
      makeReq({
        tenantId: TENANT_US,
        headers: { 'x-actor-roles': 'PLATFORM_ADMIN' },
      }),
      403,
    );
  });
});

// ---------------------------------------------------------------------------
// §7 Phase 2 admin-role JWT widening (2026-05-15)
//
// Closes the JWT-path coverage gap. Pre-Phase-2 the function ONLY consulted
// `x-actor-roles` / `x-actor-admin-tenant` headers. Phase 2 widened the
// function to a tiered model:
//   Tier 1 (preferred): req.actorContext (verified JWT) — when populated,
//     authoritative; no header fall-through.
//   Tier 1b (fail-closed): if req.bearerTokenPresented=true but
//     actorContext=undefined (presented-but-rejected JWT), throw 401
//     without consulting headers.
//   Tier 2 (legacy): when no JWT presented at all, fall back to the
//     header shim (covered by §1-§6 above).
//
// This section pins each branch of the new Tier 1 + Tier 1b matrix.
// ---------------------------------------------------------------------------

describe('requireAdminRole — Phase 2 JWT path (Tier 1)', () => {
  beforeEach(() => {
    process.env['NODE_ENV'] = 'test';
  });

  // §7.1 platform_admin paths
  it('§7.1a platform_admin JWT (same-tenant home) → returns platform_admin', () => {
    // Standard platform_admin acting in their own home tenant.
    const req = makeReq({
      tenantId: TENANT_US,
      actorContext: {
        accountId: 'acct_pa1',
        sessionId: 'sess_pa1',
        tenantId: TENANT_US,
        role: 'platform_admin',
        countryOfCare: 'US',
        delegateId: null,
        adminTenantBinding: null,
        adminHomeTenantId: TENANT_US,
      },
      bearerTokenPresented: true,
    });
    expect(requireAdminRole(req)).toBe('platform_admin');
  });

  it('§7.1b platform_admin JWT (cross-tenant: home Ghana, acting on US) → returns platform_admin', () => {
    // platform_admin is GLOBAL — home tenant Ghana can admin US resources.
    // authContextPlugin populates actorContext.tenantId from the resolved
    // request tenant; adminHomeTenantId carries the JWT claim tenant.
    const req = makeReq({
      tenantId: TENANT_US,
      actorContext: {
        accountId: 'acct_pa2',
        sessionId: 'sess_pa2',
        tenantId: TENANT_US, // resolved request tenant
        role: 'platform_admin',
        countryOfCare: 'US',
        delegateId: null,
        adminTenantBinding: null,
        adminHomeTenantId: TENANT_GHANA, // admin's home (audit attribution)
      },
      bearerTokenPresented: true,
    });
    expect(requireAdminRole(req)).toBe('platform_admin');
  });

  // §7.2 tenant_admin paths
  it('§7.2a tenant_admin JWT with matching binding → returns tenant_admin', () => {
    const req = makeReq({
      tenantId: TENANT_US,
      actorContext: {
        accountId: 'acct_ta1',
        sessionId: 'sess_ta1',
        tenantId: TENANT_US,
        role: 'tenant_admin',
        countryOfCare: 'US',
        delegateId: null,
        adminTenantBinding: TENANT_US,
        adminHomeTenantId: null,
      },
      bearerTokenPresented: true,
    });
    expect(requireAdminRole(req)).toBe('tenant_admin');
  });

  it('§7.2b tenant_admin JWT with mismatched binding → 403 (defense in depth)', () => {
    // authContextPlugin normally rejects this (binding ≠ resolved tenant
    // leaves actorContext undefined). If for any reason the actor reached
    // requireAdminRole with a wrong binding still in actorContext, the
    // defense-in-depth check in requireAdminRole 403s.
    expectThrowsWithStatus(
      makeReq({
        tenantId: TENANT_US,
        actorContext: {
          accountId: 'acct_ta2',
          sessionId: 'sess_ta2',
          tenantId: TENANT_US,
          role: 'tenant_admin',
          countryOfCare: 'US',
          delegateId: null,
          adminTenantBinding: TENANT_GHANA, // mismatched
          adminHomeTenantId: null,
        },
        bearerTokenPresented: true,
      }),
      403,
    );
  });

  // §7.3 non-admin roles fail closed under JWT
  it('§7.3a patient JWT → 403 (JWT authoritative; no header fall-through)', () => {
    expectThrowsWithStatus(
      makeReq({
        tenantId: TENANT_US,
        actorContext: {
          accountId: 'acct_p',
          sessionId: 'sess_p',
          tenantId: TENANT_US,
          role: 'patient',
          countryOfCare: 'US',
          delegateId: null,
          adminTenantBinding: null,
          adminHomeTenantId: null,
        },
        bearerTokenPresented: true,
      }),
      403,
    );
  });

  it('§7.3b clinician JWT → 403 (JWT authoritative)', () => {
    expectThrowsWithStatus(
      makeReq({
        tenantId: TENANT_US,
        actorContext: {
          accountId: 'acct_c',
          sessionId: 'sess_c',
          tenantId: TENANT_US,
          role: 'clinician',
          countryOfCare: 'US',
          delegateId: null,
          adminTenantBinding: null,
          adminHomeTenantId: null,
        },
        bearerTokenPresented: true,
      }),
      403,
    );
  });

  // §7.4 Anti-elevation defense: verified non-admin JWT + forged admin headers
  it('§7.4a patient JWT + forged x-actor-roles=platform_admin header → 403 (R1 closure)', () => {
    // Closes Codex R1 HIGH: a verified non-admin JWT MUST NOT be elevated
    // to admin via a forged x-actor-roles header. Pre-Phase-2 this would
    // have authorized as platform_admin via the header shim. Post-Phase-2
    // the JWT is authoritative; verified patient → 403 regardless of
    // header contents.
    expectThrowsWithStatus(
      makeReq({
        tenantId: TENANT_US,
        headers: {
          'x-actor-roles': 'platform_admin', // FORGED
          'x-actor-id': 'forged_actor',
        },
        actorContext: {
          accountId: 'acct_p',
          sessionId: 'sess_p',
          tenantId: TENANT_US,
          role: 'patient', // real role from JWT
          countryOfCare: 'US',
          delegateId: null,
          adminTenantBinding: null,
          adminHomeTenantId: null,
        },
        bearerTokenPresented: true,
      }),
      403,
    );
  });

  it('§7.4b clinician JWT + forged x-actor-roles=tenant_admin header → 403 (R1 closure)', () => {
    expectThrowsWithStatus(
      makeReq({
        tenantId: TENANT_US,
        headers: {
          'x-actor-roles': 'tenant_admin', // FORGED
          'x-actor-admin-tenant': TENANT_US, // FORGED
        },
        actorContext: {
          accountId: 'acct_c',
          sessionId: 'sess_c',
          tenantId: TENANT_US,
          role: 'clinician',
          countryOfCare: 'US',
          delegateId: null,
          adminTenantBinding: null,
          adminHomeTenantId: null,
        },
        bearerTokenPresented: true,
      }),
      403,
    );
  });
});

describe('requireAdminRole — Phase 2 bearerTokenPresented fail-closed (Tier 1b)', () => {
  beforeEach(() => {
    process.env['NODE_ENV'] = 'test';
  });

  // §8.1 presented-but-rejected JWT cannot fall through to header shim
  it('§8.1a bearerTokenPresented=true + actorContext=undefined → 401 (R2 closure)', () => {
    // Closes Codex R2 HIGH: a presented-but-rejected JWT (invalid sig,
    // expired, wrong tenant, wrong binding) MUST NOT be elevated by a
    // forged x-actor-roles header. The R2 fail-closed branch in
    // requireAdminRole triggers regardless of header contents.
    expectThrowsWithStatus(
      makeReq({
        tenantId: TENANT_US,
        bearerTokenPresented: true,
        // actorContext absent (verification failed)
      }),
      401,
    );
  });

  it('§8.1b bearerTokenPresented=true + forged x-actor-roles=platform_admin → 401 (R2 closure)', () => {
    // The forged admin header CANNOT elevate when a JWT was attempted
    // but rejected. This is the canonical R2 HIGH closure scenario.
    expectThrowsWithStatus(
      makeReq({
        tenantId: TENANT_US,
        headers: {
          'x-actor-roles': 'platform_admin', // FORGED
        },
        bearerTokenPresented: true,
        // actorContext absent (JWT rejected at verify time)
      }),
      401,
    );
  });

  it('§8.1c bearerTokenPresented=true + forged tenant_admin headers → 401 (R2 closure)', () => {
    expectThrowsWithStatus(
      makeReq({
        tenantId: TENANT_US,
        headers: {
          'x-actor-roles': 'tenant_admin', // FORGED
          'x-actor-admin-tenant': TENANT_US, // FORGED
        },
        bearerTokenPresented: true,
      }),
      401,
    );
  });

  it('§8.2 bearerTokenPresented=false + valid x-actor-roles header → header shim allowed (Tier 2 OK)', () => {
    // Sanity: when NO JWT was presented (bearerTokenPresented=false +
    // actorContext=undefined), the legacy Tier 2 header shim is still
    // honored. This is the only branch where header-based admin auth
    // still works post-Phase-2 — and only in non-prod or with
    // ALLOW_ACTOR_HEADER_AUTH=true (covered by §1 tests).
    const req = makeReq({
      tenantId: TENANT_US,
      bearerTokenPresented: false,
      headers: {
        'x-actor-roles': 'platform_admin',
      },
    });
    expect(requireAdminRole(req)).toBe('platform_admin');
  });
});
