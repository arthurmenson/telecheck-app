# Sprint 1.2b vendor boundary — implementation status

**Status: DRAFT / NOT ACTIVE.** The local scanner and provider wrapper are implemented and tested. `resolveClinicalProvider` does not yet install the wrapper, so this branch does not claim production Layer 4 enforcement or sprint completion.

## Implemented components

- `vendor-payload-screening.ts` uses only the local regex library. It blocks high-confidence matches and returns a cloned, redacted request for lower-confidence matches. Block results contain no payload or matched values.
- System messages are checked after the exact `\n\n` concatenation used by the current Anthropic adapter. Non-system turns retain their order. Clean wire bodies are unchanged.
- Every current regex category is covered, including validation and overlap behavior. Shared regex cursors are not modified.
- Redaction can expose new regex boundaries. After each replacement pass the scanner checks all resulting prompt fields again, blocking newly exposed high-confidence hits and removing newly exposed low-confidence hits. Only a match-free pass releases the payload; exhaustion of the bounded pass budget fails closed. This closes the independent R1 finding reproduced with `::1MRN 543210` and `::1passport no. AB1234567`.
- Unknown request/message fields fail closed. Compile-time field coverage requires a screening decision if the provider request interface grows; tool content is currently unsupported and must not pass uninspected.
- `vendor-boundary.ts` composes with an arbitrary `LLMProvider`. It requires an explicit decision recorder, awaits it before any redacted dispatch, and prevents dispatch for blocked, screening-failed, or recorder-failed requests. The recorder receives metadata only. Candidate-bearing recorder exceptions are not propagated.
- Tests capture actual serialized Anthropic bodies through a fake transport, verify blocked requests never reach it, and check audit ordering and snapshot isolation during asynchronous recording. The fake recorder is test evidence for callback ordering, not proof of durable audit persistence.

## Prerequisites before resolver wiring and merge

The detailed Layer 4 section in `PII_SCREENING_AND_LOG_REDACTION_SPEC.md` requires `pii.screener.egress_block` and `pii.screener.egress_redact`. They are absent from the verified canonical AUDIT_EVENTS v5.4 catalog and the implementation's `AuditAction` union. The PII spec itself calls for screener-event registration through an SI extension. Event classification, required detail, and durable retry semantics need the contract-owner decision; this branch registers no canonical actions.

The detailed high-confidence block rule also conflicts with the PII document's unconditional-send non-goal. The components follow the detailed Layer 4 decision rule, pending explicit resolution of that prose conflict.

Required remaining work:

1. Ratify the narrow event registration and durability behavior using the required independent recommendations. Do not infer approval from the draft components.
2. Implement the approved recorder with trusted tenant/actor context and existing append-only audit primitives. Its promise must resolve only after durable commit, independently of a business transaction that might roll back.
3. Wire the wrapper centrally around every real provider returned by `resolveClinicalProvider`, including both credential resolution paths. Preserve the Null provider's fail-soft behavior.
4. Map `VendorEgressBlockedError` to the specified tenant-blind `500 ai.provider.egress_blocked`. Map audit failure through the approved unavailable-audit path. Preserve crisis ordering and unrelated provider errors.
5. Add DB-backed tests for durable evidence after rollback, provider failures, retry deduplication, cross-tenant isolation, and audit failure. Add resolver/HTTP integration tests proving the active path uses the wrapper.
6. Obtain independent adversarial approval of the complete diff and green full CI before merge. Append the required Addendum and cockpit revision after merge.

## Limits that remain explicit

Regex-only screening cannot identify names or prose addresses. Pilot 1 Day-0 remains blocked on the separately documented NER remedy and other operator gates. No component here performs external classification, changes crisis behavior, changes canonical schema, or authorizes a deployment.

The streaming performance prerequisite merged through PR #282 as `bbfbe534bdfb111b824de3aa409a03259fb5756d`. This branch is rebased on that main commit; the Layer 4 PR diff remains separate from the streaming patch.
