# Telecheck — Project Context for Claude Code

> **New here / zero context?** Read `telecheckONE/TELECHECK_TEAM_HANDOFF.md` first — it maps all 6 repos, the staging environment, credentials to provision, and how to resume. Then come back to this file for build rules.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

This is the **Telecheck application code repo** — the implementation of the spec corpus described in the Telecheck Master Bundle.

Telecheck is a multi-tenant AI-powered telehealth platform. At launch, two operating tenants are active:

- **Telecheck-US** (operating tenant, US, greenfield; operated by Telecheck Health LLC; trading patient-facing as **Heros Health** consumer DBA at heroshealth.com)
- **Telecheck-Ghana** (operating tenant, Ghana, chronic-care anchor; operated by Telecheck-Ghana Ltd.; trading patient-facing as **Heros Health Ghana** consumer DBA at ghana.heroshealth.com)

Architecture is global. Code, schema, audit, and config use operating-tenant identifiers (`Telecheck-{country}`); patient-facing surfaces source the consumer DBA via `tenant.consumer_dba`, never from `tenant.id`. Bare `Heros` is forbidden as a tenant or operator identifier outside §17 contextual carve-outs per Master PRD v1.10 §17 + Glossary v5.2 C3 brand structure.

This repo was bootstrapped from the EHBG §13 CLAUDE.md template (post-v1.10 canonical state, 2026-05-02). See `docs/README.md` for the spec corpus pointer.

## Spec corpus location

The authoritative specification corpus lives at the sibling repo `arthurmenson/telecheckONE` (clone to `../telecheckONE/`). Expected layout:

```
<workspace>/
├── telecheckONE/                                     ← spec corpus (this repo's source of truth)
│   ├── Telecheck Master Bundle FINAL US REGION BASELINE/
│   │   ├── Telecheck_Master_Platform_PRD_v1_10.md   ← canonical PRD
│   │   ├── Telecheck_Artifact_Registry_v2_10.md     ← which version of what
│   │   ├── Telecheck_ADR_Set_v1_0.md + addenda      ← architecture decisions
│   │   ├── Telecheck_Canonical_Data_Model_v1_2.md   ← entity schemas
│   │   ├── Telecheck_OpenAPI_v0_2.md                ← endpoint contracts
│   │   ├── Telecheck_State_Machines_v1_1.md         ← state transitions
│   │   ├── Telecheck_RBAC_Permissions_Matrix_v1_1.md
│   │   ├── Telecheck_Contracts_Pack_v5_00_*.md      ← runtime contracts (v5.2 in headers)
│   │   ├── Telecheck_*_Slice_PRD_v*.md              ← per-feature specs
│   │   └── ... (87 .md files total)
│   ├── Telecheck_v1_10_PRD_Update/                   ← v1.10 cycle audit-trail
│   └── telecheck-design-system/                      ← UI design handoff (DIC v1.1 binding)
└── telecheck-app/                                    ← THIS REPO (implementation)
```

If the spec is not at `../telecheckONE/`, set `TELECHECK_SPEC_PATH` env var to its actual location, or symlink `docs/spec` → spec bundle.

## How to find authoritative answers

- **WHAT to build:** `Telecheck_Master_Platform_PRD_v1_10.md`
- **WHICH version of any artifact:** `Telecheck_Artifact_Registry_v2_10.md`
- **ARCHITECTURE decisions:** `Telecheck_ADR_Set_v1_0.md` + Addendum 016–019 + Addendum 020–025 (with ADR-025 superseded by ADR-026) + Addendum 026 + ADR-027 + ADR-028 + ADR-029
- **API surface:** `Telecheck_OpenAPI_v0_2.md` (187 endpoints across 22 modules)
- **DATA model:** `Telecheck_Canonical_Data_Model_v1_2.md` (48 active entities + 7 reserved-future)
- **STATE machines:** `Telecheck_State_Machines_v1_1.md` (18 active state machines + 4 reserved-future transitions on ProtocolAuthorizedAction per ADR-029)
- **RUNTIME contracts:** `Telecheck_Contracts_Pack_v5_00_*.md` (v5.2 for 11 amended/new files post-v1.10 cycle: INVARIANTS, AUDIT_EVENTS, DOMAIN_EVENTS, CCR_RUNTIME, GLOSSARY, TYPES, AI_LAYERING, FORMS_ENGINE, GOVERNANCE_CONTROLS amended + WORKLOAD_TAXONOMY + AUTONOMY_LEVELS new; ERROR_MODEL + IDEMPOTENCY + SOURCE_OF_TRUTH preserved at v5.1; MARKET_LAUNCH at v5.1)
- **RBAC:** `Telecheck_RBAC_Permissions_Matrix_v1_1.md` (Platform Admin + Tenant Admin hierarchies; v1.10 cycle adds 3 research roles)
- **TENANT THREADING for v1.0 slices:** `Telecheck_Tenant_Threading_Addendum_v1_0.md`
- **PER-FEATURE detail:** `Telecheck_*_Slice_PRD_v*.md` (17 slices)
- **DESIGN authority:** `Telecheck_Design_Implementation_Contract_v1_1.md` (Canonical for development; Patient mock v7 binding visual reference)

## Read before implementing anything

1. The slice PRD for the feature you're implementing
2. The Tenant Threading Addendum §3.X if the slice is at v1.0
3. The relevant ADRs (especially ADR-023 multi-tenancy, ADR-024 country config, ADR-029 AI workload taxonomy if AI-related)
4. The state machine for the entity you're touching
5. The OpenAPI definition for the endpoints involved
6. The contract files referenced by the slice PRD (especially Contracts Pack v5.2 INVARIANTS, AUDIT_EVENTS, GLOSSARY, TYPES)
7. For research data work: ADR-028 + INVARIANTS I-029 (6-condition reject-unless gate) / I-030 / I-031
8. For marketing surfaces: ADR-027 + I-029 enforcement at the surface-rendering layer

## Hard rules — never violate

- **Audit table is append-only.** Never UPDATE or DELETE an audit row. Hash chain integrity must hold. **I-003**.
- **Audit records carry tenant_id. Always.** **I-027**.
- **Every PHI-touching query is tenant-filtered.** Three-layer enforcement (RLS + app-layer middleware + per-tenant KMS). **I-023**.
- **Cross-tenant access requires break-glass with audit.** **I-024**.
- **Error responses do not leak cross-tenant existence.** **I-025**.
- **AI content always carries:** `source_type`, `ai_workload_type` (per ADR-029 / WORKLOAD_TAXONOMY), `ai_mode` (legacy Mode 1 / Mode 2 per ADR-002 preserved at v1.0 active levels), `model_version`, `guardrail_template_id` (Mode 1) or `protocol_id`+`version` (Mode 2). No exceptions.
- **Crisis detection is platform-floor.** Never disable, never gate behind config. Active in chat, voice (future), community. **I-019**.
- **Interaction engine runs BEFORE clinician commits prescription.** Not after, not in parallel.
- **Cross-module data access is via module public interface only.** No direct DB queries across module boundaries. ADR-001 modular monolith.
- **No hardcoded country assumptions.** Use CCR (`country_of_care` drives protocols, formularies, payment, SMS, regulatory module). **I-009**.
- **Tenant `country_of_care` is treated as immutable post-creation.** **I-026**.
- **I-012 reject-unless three-clause rule** for prescription/refill/medication-order execution: `autonomy_level == action_with_confirm` (string equality) AND explicit clinician confirmation in audit chain AND confirming actor RBAC-authorized. Rejection MUST emit `<action_class>.execution_rejected` audit event. Bare suppression on rejection is forbidden per I-003.
- **I-029 6-condition reject-unless gate** for `research.export_completed` `ready → delivered` transition: DSA active + k-anonymity floor + permitted-domain match + consent-cohort hash match + per-patient active consent + per-export grant artifact unexpired/ID-hash-matched/signer-chain-attesting. Failed delivery MUST emit `research.export_completed(status=invalidated)` with canonical 6-value `invalidation_reason` enum + paired `signal_enforcement_trigger` Category B audit.
- **I-031** research data export emits at `audit_sensitivity_level: high_pii`.
- **Glossary terms are canonical.** Use `medication_request` (not `prescription`), `Mode 1` / `Mode 2` (not `chatbot`), `tenant` (not `customer`). Forbidden aliases enumerated in `Telecheck_Contracts_Pack_v5_00_GLOSSARY.md`.

## Tech stack

- **TypeScript everywhere** (Node.js 20 LTS for backend; React 18+ for web; React Native for mobile per ADR-022)
- **Fastify** (backend HTTP framework)
- **PostgreSQL 15+ with Row-Level Security** policies (per ADR-023 multi-tenancy)
- **Prisma** (ORM with type generation; tenant-scoped middleware per RLS pattern)
- **Redis** (cache + queues)
- **LiveKit self-hosted** (sync video per ADR-021)
- **AWS us-east-1 primary, us-west-2 cold DR** (per ADR-026; supersedes ADR-025)
- **Anthropic Claude** (clinical AI primary; multi-provider abstraction per ADR-020)
- **AWS Bedrock + Azure OpenAI** (resilience providers)
- **AWS Textract Medical** (lab OCR)
- **Native-first / open-source-first / self-hosted-first** per ADR-022

## Code conventions

- One module per directory under `src/modules/`
- Each module exports a public interface from `src/modules/<name>/index.ts`
- Internal module code (not for cross-module access) lives in `src/modules/<name>/internal/`
- Tests live alongside code: `<file>.test.ts`
- Migrations are in `migrations/`, sequentially numbered, reviewed by Engineering Lead
- Use canonical glossary terms only (per Contracts Pack v5.2 GLOSSARY)
- Tenant context resolved at request time via middleware; available via `req.tenantContext` in route handlers
- AI workload type + autonomy level resolved at AI-call time via WORKLOAD_TAXONOMY contract; available via `req.aiContext` if applicable

## Workflow

1. Read the slice PRD for what you're building
2. Read the relevant Tenant Threading Addendum section if slice is at v1.0
3. Implement state machine transitions per State Machines v1.1
4. Implement endpoints per OpenAPI v0.2
5. Reference CDM v1.2 for entity schemas (do NOT author new schemas — flag via §12 SI/DSI escalation if needed)
6. Emit domain events per DOMAIN_EVENTS v5.2 envelope (with tenant_id)
7. Emit audit events per AUDIT_EVENTS v5.2 envelope (with tenant_id, ai_workload_type, autonomy_level where applicable per I-012 envelope-population rule)
8. Write tests covering happy path + tenant-isolation cases (cross-tenant access denied) + state-machine guards + I-029 6-condition gate (for research) + I-012 reject-unless (for prescribing)
9. Submit PR; CI runs lint, type-check, tests, OpenAPI validation, schema migration validation
10. PR review by another engineer + design review if UI surface (per DIC v1.1)

## When stuck

- **Spec ambiguous?** Use §12 SI/DSI escalation pattern (see `Telecheck_Engineering_Handoff_Build_Guide_v1_3.md` §12)
- **Architectural decision needed?** Engineering Lead
- **Clinical safety question?** Tenant Clinical Lead (or Platform Clinical Governance for cross-tenant)
- **Privacy / break-glass question?** Platform Privacy Officer
- **AI behavior unexpected?** Platform AI Safety
- **Performance issue?** Document, profile, then bring to Engineering Lead
- **Brand structure / DBA / consumer surface confusion?** See Master PRD v1.10 §17 + Glossary v5.2 C3 brand-structure rules

## Specific gotchas

- A subscription with the same `patient_id` but different `tenant_id` is **two distinct entities**. Cross-tenant patient identity does NOT federate at launch.
- Idempotency keys are **tenant-scoped** per IDEMPOTENCY contract v5.1. Same key in different tenants is independent.
- Domain event `partition_key` for tenant-scoped aggregates is composite (`tenant_id:aggregate_id`) per DOMAIN_EVENTS v5.2.
- Error envelopes for resource-not-found are **tenant-blind** (do not differentiate "doesn't exist" vs "exists in another tenant"). I-025.
- `tenant.id = "Telecheck-{country}"` is the operating-tenant identifier (used in audit, RLS, KMS, API path scoping). Patient-facing UI sources the consumer DBA via `tenant.consumer_dba` (e.g., "Heros Health"). Never render `tenant.id` to a patient.
- Reserved AI workload types (`autonomous_agent`, `multi_agent_supervisor`, `tool_using_agent`) and reserved autonomy levels (`action_with_audit_only`, `fully_autonomous`) per WORKLOAD_TAXONOMY v5.2 are NOT implemented as executable code paths at v1.0 — they require successor ADR (030+) AND activation audit event.
- DIC v1.1 is **Canonical for development** (post-v1.10 promotion 2026-05-01). Patient mock v7 (`telecheck-design-system/project/Patient interactive mock v7.html` + companions) is the **binding visual reference**.

## Canonical versions (post-v1.10 promotion 2026-05-01)

Master PRD **v1.10** · Artifact Registry **v2.10** · System Architecture v1.2 · CDM v1.2 · State Machines v1.1 · OpenAPI v0.2 · RBAC v1.1 · Contracts Pack **v5.2** · Engineering Handoff v1.3 · Operational Readiness v1.5 · Ghana Playbook v1.2 · ADR Set v1.0 + Addenda 016–019 + 020–025 + 026 + ADR-027 + ADR-028 + ADR-029 · DIC **v1.1** Canonical · Forms/Intake v2.1 · Pharmacy + Refill v2.1 · Admin Backend v1.1 · all other slice PRDs v1.0.

## Setup checklist

1. Install Node.js 20 LTS
2. Install PostgreSQL 15+
3. `npm install` (after Engineering Lead validates package.json contents)
4. `cp .env.example .env` and populate
5. `npm run dev` to start the Fastify app shell
6. Skills, hooks, and MCP servers configured per EHBG §13 (after first slice begins)

## Implementation status — read the live continuity sources, not this footer

This repo is **well past bootstrap.** Multiple slices are implemented under `src/modules/` and the migration chain runs `000 → 051+`. Because the build advances every firing, **this file does not track current progress** — the authoritative, always-fresh state lives in:

1. **The Addendum trail** — `../telecheckONE/Telecheck_v1_10_PRD_Update/AI_Service_Rollout_24h_Status_2026-05-14.md` (read the LAST addendum first). This is the canonical cross-session continuity mechanism: what shipped, commit SHAs, Codex outcome, next critical-path item.
2. **`git log --oneline` on `main`** — the merged-PR record.
3. **The open-PR queue** — `gh`/GitHub-MCP `list_pull_requests`. A standing `[CODEX-PENDING]` queue holds PRs authored but not yet Codex-reviewed/merged; **re-authoring queued work is duplication and is forbidden by the discipline floor.**
4. **`migrations/`** — the highest-numbered migration is the DB-layer high-water mark.

**Stale-tracking-ref trap (recurring, costly):** a fresh container's local `origin/main` ref can lag the true remote, making the repo look stranded at an old migration. When continuity is in doubt, trust `git ls-remote origin refs/heads/main`, **not** the local tracking ref — then `git fetch origin main` to correct it. This single trap has repeatedly made firings misread the project as far behind its actual state.

The first slice per EHBG §10 build sequence was **Forms/Intake Engine Slice PRD v2.1**; that and subsequent slices (Identity, Consent, Tenant-Config, Async-Consult, Pharmacy, Crisis-Response, Admin-Backend, Med-Interaction, AI-Service) now have implemented module surfaces. Consult the live sources above for per-slice completeness.
