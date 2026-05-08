# `src/modules/` — modular monolith per ADR-001

Each subdirectory is a **module** — one of the 22 platform modules described in `Telecheck_System_Architecture_v1_2.md` §13.

## Discipline

- **One module per directory.** Module name is the directory name.
- **Public interface lives at `<module>/index.ts`.** Anything else in the module is internal.
- **Internal code lives in `<module>/internal/`.** Cross-module imports of `internal/*` are forbidden (enforced via ESLint `import/no-restricted-paths` once first slice begins).
- **Database access is module-local.** No module reaches into another module's tables directly. Cross-module data flow is via:
  - Public function calls on the other module's `index.ts` interface
  - Domain events (`DOMAIN_EVENTS` v5.2) for async / fan-out
- **Per ADR-001** the boundaries are extraction-ready — any module could be lifted into its own deployable later without breaking the public-interface contract.

## Module list (per System Architecture v1.2 §13 + v1.10 cycle additions)

To be scaffolded as slices begin. Per EHBG §10 build sequence, the foundation slices come first:

1. **Forms / Intake** (`forms-intake/`) — Forms Engine four-layer architecture (Pattern A immutable per-market form versions)
2. **Identity / Auth** (`identity/`) — Identity & Auth Spec v1.0
3. **Tenant Configuration** (`tenant-config/`) — CCR runtime; ProgramCatalogEntry + ProgramMarketPolicy
4. **Audit** (`audit/`) — AUDIT_EVENTS v5.2 envelope emitter + hash chain (cross-cutting; consumed by every other module)
5. **Consent** (`consent/`) — including 5th-tier `research_data_use` consent per ADR-028
6. **Pharmacy + Refill** (`pharmacy/`) — Pharmacy + Refill Slice PRD v2.1
7. **Async Consult** (`async-consult/`)
8. **Sync Video Consult** (`sync-consult/`) — LiveKit per ADR-021
9. **AI Clinical Assistant** (`ai-clinical/`) — Mode 1 + Mode 2 per ADR-002 (preserved at v1.0 active levels per ADR-029)
10. **AI Service** (`ai-service/`) — multi-provider abstraction per ADR-020; WORKLOAD_TAXONOMY v5.2 routing
11. **Medication Interaction Engine** (`interaction-engine/`)
12. **Herb-Drug Interaction Engine** (`herb-drug/`)
13. **Labs Document Interpretation** (`labs/`)
14. **Adverse Event Reporting** (`adverse-events/`)
15. **Fake Medication Detection** (`fake-med/`)
16. **RPM / CCM** (`rpm-ccm/`)
17. **Community Platform** (`community/`)
18. **Acquisition / Engagement Tools** (`acquisition/`)
19. **Admin Backend** (`admin/`) — Tier-1 ecom + Market Rollout Cockpit
20. **Notification** (`notification/`) — channel hierarchy with tenant variant resolution
21. **Messaging Inbox** (`messaging/`)
22. **Research Data** (`research/`) — NEW per ADR-028; Posture A; I-029 6-condition gate enforcement; I-031 high_pii audit class

## Module template

When creating a new module, the canonical layout is:

```
<module-name>/
├── index.ts              # public interface (what other modules can import)
├── routes.ts             # Fastify route registration
├── internal/
│   ├── handlers/         # route handler implementations
│   ├── services/         # business logic
│   ├── repositories/     # database access (module-local tables only)
│   └── types.ts          # internal types not exposed via index.ts
├── schemas.ts            # Zod schemas for request/response validation
├── events.ts             # domain event emitters (per DOMAIN_EVENTS v5.2)
├── audit.ts              # audit envelope emitters (per AUDIT_EVENTS v5.2)
└── README.md             # module-specific notes; references to slice PRD
```

The **`slice-implementation` skill** (per EHBG §13, configured under `.claude/skills/`) walks Claude Code through the read-spec → scaffold-module flow.

## Status

**5 modules implementation-complete + 3 BLOCKED-aware skeletons as of Sprint 34 (2026-05-08).** The remaining 14 modules from the System Architecture v1.2 §13 list await slice authoring.

### Implementation-complete (v1.0 surface)

| Module | Directory | Slice PRD | Notable Sprint 33-34 work |
|---|---|---|---|
| **Forms / Intake Engine** | `forms-intake/` | v2.1 | Sprint 33 PR-F2 reserve-then-execute migration (10 handlers); Sprint 34 PR #49 audit-dedupe wiring into `runCrisisGate` |
| **Identity & Auth** | `identity/` | v1.0 | Sprint 33 PR-F3 reserve-then-execute migration (8 handlers); 900s TTL override on auth-flow paths; sessionRefresh exempt-paths fix |
| **Consent + Delegated Access** | `consent/` | v1.0 | Sprint 32 PR-C established the reserve-then-execute pattern PR-F2/F3 then mirrored; Sprint 34 cleanup-sweep removed legacy markers |
| **Async Consult** | `async-consult/` | v1.0 | Sprint 33 PR-F-prep migration (5 handlers); Sprint 34 PR #51 added comprehensive HTTP integration tests + handler `InvalidTransitionError` 500-leak fix |
| **Tenant Configuration** | `tenant-config/` | v1.0 (read-only paths); Admin Backend v1.1 ratification pending for write paths | Sprint 33 PR-F4 503-stub markers (admin-write fail-closed pending Admin Backend slice ratification) |

### BLOCKED-aware module skeletons (v0.1 health probes only)

| Module | Directory | Blocker |
|---|---|---|
| **Pharmacy + Refill** | `pharmacy/` | SI-001 (MedicationRequest schema gap) |
| **Subscription** | `subscription/` | SI-001 (binds to MedicationRequest via `medication_request_id`) |
| **Medication Interaction Engine** | `med-interaction/` | Med Interaction Engine slice PRD ratification |

Each skeleton ships `routes.ts` returning `{ status: 503 }` on slice-specific endpoints + `{ status: 200 }` on `/health`. Ready to flip to real implementation as soon as the upstream blocker closes.

### Cross-cutting wins from Sprint 33-34 SI-006 closure

- All 5 implementation-complete modules' state-changing handlers migrated to handler-owned `withIdempotency` (no legacy onSend cache-write hook anywhere — `tests/integration/idempotency-helper.test.ts` Group F source-grep lockdown pins the absence)
- Cross-cutting Category A audit-dedupe primitive (`src/lib/audit-dedupe.ts`) used by `runCrisisGate` in forms-intake; ready for any future Category A emitter
- Per-PR Codex adversarial review across the 9-PR SI-006 cycle closed 18 substantive findings (11 HIGH + 7 MEDIUM)

See `docs/BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` r5 + `docs/SI-006-Idempotency-Reserve-Then-Execute-Redesign.md` v0.3 + the per-slice status docs (`docs/{CONSENT,IDENTITY,FORMS_INTAKE,PHARMACY}_SLICE_STATUS_2026-05-05.md`) for the full state.
