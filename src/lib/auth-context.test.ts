/**
 * auth-context.ts — direct unit-coverage on requireActorContext +
 * UnauthenticatedError.
 *
 * The Fastify hook itself (authContextPlugin) is exercised end-to-end
 * by tests/integration/identity-jwt-end-to-end.test.ts. This file
 * focuses on the PURE-function exports that handlers consume.
 *
 * Coverage in this file (2 sections, 6 cases):
 *
 *   §1 requireActorContext (4 cases):
 *      §1a returns actor context when populated
 *      §1b throws UnauthenticatedError when undefined
 *      §1c thrown error has statusCode=401 + canonical code
 *      §1d does not mutate req.actorContext on the happy path
 *
 *   §2 UnauthenticatedError (2 cases):
 *      §2a constructor sets statusCode=401, code, name, message
 *      §2b instanceof Error
 *
 * Spec references:
 *   - auth-context.ts (target)
 *   - I-025 (tenant-blind 401; the error code/message MUST NOT carry
 *     tenant identifiers)
 */

import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { UnauthenticatedError, requireActorContext, type ActorContext } from './auth-context.ts';
import { asTenantId } from './glossary.ts';

const ACTOR: ActorContext = {
  accountId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  sessionId: '01ARZ3NDEKTSV4RRFFQ69G5SES',
  tenantId: asTenantId('Telecheck-US'),
  role: 'patient',
  countryOfCare: 'US',
  delegateId: null,
  adminTenantBinding: null,
};

function makeStubReq(ctx: ActorContext | undefined): FastifyRequest {
  return { actorContext: ctx } as unknown as FastifyRequest;
}

// ---------------------------------------------------------------------------
// §1 — requireActorContext
// ---------------------------------------------------------------------------

describe('requireActorContext — pure-function guard', () => {
  it('§1a returns actor context when populated', () => {
    const req = makeStubReq(ACTOR);
    const result = requireActorContext(req);
    expect(result).toBe(ACTOR);
    expect(result.accountId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(result.tenantId).toBe('Telecheck-US');
  });

  it('§1b throws UnauthenticatedError when actorContext is undefined', () => {
    const req = makeStubReq(undefined);
    expect(() => requireActorContext(req)).toThrow(UnauthenticatedError);
  });

  it('§1c thrown error carries statusCode=401 + canonical code', () => {
    const req = makeStubReq(undefined);
    let thrown: unknown = null;
    try {
      requireActorContext(req);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnauthenticatedError);
    if (thrown instanceof UnauthenticatedError) {
      expect(thrown.statusCode).toBe(401);
      expect(thrown.code).toBe('internal.auth.unauthenticated');
      expect(thrown.message).toBe('Authentication is required.');
    }
  });

  it('§1d does not mutate req.actorContext on happy path', () => {
    const req = makeStubReq(ACTOR);
    requireActorContext(req);
    expect((req as { actorContext: ActorContext }).actorContext).toBe(ACTOR);
    expect((req as { actorContext: ActorContext }).actorContext.accountId).toBe(
      '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    );
  });
});

// ---------------------------------------------------------------------------
// §2 — UnauthenticatedError
// ---------------------------------------------------------------------------

describe('UnauthenticatedError', () => {
  it('§2a sets statusCode/code/name/message', () => {
    const err = new UnauthenticatedError();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('internal.auth.unauthenticated');
    expect(err.name).toBe('UnauthenticatedError');
    expect(err.message).toBe('Authentication is required.');
  });

  it('§2b is an Error instance', () => {
    const err = new UnauthenticatedError();
    expect(err).toBeInstanceOf(Error);
  });
});
