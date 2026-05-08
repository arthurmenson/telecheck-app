# `src/lib/` — cross-cutting platform utilities

Code in this directory is consumed by **every module**. It is the platform's foundation layer.

## Discipline

- **No module-specific logic** in this directory. If it's specific to a single module, it lives under `src/modules/<name>/internal/`.
- **No PHI handling here** beyond the redaction discipline. PHI flows through module repositories.
- **Cross-cutting only**: tenant context, audit envelope, error envelope, idempotency, logger, config, RLS helpers, KMS helpers.

## Files

Each file is a single-responsibility cross-cutting helper. The "Spec reference" column points to the canonical source of behavior. Listed alphabetically per `ls src/lib/*.ts`:

| File | Purpose | Spec reference |
|---|---|---|
| `admin-role.ts` | Tenant-admin RBAC scope check (the actor's `x-actor-admin-tenant` must match the resource's tenant_id) | RBAC v1.1 |
| `ai-context.ts` | AI workload type + autonomy level resolution per ADR-029 / WORKLOAD_TAXONOMY v5.2 | ADR-029 + WORKLOAD_TAXONOMY v5.2 + AUTONOMY_LEVELS v5.2 |
| `audit-dedupe.ts` | Cross-cutting Category A audit-dedupe primitive (`audit_dedupe_markers` claim helper); closes Sprint 33 PR-F2 r4 deferred HIGH on crash-window duplicate audits | Sprint 34 SI-006 audit-dedupe SI; AUDIT_EVENTS v5.2 §Category A; I-019 |
| `audit.ts` | AUDIT_EVENTS v5.2 envelope emitter; hash chain helper; I-027 enforcement | AUDIT_EVENTS v5.2 + INVARIANTS I-003 / I-027 |
| `auth-context.ts` | Fastify plugin: JWT-based actor context (Tier 1) + `x-actor-id` header shim (Tier 2 fallback, gated by `ALLOW_ACTOR_HEADER_AUTH`) | Identity & Authentication Spec v1.0 §3 |
| `config.ts` | Env config loader with Zod validation | (cross-cutting) |
| `crisis-detection.ts` | Crisis-detection guard (platform-floor; never disabled) | INVARIANTS I-019 |
| `db.ts` | pg client wrapper + `withTransaction` helper + test/bench-mode pool overrides | (cross-cutting) |
| `domain-events.ts` | DOMAIN_EVENTS v5.2 outbox emitter; partition_key composition | DOMAIN_EVENTS v5.2 |
| `error-envelope.ts` | Tenant-blind error responses; canonical `ErrorEnvelope` shape (code + message + trace_id + timestamp); no cross-tenant existence leakage | ERROR_MODEL v5.1 + INVARIANTS I-025 |
| `glossary.ts` | Compile-time canonical glossary term enforcement (TypeScript brand types) | GLOSSARY v5.2 |
| `i012-gate.ts` | I-012 reject-unless three-clause rule for prescribing/refill/medication-order | INVARIANTS I-012 + AUDIT_EVENTS v5.2 + STATE_MACHINES v1.1 |
| `i029-gate.ts` | I-029 6-condition reject-unless evaluator for research data export | INVARIANTS I-029 + AUDIT_EVENTS v5.2 + STATE_MACHINES v1.1 |
| `idempotency.ts` | Tenant-scoped idempotency cache + `withIdempotency` reserve-then-execute helper + per-endpoint TTL overrides | IDEMPOTENCY v5.1 + Sprint 33-34 SI-006 closure (`docs/SI-006-Idempotency-Reserve-Then-Execute-Redesign.md` v0.3) |
| `idempotent-handler.ts` | Shared `withIdempotentExecution<TView>(req, reply, mapServiceError, body)` helper for state-changing handlers; body callback receives `(tx, idempotencyCtx)` | Sprint 32 PR-C extraction; PROJECT_CONVENTIONS r5 §3.7 |
| `jwt.ts` | JWT access-token + refresh-token issue/verify | Identity & Authentication Spec v1.0 §3.3 |
| `kms.ts` | Per-tenant KMS key resolution (AWS KMS in prod; local dev uses static keys) | ADR-024 |
| `logger.ts` | Pino logger factory with PHI redaction | AUDIT_EVENTS v5.2 PHI redaction |
| `rls.ts` | Postgres RLS session-variable setter; query-time tenant scoping | ADR-023 |
| `tenant-context.ts` | Resolves tenant context at request time; exposes via Fastify decorator | ADR-023 + ADR-024 + Tenant Threading Addendum v1.0 |
| `ulid.ts` | ULID generation + branded-ID helpers | (cross-cutting) |

Co-located unit tests at `<file>.test.ts` exist for helpers that benefit from in-process testing (currently `auth-context.test.ts`, `jwt.test.ts`, `ulid.test.ts`). The remaining helpers are exercised via integration tests under `tests/integration/`.

## Status

**Foundation layer landed across Sprints 1–34.** Every file in the table above is in active use. Notable post-bootstrap additions:

- Sprint 32 PR-C: `idempotent-handler.ts` (extracted from per-module duplication of the `withIdempotentExecution` body shape)
- Sprint 34 PR #49: `audit-dedupe.ts` (cross-cutting Category A dedupe primitive used by `runCrisisGate` and any future Category A emitter on idempotency-protected paths)

The reserve-then-execute idempotency redesign (SI-006) closed across Sprint 33-34 as the canonical pattern for state-changing handlers in this codebase. See `docs/SI-006-Idempotency-Reserve-Then-Execute-Redesign.md` v0.3 "Implementation Closure" section for the cross-cutting flow + `docs/PROJECT_CONVENTIONS.md` r5 §3.7 / §3.8 / §3.9 for the codified patterns.
