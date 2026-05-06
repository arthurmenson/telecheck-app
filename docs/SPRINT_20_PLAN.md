# Sprint 20 Plan — Telecheck-app autonomous build

**Sprint:** 20
**Sprint goal:** TLC-039 close §E canonicalize-db-url scheme-prefix bug (my own bug from PR #11) + triage 8 remaining pre-existing ci.yml test failures into named Sprint 21+ candidates.
**Sprint start commit:** `ed6e591` (Sprint 19 close; PR #14 merged).
**Branch posture:** feature-branch + PR.
**Commit budget:** 4 (1 fix + 1 triage doc + 1 review/retro + 1 reserve).
**Codex strategy:** SKIP per §5.2 — TLC-039 §E fix is a 5-line scheme-prefix regex addition; trivial.

---

## PM-brief verification gate findings (Sprint 20 — 15th consecutive ALL PASS)

5 cited identifiers verified pre-execution:
- P-008/P-009/P-010 latest 3 ledger entries — verified
- OR-218 — verified at `Telecheck_Operational_Readiness_Todo_v1_5.md:129` (FULLY CLOSED)
- `tests/perf/db/canonicalize-db-url.ts` (the function with §E bug) — verified
- `tests/contracts/canonicalize-db-url.test.ts §E "not-a-url string → null"` — verified at line 156-158
- Sprint 19 retro Sprint 20 candidate scope (TLC-039 priority 1) — verified

15 consecutive PM-brief gate ALL PASS.

---

## Sub-stories committed

### TLC-039 — close §E canonicalize-db-url scheme-prefix bug + triage 8 remaining ci.yml failures

**Estimated commits:** 2 (fix + this plan/review/retro doc commit).
**Codex strategy:** SKIP per §5.2 (5-line regex fix; pure validation).

#### Acceptance criteria

- `tests/perf/db/canonicalize-db-url.ts:canonicalizeDbUrl()` returns `null` when input doesn't start with `postgresql://` or `postgres://` (case-insensitive)
- `tests/contracts/canonicalize-db-url.test.ts §E "not-a-url string → null"` passes
- `npm run lint` + `npx tsc --noEmit` + format-check all clean
- 8 remaining pre-existing ci.yml test failures triaged into named Sprint 21+ candidates with categorization

#### 8 remaining pre-existing ci.yml test failures triaged

| Failing test | Symptom | Root cause hypothesis | Sprint 21+ candidate |
|---|---|---|---|
| `async-consult-cross-tenant-isolation.test.ts §3a` | `expected 401 to be 404` | Auth middleware fires before I-025 cross-patient 404 handler | TLC-040 |
| `async-consult-cross-tenant-isolation.test.ts §3b` | `expected 400 to be 404` | Validation fires before I-025 write-path 404 handler | TLC-040 |
| `tenant-config-admin-write-blocked.test.ts §1-7` | `expected 400 to be 503` (× 7 cases) | Payload validation fires before Admin Backend slice v1.1 blocked-503 stub | TLC-041 |
| `forms-intake-*` (2 files) | `emitAudit deadlock detected on identity_account_created` | Audit-emit + identity-account-created concurrent transaction lock contention; possibly fixed by Sprint 19 TLC-034 schema_migrations changes; re-validate post-merge | TLC-042 |
| `identity-*-http.test.ts` (× 2) | Same deadlock as forms-intake | Same root cause | TLC-042 |
| `delegations-migration.test.ts` | Migration-related; investigate post-Sprint-19-merge | Possibly resolved by TLC-034; re-validate | TLC-043 |

Each candidate gets a dedicated PR + sprint when authored. They're slice-specific implementation precedence issues that need the slice owner's context to fix correctly.

---

## Definition of Done — Sprint 20

- [ ] PM-brief verification gate ran (15/15 ALL PASS)
- [ ] §E scheme-prefix fix landed
- [ ] 8 remaining failures triaged into Sprint 21+ candidates
- [ ] PR opened + required CI PASS
- [ ] `docs/SPRINT_20_REVIEW.md` filed
- [ ] `docs/SPRINT_20_RETRO.md` filed

---

## Sprint 21 hand-off

When Sprint 20 closes:
1. **TLC-040** (priority 1): async-consult-cross-tenant-isolation §3 — handler precedence fix (auth-fires-before-404)
2. **TLC-041** (priority 2): tenant-config-admin-write-blocked §1-7 — payload-validation-vs-503-precedence fix (likely 1 commit; route-handler ordering)
3. **TLC-042** (priority 3): forms-intake + identity emitAudit deadlock — investigate after Sprint 20 PR merge to see if TLC-034 already resolved it
4. **TLC-043** (priority 4): delegations-migration — likely resolved by TLC-034
5. **TLC-038** (Sprint 19 NEW): PROJECT_CONVENTIONS r3 → r4 codification of concurrent-shared-resource pattern
6. **TLC-036/037** (Sprint 19 r16 triaged): low priority; out-of-scope
7. **TLC-032** (deferred): DB-backed bench expansion needs Postgres validation
8. **SI-001/002/003 status check**
