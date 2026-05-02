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

**Empty at bootstrap.** The first slice (Forms/Intake per EHBG §10) creates the first module here.
