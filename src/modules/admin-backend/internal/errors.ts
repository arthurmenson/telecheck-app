/**
 * admin-backend/internal/errors.ts — typed errors raised by the
 * admin-backend module's SECDEF wrapper callers.
 *
 * The admin-backend module's WRITE handlers call ratified SECURITY DEFINER
 * wrappers (migrations 043 + 052) rather than building UPDATEs in TS repos.
 * The wrapper raises PG SQLSTATEs that the application layer maps to HTTP
 * envelopes. For state-conflict cases that need to be discriminable at the
 * route layer (and observable in unit tests without spinning up Postgres),
 * we wrap the raw PG error in a TYPED error class so the mapper can branch
 * on a stable discriminator instead of stringly-typed SQLSTATE comparisons.
 *
 * Atomicity invariant: typed errors thrown from inside the
 * `withIdempotentExecution` body still propagate out of the helper's
 * transaction wrapper and roll the active transaction back. This is the
 * rollback-preserving alternative to a structured return — we keep the
 * throw, we just give the route layer a way to discriminate the cause.
 *
 * Mirrors the forms-intake `repos/errors.ts` pattern (PR #11 commit 001dbbd —
 * Codex R2 APPROVE). The shape is intentionally identical so cross-module
 * Codex reviews can see the F2-style closure pattern at a glance.
 *
 * Spec references:
 *   - ERROR_MODEL v5.1 (HTTP error envelope shape)
 *   - I-025 (tenant-blind error messages — internal IDs in error metadata
 *     stay in server logs; the user-facing message produced by the route
 *     layer must not leak templateId/tenantId/PHI)
 *   - telecheck-forms-intake commit 001dbbd (F2 pattern; canonical reference)
 */

/**
 * Thrown by the submit-for-review handler when the SECDEF wrapper raises
 * 42P17 (invalid_object_state) indicating the parent `forms_template` row
 * is not in `draft` status (or has been soft-deleted) at the moment the
 * wrapper's FOR UPDATE lock acquires. The status check is atomic with the
 * FOR UPDATE — no TOCTOU window between the lock acquisition and the state
 * derivation — so the conflict is real (not a stale-client race) but
 * client-recoverable: refresh the template, see its new status, and retry
 * if appropriate.
 *
 * The route layer catches this and returns 409 with a tenant-blind body.
 * `templateId` + `tenantId` are exposed as instance fields for server-side
 * logging only; they must NOT be echoed back to the client.
 *
 * Per PR #205 Codex R1 Finding 1 closure + migration 052.
 */
export class TemplateStateConflictError extends Error {
  readonly code = 'template_state_conflict' as const;
  readonly templateId: string;
  readonly tenantId: string;

  constructor(templateId: string, tenantId: string, reason: string) {
    super(`Template ${templateId} (tenant ${tenantId}) ${reason}`);
    this.name = 'TemplateStateConflictError';
    this.templateId = templateId;
    this.tenantId = tenantId;
  }
}
