import type { FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';

import { mapError as governanceMapError } from './consult-governance.js';
import { mapServiceError as templatesMapError } from './templates.js';

function fakeReply() {
  const sent: { status?: number; body?: unknown } = {};
  const reply = {
    code(status: number) {
      sent.status = status;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    },
  } as unknown as FastifyReply;
  return { reply, sent };
}

// Codex R2 on PR #306: after COMMIT succeeds but its acknowledgement is lost,
// a generic "unavailable" envelope invites a retry under a fresh idempotency
// key and a duplicate write. Both forms routes must preserve the uncertainty.
describe('forms handlers preserve COMMIT uncertainty (PT503)', () => {
  for (const [name, map] of [
    ['consult-governance mapError', governanceMapError],
    ['templates mapServiceError', templatesMapError],
  ] as const) {
    it(`${name}: PT503 -> 503 forms.commit_unconfirmed with a check-status instruction`, () => {
      const { reply, sent } = fakeReply();
      const handled = map(
        Object.assign(new Error('forms.commit_unconfirmed'), { code: 'PT503' }),
        reply,
      );
      expect(handled).toBe(true);
      expect(sent.status).toBe(503);
      expect(sent.body).toMatchObject({
        error: { code: 'forms.commit_unconfirmed' },
      });
      expect((sent.body as { error: { message: string } }).error.message).toMatch(
        /may or may not have been applied/i,
      );
      expect((sent.body as { error: { message: string } }).error.message).toMatch(
        /check its status before retrying/i,
      );
    });

    it(`${name}: a definite failure keeps the generic tenant-blind envelope`, () => {
      const { reply, sent } = fakeReply();
      expect(map(Object.assign(new Error('x'), { code: '23514' }), reply)).toBe(true);
      expect(sent.status).toBe(409);
      expect(sent.body).toMatchObject({ error: { code: 'forms.operation_unavailable' } });
    });

    it(`${name}: an unmapped error is not handled`, () => {
      const { reply } = fakeReply();
      expect(map(new Error('boom'), reply)).toBe(false);
    });
  }
});
