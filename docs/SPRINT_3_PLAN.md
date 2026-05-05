# Sprint 3 Plan — Telecheck-app autonomous build

**Sprint:** 3
**Sprint goal:** Pre-pave Med Interaction Engine module + tenant-config admin-write 503 surface while SI-001/002/003 remain open upstream.
**Sprint start commit:** `fbb75aa` (Sprint 2 ACCEPTED)
**Commit budget:** 7 (4 story commits × 1.2 slack ≈ 5; +1 kickoff, +1 review/retro)
**Codex strategy:** SKIP per pre-empt rationale (both stories are pattern-mirrors of existing skeletons; novelty near-zero; in-sprint tests cover Codex's likely findings)

---

## Promotion Ledger check (verified by PM at kickoff)

SI-001 / SI-002 / SI-003 remain **open** upstream. Latest entries: P-008 (v1.10 promotion 2026-05-01), P-009 (v1.10.1 hygiene 2026-05-02), P-010 (CDM §4.1 reconciliation 2026-05-02). No P-011/P-012/P-013. Slice 4 schema work stays blocked.

---

## Stories committed

### TLC-007 — Med Interaction signals contract scaffolding

**Estimated commits:** 2
**Decision rule:** 4 (new unblocked slice prep)
**Current state baseline (verified by PM):** `src/modules/med-interaction/` does NOT exist.

#### Acceptance criteria

- New module directory `src/modules/med-interaction/` with: `index.ts`, `plugin.ts`, `routes.ts`, `internal/types.ts`, `README.md`
- Branded ID types (mirror pharmacy pattern): `InteractionSignalId`, `InteractionOverrideId`, `InteractionRulesetId`
- Plugin registers under `/v0/med-interaction` with:
  - `GET /health` → 200 with `{status: 'ok', module: 'med-interaction', blocked: 'Med Interaction Engine slice ratification'}`
  - `GET /ready` → 503 (matches pharmacy pattern; module not ready to serve traffic)
- `README.md` BLOCKED banner explaining slice ratification dependency + scope-on-resume notes
- Plugin registered in `src/app.ts`
- ZERO migration files; ZERO repo files; ZERO service files
- All TypeScript-clean
- Plugin smoke test: `tests/integration/med-interaction-plugin-wiring.test.ts` (2 cases — `/health` 200 + `/ready` 503)

#### Out of scope (deferred)

- Signal entity schemas (await Med Interaction Engine slice PRD)
- Override workflow (depends on signal types)
- Vendor adapter abstraction (Sprint 4+)

---

### TLC-009 — Tenant-config admin-write 503 surface skeleton

**Estimated commits:** 2
**Decision rule:** 4 (new slice prep) / partially-blocked
**Current state baseline (verified by PM):** `src/modules/tenant-config/internal/handlers/admin.ts` is read-only (4 GET handlers, zero mutation). Pharmacy `/ready` 503 pattern is the right mirror.

#### Acceptance criteria

- New file `src/modules/tenant-config/internal/handlers/admin-write.ts` with 503 stub handlers:
  - `PATCH /v0/admin/tenant-brand` → 503
  - `PATCH /v0/admin/ccr-configs/:configKey` → 503
  - `POST /v0/admin/adapter-configs` → 503
  - `PATCH /v0/admin/adapter-configs/:adapterId` → 503
  - `DELETE /v0/admin/adapter-configs/:adapterId` → 503
- Each 503 response uses canonical tenant-blind error envelope (I-025) with `code: 'internal.module.blocked'`, `message: 'Admin Backend slice v1.1 not yet implemented; mutation surface awaits ADR-024 encryption-at-rest wiring.'`, `request_id` populated
- Routes added to `routes.ts` `registerTenantConfigAdminRoutes` plugin
- `GET /v0/admin/ready` returns 503 (matches pharmacy pattern; mutation surface not ready)
- ZERO request-body parsing; ZERO Zod schemas for mutation payloads (schema authoring belongs with Admin Backend slice v1.1)
- ZERO migration files; ZERO new repos
- HTTP integration test: `tests/integration/tenant-config-admin-write-blocked.test.ts` (5 cases — one per 503 stub) asserting:
  - Status code 503
  - Body matches tenant-blind error envelope shape
  - `code` field equals `internal.module.blocked`
  - JWT-auth still required (401 without Bearer; covered by 1 case)

#### Out of scope (deferred)

- Actual mutation handler logic (Admin Backend slice v1.1)
- Per-tenant KMS encryption integration (ADR-024 v1.1)
- Operator-edit audit emitters (Admin Backend slice owns)

---

## Definition of Done — Sprint 3

- [ ] TLC-007 plugin-wiring test passes (2 cases)
- [ ] TLC-009 admin-write 503 envelope test passes (5 cases)
- [ ] CI green at sprint end
- [ ] No invariants relaxed (I-023, I-024, I-025, I-027)
- [ ] No production-code changes outside scope
- [ ] `docs/SPRINT_3_REVIEW.md` filed
- [ ] `docs/SPRINT_3_RETRO.md` filed
- [ ] PM kickoff brief for Sprint 4 (next)
- [-] Codex SKIPPED per pre-empt rationale (rationale enumerated in review doc)

---

## Risks (PM-flagged)

- **Spec-backing risk on TLC-007:** Med Interaction Engine has no slice PRD yet. Branded-ID types marked PROVISIONAL pending slice ratification (mirror pharmacy README BLOCKED banner). If a future slice PRD disagrees with chosen names, that's Sprint 4+ backlog, not a Sprint 3 blocker.
- **TLC-009 over-scoping risk:** temptation is to define request-body schemas for the future PATCH/POST handlers. Don't. 503 stubs only. Schema authoring belongs with Admin Backend slice v1.1.

---

## Codex skip rationale (Sprint 2 retro pattern)

Both stories are pattern-mirrors of existing skeletons:
- TLC-007 mirrors `src/modules/pharmacy/` skeleton (already reviewed by Codex in Sprint 1; ran clean except for the liveness/readiness MEDIUM finding which is being applied a-priori in TLC-007)
- TLC-009 mirrors the existing `tenant-config/internal/handlers/admin.ts` read surface + the pharmacy `/ready` pattern

Test assertions covering Codex's likely findings:
- TLC-007 plugin-wiring smoke test covers plugin registration + `/health` + `/ready` envelope shapes
- TLC-009 503-envelope test asserts every mutation route returns the canonical tenant-blind error envelope (I-025 compliance)

If a higher-novelty divergence emerges mid-sprint, fire Codex with `--background --base main src/modules/med-interaction/ src/modules/tenant-config/internal/handlers/admin-write.ts` + hard 15-min cap.
