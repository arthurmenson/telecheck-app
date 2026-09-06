# Sprint 1.2b vendor boundary — implementation status

**Status: implemented for the active Mode 1 clinical path; merge requires independent review and green full CI.** The canonical contract is AUDIT_EVENTS v5.5 / P-047 in `arthurmenson/telecheckONE`. The user authorized autonomous completion under counsel recommendations on 2026-09-06; the preserved decision packet records the recommendations and delegated execution authority.

## Enforcement

- `resolveClinicalProvider` installs the boundary on both real credential paths: admin-managed DB key and environment fallback. It requires trusted Mode 1 attribution and the matching pending idempotency reservation, including for clean sends. Unconfigured Null behavior and credential healthchecks retain their existing behavior.
- `vendor-payload-screening.ts` snapshots supported data properties, rejects unknown/accessor fields and mismatched tenant/workload, and uses the existing local regex library without NER or an external classifier. System messages are scanned after the exact two-newline join used by the serializer; other turns retain their order.
- High-confidence matches block before transport. Lower-confidence matches are replaced with `[REDACTED:PII]`. Subsequent passes catch identifiers exposed by replacement; only a match-free pass releases the payload. Exhausting the bounded pass budget fails closed. This closes the independent review finding reproduced with `::1MRN 543210` and `::1passport no. AB1234567`.
- The wrapper requires a durable recorder. A local block returns the tenant-blind `500 ai.provider.egress_blocked`; recording failure returns `503 ai_chat.audit_emission_unavailable`. Neither becomes a provider outage. Genuine upstream failures retain the existing Mode 1 fail-soft response; the crisis gate still runs before Layer 1.

## Durable evidence

`vendor-audit.ts` records the two unsampled Category B actions through existing tenant-bound append-only audit primitives on the tenant governance chain (`target_patient_id = null`). Its seven-field detail contains only layer, provider, patient ID, message ID, sorted pattern IDs, accepted-match count and closed reason. Screening failure uses an unknown count (`null`). Candidate strings, candidate fingerprints, matched values, credentials and raw diagnostic errors never enter this event.

The recorder uses a fresh transaction and commits before a redacted send or local block. A namespaced marker and its audit event commit atomically. Equivalent candidates reuse committed evidence within the original reservation window; retries rescreen, changed raw candidates/rules/model/control values and trusted identities do not reuse evidence, and expired markers are reclaimed without a cleanup job. The reservation is read in the caller's transaction, preserving PostgreSQL microseconds. Pool acquisition and SQL waits are bounded; any failure prevents dispatch. No schema, roles, outbox or audit partition changes are needed.

## Verification

- DB-free tests cover every regex category across all prompt roles, assembled-system matches, overlap/validation, mutation and accessor rejection, bounded rescanning, fingerprints, both resolver credential paths, scope/context failures, actual Anthropic JSON serialization, and awaited audit-before-send ordering.
- HTTP tests exercise the real chat handler, resolver and adapter with a fake vendor transport. A selective test-only Layer 1 bypass exposes the defense-in-depth Layer 4 path; separate cases keep Layer 1 and crisis behavior intact. The recorder callback is mocked here, while independent-connection database tests prove durability.
- PostgreSQL tests use real separate connections and existing non-superuser/RLS behavior. They cover outer rollback, post-audit provider failure, failed INSERT rollback, lost COMMIT acknowledgement, concurrent claims, changed identities, cross-tenant isolation, exact expiry, expiry races, hash-chain integrity, pool saturation and audit-chain lock contention.

Review and full CI results belong to PR #283 and the post-merge Addendum; this file describes implemented behavior, not a deployment authorization.

## Scope and remaining launch gates

Mode 1 is the only currently active clinical provider caller. Mode 2 retains the Null provider. The admin credential probe sends the fixed literal `ping` with no patient-controlled prompt; changing that requires a reviewed boundary and attribution contract.

Regex-only screening does not identify every name or prose address. The separate Pilot 1 Day-0 NER remedy and operator gates remain. Layer 4 completion does not claim zero PHI for arbitrary natural language or authorize deployment.

The streaming performance prerequisite merged through PR #282 as `bbfbe534bdfb111b824de3aa409a03259fb5756d`, preserving all existing security assertions. PR #283 is based on that commit.
