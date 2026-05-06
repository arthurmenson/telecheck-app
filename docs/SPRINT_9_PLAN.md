# Sprint 9 Plan — Telecheck-app autonomous build

**Sprint:** 9
**Sprint goal:** Async Consult slice authoring continuation — Sprint 2 of 3 (TLC-021). Migration + repos + state machine (7 of 23 transitions) + service layer + initial HTTP handlers + per-handler integration tests.
**Sprint start commit:** `4255dff` (Sprint 8 ACCEPTED — Async Consult skeleton landed)
**Commit budget:** 12 (9 estimated × 1.3× novel-of-class slack per Sprint 8 retro heuristic; +1 kickoff + 1 review/retro = 14 ceiling but treat 12 as the soft target)
**Codex strategy:** **FIRE on every sub-story** (a-f) — state machine + repo + service + handler are all novel-class authoring; precedent (Sprint 5/6/7) shows Codex finds real bugs in novel surfaces

---

## PM-brief verification gate findings (Sprint 9 — 4th consecutive ALL PASS)

| Identifier | Cited at (PM brief §) | Verified at (source-of-truth) | Match |
| --- | --- | --- | --- |
| P-011/012/013 absent | §1 | `grep "^### Entry P-01[123]" Promotion_Ledger.md` returned 0 | ✓ |
| State Machines §3 transition table | §4 | `Telecheck_State_Machines_v1_1.md:194` (header) / L196-218 (data rows) | ✓ |
| 23 transition rows | §4 | confirmed via line-by-line read | ✓ |
| ESCALATED_TO_SYNC last row | §4 row 23 | `Telecheck_State_Machines_v1_1.md:218` | ✓ |
| `requireActorContext` | §5 | `src/lib/auth-context.ts:151` | ✓ |
| `ActorContext` interface | §5 | `src/lib/auth-context.ts:46` | ✓ |
| `getActiveDeployment` | §5 | `src/modules/forms-intake/index.ts:59` | ✓ |
| `hasActiveConsent` | §5 | `src/modules/consent/index.ts:50` (PM said :51 — inside {} block at L47-50; functional match) | ✓ |
| `CONSULT_STATES` enum | §10 | `src/modules/async-consult/internal/types.ts:63-81` | ✓ |
| CDM Consult #15 / ConsultEvent #16 | §10 | `Telecheck_Canonical_Data_Model_v1_2.md:84-85` (Sprint 8 verified) | ✓ |
| migrations/020* | §7 | does NOT exist (Glob 0) | ✓ |
| Sprint 9 directories | §7 | do NOT exist (Glob 0) | ✓ |

**Gate result: ALL PASS.** 4th consecutive clean PM brief since the gate was instituted at `804c294` (Evans 2026-05-05 oversight directive).

---

## Sprint 9 sub-story sequence (per PM brief §2)

| Sub-story | Title | Est. commits | Codex |
| --- | --- | --- | --- |
| **TLC-021a** | Migration `migrations/020_async_consult.sql` (forward + rollback) + SI-004 doc (audit-event placeholder) + SI-005 doc (schema placeholder) | 1 | FIRE |
| **TLC-021b** | Repos: `consult-repo.ts` + `consult-event-repo.ts` (tenant-scoped via `withTenantBoundConnection`) + repo tests | 2 | FIRE |
| **TLC-021c** | State machine: `internal/state-machine.ts` (7 of 23 transitions implemented at v0.1; remaining 16 deferred to Sprint 10 with explicit `unsupported_transition` errors) + transition tests | 2 | FIRE |
| **TLC-021d** | Service layer: `internal/services/consult-service.ts` (initiate / submit / abandon / read) + service tests | 2 | FIRE |
| **TLC-021e** | HTTP handlers: POST /v0/async-consult; POST /v0/async-consult/:id/submit; POST /v0/async-consult/:id/abandon; GET /v0/async-consult/:id | 1 | FIRE |
| **TLC-021f** | Per-handler integration tests (4 happy paths + 2 cross-tenant denial + 2 error paths) | 1 | FIRE |

**Total estimated:** 9 commits + 1 kickoff (this doc) + 1 review/retro = 11. Budget 12 (1.3× slack).

---

## SI documents to file at TLC-021a

### SI-004 — Async Consult audit events ratification (NEW — out-of-repo work)

PRD §13 enumerates 11 events at `Telecheck_Async_Consult_Slice_PRD_v1_0.md:445-455`. Canonical AUDIT_EVENTS contract has 0 of these. Per Sprint 8 retro option (c), Sprint 9 ships placeholder events matching PRD §13 verbatim; SI-004 closure ratifies them upstream. Sprint 9 only emits 4 of 11 (the 4 transitions implemented at v0.1):
- `consult.initiated` (transition 1: INITIATED → INTAKE on `start_intake`)
- `consult.intake_submitted` (transition 2: INTAKE → SUBMITTED on `submit`)
- `consult.abandoned` (transition 3: INTAKE → ABANDONED on `abandon`)
- `consult.expired` (transition 5: ABANDONED → EXPIRED on `expire`)

Remaining 7 events deferred to Sprint 10 per `consult.ai_preparation_completed`, `consult.case_claimed`, `consult.clinician_decision`, `consult.prescription_created`, `consult.additional_data_requested`, `consult.escalation_to_sync`, `consult.patient_notification_sent`, `consult.follow_up_message`, `consult.completed` (more than 7 in PRD; Sprint 10 implements the rest).

### SI-005 — Consult / ConsultEvent schema gap (NEW — out-of-repo work)

CDM v1.2 §3 entity inventory (`Telecheck_Canonical_Data_Model_v1_2.md:84-85`) names Consult #15 + ConsultEvent #16. CDM §4 row-shape expansion does NOT exist (verified via grep). Sprint 9 migration ships placeholder columns (id, tenant_id, patient_id, consult_type, modality, state, current_program_catalog_entry_id, intake_form_submission_id, created_at, updated_at + hash_chain fields for audit). Each placeholder column carries a SQL comment pointing to SI-005 as the resume gate.

Parallel posture to SI-004: authoring should not block on out-of-repo spec work; SI-005 closure validates the placeholder schema against the spec-side ratification.

---

## Sprint 9 transition coverage (7 of 23 — see PM brief §4)

Implemented in TLC-021c:
1. `INITIATED → start_intake → INTAKE` (payment confirmed)
2. `INTAKE → submit → SUBMITTED` (form complete + consents resolved)
3. `INTAKE → abandon → ABANDONED` (48h no activity)
4. `ABANDONED → resume → INTAKE`
5. `ABANDONED → expire → EXPIRED` (14d no activity)
6. `SUBMITTED → process → PROCESSING` (— guard)
16. `AWAITING_DATA → patient_responds → UNDER_REVIEW`

**Sprint 9 omits:** transitions 7-15 (clinician decision branches; require AI Mode 2 wiring + clinician auth surface), 17-23 (terminal states + sync_booked). Sprint 10 implements these.

State machine MUST throw `unsupported_transition` errors for the 16 deferred transitions — silent acceptance of unimplemented transitions would defeat the type safety. Test coverage in TLC-021c verifies each deferred transition throws.

---

## Cross-slice integration (Sprint 9 wires)

- **Identity** (auth-context.ts) — `requireActorContext(req): ActorContext` — service-layer auth at every handler entry point.
- **Forms-Intake** (`getActiveDeployment(tenantId, programCatalogEntryId)`) — wired at INITIATED → INTAKE transition to populate `current_program_catalog_entry_id` foreign key.
- **Consent** (`hasActiveConsent`) — wired at INTAKE → SUBMITTED transition guard.

---

## Definition of Done — Sprint 9

- [ ] PM-brief verification gate ran + findings recorded (this doc §"PM-brief verification gate findings")
- [ ] TLC-021a: Migration `020_async_consult.sql` (forward + rollback) authored
- [ ] TLC-021a: SI-004 + SI-005 docs filed
- [ ] TLC-021b: Repos `consult-repo.ts` + `consult-event-repo.ts` + tests
- [ ] TLC-021c: State machine `internal/state-machine.ts` (7 transitions implemented; 16 explicit unsupported_transition throws) + tests
- [ ] TLC-021d: Service layer `consult-service.ts` (4 operations) + tests
- [ ] TLC-021e: 4 HTTP handlers wired
- [ ] TLC-021f: Per-handler integration tests (4 happy + 2 cross-tenant + 2 error)
- [ ] Codex FIRE on every sub-story; HIGH/CRITICAL closed in-sprint
- [ ] Lint + type-check clean
- [ ] No invariants relaxed (I-023 cross-tenant isolation; I-025 tenant-blind 404; I-027 tenant_id on every audit row)
- [ ] No placeholder schemas authored beyond SI-005 minimal-viable column set
- [ ] `docs/SPRINT_9_REVIEW.md` filed
- [ ] `docs/SPRINT_9_RETRO.md` filed
- [ ] PM kickoff brief for Sprint 10 (verification gate runs again; Sprint 10 = full integration + remaining transitions + remaining audit events + cross-slice wiring)

---

## Risks (PM-flagged + SM additions; Sprint 9 = highest-risk authoring sprint since Sprint 1)

- **PM Risk 1: State machine guard logic divergence.** PRD §12 has DECISION_MADE; State Machines §3 omits it. Sprint 9 implements 7 transitions; explicit `unsupported_transition` errors for the deferred 16. SM verification: confirm Sprint 9's state machine accepts only the 7 implemented and explicitly throws on the deferred 16 (test coverage in TLC-021c).
- **PM Risk 2: SI-005 schema gap blast radius.** Migration 020 ships placeholder columns; if SI-005 closure later adds CDM §4 expansion with conflicting types, migration 020 may need a forward-only ALTER (paired rollback). Mitigation: keep placeholder columns minimal-viable + each carries SQL comment "v0.1 placeholder pending SI-005".
- **PM Risk 3: Cross-slice consent + intake-form gates at INTAKE → SUBMITTED.** Service layer must verify both `hasActiveConsent` + `findActiveDeployment` populated before transition. Failure mode: silently allow transition if either dep returns null. Mitigation: explicit guard tests in TLC-021c + TLC-021d.
- **SM addition (Sprint 8 retro process change #2 binding):** SI-004 + SI-005 docs MUST file at TLC-021a; if SM forgets, Sprint 9 ships placeholder events + schema with no resume-gate documentation, defeating the Sprint 8 retro decision.
- **SM addition (Sprint 7 retro process change #1 binding):** closure-language audit before each commit. NOTHING in Sprint 9 "closes" the Async Consult slice — every commit message says "Sprint 2 of 3" or "TLC-021<x>" with explicit Sprint 10 deferral references.

---

## Codex strategy detail

Each sub-story (a-f) fires Codex with narrow scope at commit time. Pattern:

```
node "C:/Users/menso/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs" adversarial-review "--background --base 4255dff <sub-story-touched-paths>"
```

Hard 15-min cap per Codex run. HIGH/CRITICAL findings = fix-forward in-sprint; MEDIUM on contract-lockdown surfaces = fix-forward (Sprint 6 retro sub-rule); LOW = log + ignore.

If a sub-story's Codex returns multiple HIGH findings, pause Sprint 9, fix-forward, surface to Evans if scope inflation > 50% (per Sprint 11 hardening reservation).
