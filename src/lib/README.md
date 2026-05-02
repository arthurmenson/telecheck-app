# `src/lib/` — cross-cutting platform utilities

Code in this directory is consumed by **every module**. It is the platform's foundation layer.

## Discipline

- **No module-specific logic** in this directory. If it's specific to a single module, it lives under `src/modules/<name>/internal/`.
- **No PHI handling here** beyond the redaction discipline. PHI flows through module repositories.
- **Cross-cutting only**: tenant context, audit envelope, error envelope, idempotency, logger, config, RLS helpers, KMS helpers.

## Expected files (filled in by foundation-layer agents)

| File | Purpose | Spec reference |
|---|---|---|
| `tenant-context.ts` | Resolves tenant context at request time; exposes via Fastify decorator | ADR-023 + ADR-024 + Tenant Threading Addendum v1.0 |
| `audit.ts` | AUDIT_EVENTS v5.2 envelope emitter; hash chain helper; I-027 enforcement | AUDIT_EVENTS v5.2 + INVARIANTS I-003 / I-027 |
| `error-envelope.ts` | Tenant-blind error responses; no cross-tenant existence leakage | ERROR_MODEL v5.1 + INVARIANTS I-025 |
| `idempotency.ts` | Tenant-scoped idempotency key handling | IDEMPOTENCY contract v5.1 |
| `domain-events.ts` | DOMAIN_EVENTS v5.2 outbox emitter; partition_key composition | DOMAIN_EVENTS v5.2 |
| `rls.ts` | Postgres RLS session-variable setter; query-time tenant scoping | ADR-023 |
| `kms.ts` | Per-tenant KMS key resolution (AWS KMS in prod; local dev uses static keys) | ADR-024 |
| `i029-gate.ts` | I-029 6-condition reject-unless evaluator for research data export | INVARIANTS I-029 + AUDIT_EVENTS v5.2 + STATE_MACHINES v1.1 |
| `i012-gate.ts` | I-012 reject-unless three-clause rule for prescribing/refill/medication-order | INVARIANTS I-012 + AUDIT_EVENTS v5.2 + STATE_MACHINES v1.1 |
| `ai-context.ts` | AI workload type + autonomy level resolution per ADR-029 / WORKLOAD_TAXONOMY v5.2 | ADR-029 + WORKLOAD_TAXONOMY v5.2 + AUTONOMY_LEVELS v5.2 |
| `crisis-detection.ts` | Crisis-detection guard (platform-floor; never disabled) | INVARIANTS I-019 |
| `glossary.ts` | Compile-time canonical glossary term enforcement (TypeScript brand types) | GLOSSARY v5.2 |
| `config.ts` | Env config loader with Zod validation | (cross-cutting) |
| `logger.ts` | Pino logger factory with PHI redaction | AUDIT_EVENTS v5.2 PHI redaction |

## Status

**Empty at bootstrap.** Foundation-layer agents (appsec-expert, database-integration-expert) populate this directory in the next commit.
