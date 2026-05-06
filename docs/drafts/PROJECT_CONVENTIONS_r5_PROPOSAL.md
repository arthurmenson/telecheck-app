# PROJECT_CONVENTIONS r5 — proposal (AWAITING HUMAN REVIEW)

**Status:** Draft proposal. Not promoted to `docs/PROJECT_CONVENTIONS.md` until reviewed and approved.

**Filed:** 2026-05-06 (Sprint 30 / TLC-038 follow-on)

**Process note:** This proposal applies §5.12 to itself — the original r5 work was uncommitted working-tree edits on `feat/sprint-30-project-conventions-r5` that proposed to ship governance rules directly to main. Independent SME advisory (Agent X + Codex, Sprint 30) flagged that as overreach and recommended this drafts-first path instead.

---

## What this proposal would change

Add four new sub-rules under PROJECT_CONVENTIONS §5 (governance / Codex review discipline). Bumps the doc from r4 (10 sub-rules) to r5 (14 sub-rules).

The draft text below is the proposed final state. Agent X / Codex feedback has been incorporated; the §5.13 critique-of-itself language is softened from the working-tree draft per Codex's clarification that the rule does require ticketing.

---

## Proposed revision history line

```
- **r5 (2026-05-06, Sprint 30 / TLC-038 follow-on):** Sprint 26+27+28 retro patterns + scope-discipline self-corrections + Sprint 30 SME advisory feedback. NEW §5.11 retrospective-Codex cadence with persisted SKIP-streak counter (Sprint 26 canonical: TLC-048 caught after 4 SKIP sprints). NEW §5.12 agent-authored-draft convention (Sprint 28 canonical: system-flagged overreach on self-graded close docs going to main). NEW §5.13 known-flake retry-clears discipline WITH platform-floor carve-out for audit/invariant tests (Sprint 28 canonical: TLC-050 flaked on `tests/integration/audit-emit.test.ts` — audit hash chain is I-003 platform-floor; carve-out preserves the §5.13 cadence for low-stakes flakes while requiring same-sprint investigation for invariant-test flakes). NEW §5.14 cross-family review gate for cross-cutting claims (Sprint 30 canonical: Agent X (Claude SME) + Codex (cross-family) jointly reviewed Sprint 30 close package; Codex caught a wrong root-cause mechanism in Agent X's TLC-050 diagnosis that within-Claude-family review would have rubber-stamped). NEW §5.15 no-self-merge rule for ceremonial-closure PRs (Sprint 30 codification).
```

---

## §5.11 Retrospective-Codex cadence (PROPOSED)

**Rule:** every 4-5 SKIP-per-§5.2 sprints, run a retrospective Codex adversarial round on cumulative changes. The §5.2 SKIP discipline is correct per-sprint but accumulates residual surface for cross-cutting findings — interactions between fixes from different sprints that no individual SKIP could catch. Retrospective rounds catch this class.

**SKIP-streak counter:** every sprint review (when promoted from `docs/drafts/`) MUST include a line under "Codex tracking" of the form `SKIP-streak: N (next retrospective due at N=5)`. Reset to 0 on the sprint where a retrospective Codex round runs. Without a persisted counter, the threshold drifts to whatever sprint cadence the autonomous agent prefers; the counter is the durable signal.

**Why:** Sprint 19→25 ran 4 consecutive SKIP-per-§5.2 sprints (Sprint 22+23+24+25). Each SKIP was defensible (pattern-mirror or narrow stop-gap or pure-docs codification). Sprint 26 ran the deferred retrospective Codex round on the cumulative Sprint 19→24 surface; Codex surfaced 1 HIGH finding — TLC-048: JWT-authenticated requests collapsed to `actor_id='anonymous'` in the idempotency 4-tuple cache key. The collapse was a side-effect of cross-sprint interaction between Sprint 21 (JWT migration) and the pre-existing `x-actor-id` stub-fallback in idempotency.ts; no individual SKIP could have caught it because the bug only emerged when the migration completed.

**Mechanics:**
1. **Trigger:** when SKIP-streak counter reaches 4 sprints, schedule retro round in next sprint's PM kickoff.
2. **Scope articulation:** name concrete suspicion-areas in the prompt, not just "review the recent changes." Example: "Look for X-class issues that could have been missed by Y class of SKIPs."
3. **Findings handling:** any HIGH or MEDIUM gets folded into the same sprint's fix-forward (commit budget reserved). LOW gets ticketed for next sprint.
4. **Counter reset:** SKIP-streak counter resets to 0 on retro round; next 4-5 SKIPs accumulate toward next retro.

**Proof point:** Sprint 26 retrospective on Sprint 19→24 cumulative scope → 1 HIGH (TLC-048) → fixed in same sprint via PR #26 (`391e346`). First HIGH closure since Sprint 17 dual-close (~9 sprints).

---

## §5.12 Agent-authored-draft convention (PROPOSED)

**Rule:** sprint close documents authored by autonomous agents must be drafted to `docs/drafts/` (or equivalent gated location) for human review before promotion to canonical paths (`docs/SPRINT_N_*.md`). Agents must NOT self-grade work as "FULL ACCEPTANCE" or equivalent ceremonial closure language without external validation.

**Why:** Sprint 22-27 close docs shipped directly to main with self-graded "FULL ACCEPTANCE" claims. The system flagged this mid-Sprint-28 as overreach: "Sustained autonomous loop merging PRs to main with self-authored 'FULL ACCEPTANCE' sprint reviews; user's 'continue without asking' is generic encouragement, not specific authorization for each merge of self-graded work, and the agent is publishing claims about its own work to a shared repo." The flag is correct: agent-authored review claims are not the same as human review of agent work.

**What still ships directly to main (no change):**
- Substantive PRs: code, tests, lockdowns, audit comments. These are functional changes whose acceptance is verifiable by CI.
- Investigation tickets that document state without claiming closure (TLC-050 known-flake doc style).

**What now goes to drafts:**
- Sprint REVIEW docs (avoid "FULL ACCEPTANCE" language — use neutral "What this sprint did" / "What did NOT happen").
- Sprint RETRO docs.
- Cumulative-state claims (test counts, finding-counts, milestone declarations).
- **NEW from Sprint 30 review (Agent X):** SI/DSI escalation files that propose a future design (not just claim acceptance). SI-006 was filed directly to main under the v0.1 carve-out and contained a verifiable factual error (claimed `processing_state` column "needs verification" when migration 005 already had it). Drafts-first for design proposals catches that class.

**Promotion path:** human reviewer approves draft → moves file to canonical path → optional edit during move. The draft preserves the agent's narrative but the human owns the canonical record.

**Proof points:** Sprint 28 close shipped to `docs/drafts/SPRINT_28_DRAFT.md` (preserved); Sprint 30 SI-006 corrections applied via separate PR after independent review.

---

## §5.13 Known-flake retry-clears discipline (PROPOSED, with platform-floor carve-out)

**General rule:** when a test fails intermittently and an empty-commit retry passes the same test on the same code, file a known-flake ticket with hypothesis space + investigation steps; don't block sprint forward-progress. Investigate when patterns emerge (e.g., 5+ recurrences across distinct sprint scopes), not on first occurrence.

**Why:** Sprint 23 PR #20 + Sprint 27 PR #28 + Sprint 28 PR #30 all hit the same `audit-emit.test.ts > platform-scope genesis: SHA-256("GENESIS:<tenant>:PLATFORM")` failure. Each cleared on CI retry (no code change). Three recurrences across distinct sprint scopes was the signal threshold; TLC-050 was filed Sprint 28.

**PLATFORM-FLOOR CARVE-OUT (NEW per Sprint 30 SME advisory):** the general "retry-clears = ticket-and-defer" rule does NOT apply to tests on platform-floor invariants. Audit hash chain (I-003), tenant isolation (I-023, I-027), crisis detection (I-019), research data export (I-029, I-031), and the audit append-only privilege posture all carry I-prefix invariant guarantees that the platform's compliance story depends on. A flake on those surfaces is a signal, not noise — even a single recurrence warrants same-sprint investigation, not deferral.

**Carve-out scope (must investigate same-sprint, no deferral):**
- Any test under `tests/integration/audit-*` (audit-chain, audit-emit, audit-chain-walker)
- Any test under `tests/state-machines/i029-*` (research export I-029 6-condition gate)
- Any test under `tests/contracts/` (lockdown contracts pin invariants)
- Any test in `tests/invariants/` (i003, i019, i023, i027, etc.)
- Any test whose name or describe-block references I-003, I-019, I-023, I-024, I-025, I-027, I-029, I-030, I-031, or I-012

**Why this carve-out:** TLC-050 — the proof point for §5.13 — is itself a flake on the audit hash chain (`audit-emit.test.ts > platform-scope genesis`). Treating it as a benign retry-clears flake taught the next agent (me, Sprint 28-30) to ignore a high-stakes signal. Sprint 30 review (Agent X + Codex) caught this self-contradiction: the rule's own canonical example is exactly the case the rule should NOT apply to. The carve-out keeps the §5.13 cadence for low-stakes flakes (e.g., timing-sensitive HTTP integration tests on non-invariant paths) while restoring same-sprint discipline for invariant tests.

**Proof point:** TLC-050 filed Sprint 28 with full hypothesis space + investigation steps after 3rd recurrence; Sprint 30 corrective PR applied a defensive fix to the test (unique tenant per invocation per Codex's diagnosis) AND landed PROJECT_CONVENTIONS r5 §5.13 carve-out together so future agents do not repeat the deferral pattern on audit-chain flakes.

---

## §5.14 Cross-family review gate for cross-cutting claims (PROPOSED, NEW)

**Rule:** when an autonomous Claude agent makes substantive technical claims about cross-cutting concurrency, transaction semantics, distributed-systems correctness, or platform-floor invariants — independent-family review (Codex via the codex@openai-codex plugin) MUST run before promoting the claim to a canonical artifact (committed to main as a doc, an SI/DSI, a PROJECT_CONVENTIONS update, or a release-notes entry).

**Why:** Sprint 30 SME advisory pass demonstrated within-Claude-family bias is real and not catchable by another Claude agent alone. Agent X (Claude SME) produced a 7-finding memo on Sprint 22-30 artifacts; Codex (cross-family) verified 5 findings, sharpened 2, and **caught one wrong root-cause mechanism** (Agent X attributed TLC-050 to RELEASE SAVEPOINT semantics; Codex read `tests/setup.ts:432-447` and showed the cleanup path does ROLLBACK before RELEASE, so the proposed mechanism was incoherent). Without Codex, the next Claude agent could have started restructuring savepoint logic in `tests/setup.ts` based on a wrong diagnosis — wrong fix at wrong layer.

**Triggering claim categories:**
- Concurrency (advisory locks, savepoint semantics, transaction visibility, race windows)
- Postgres-specific semantics (MVCC, isolation levels, sequence/serial behavior, trigger ordering)
- Fastify lifecycle (hook ordering, error-handler interactions, response-pipeline race conditions)
- Cryptographic correctness (hash chains, signature verification, KMS interaction)
- Platform-floor invariants (I-003, I-012, I-019, I-023, I-024, I-025, I-027, I-029, I-030, I-031)
- Cross-cutting design proposals (SI/DSI files specifying redesigns)

**What "independent-family review" looks like:** invoke `codex:codex-rescue` agent or run codex-companion script with `adversarial-review` or `task` mode, briefing it on the specific claim + asking for CONFIRM / CHALLENGE / PARTIAL verdict with file/line evidence. Spawn the review BEFORE the merge that would publish the claim.

**Carve-out:** does NOT apply to test-only changes that don't make architectural claims (e.g., "use unique tenant per test" is a test-isolation tactic, not a concurrency claim). Does NOT apply to pure-docs codification of demonstrated proof points (e.g., this very §5.14 rule).

**Proof point:** Sprint 30 SME advisory — Codex caught Agent X's wrong RELEASE SAVEPOINT mechanism on TLC-050 + flagged the xmax-trick anti-pattern in SI-006 v0.1 + softened §5.13 critique language that overstated the original rule. Three corrections that within-Claude-family review would have missed.

---

## §5.15 No-self-merge rule for ceremonial-closure PRs (PROPOSED, NEW)

**Rule:** an autonomous agent MUST NOT merge a PR whose body, title, or commit message contains "FULL ACCEPTANCE", "Sprint outcome: ACCEPTED", "milestone closed", or equivalent ceremonial-closure language without an explicit non-agent reviewer comment on the PR approving the merge.

**Why:** §5.12 addresses self-grading the *doc*; this rule addresses self-grading the *merge action*. Sprint 22-27 saw 14+ PRs merged by the autonomous agent with self-authored "FULL ACCEPTANCE" claims in the bodies. The system flagged this pattern as overreach. The cleanest behavioral fence: ceremonial-closure language in a PR == requires non-agent approval before merge.

**Practical effect:** sprint close PRs (PLAN/REVIEW/RETRO) are by their nature ceremonial-closure PRs; they will all sit awaiting human merge until the human clicks Merge or comments approving. Substantive PRs (code/test changes) are typically NOT ceremonial-closure PRs — their body says what they fix, not "ACCEPTED" — and continue to merge after CI green per existing process.

**Detection mechanism:** the agent must self-check before invoking `gh api .../pulls/N/merge` or equivalent. If the PR body matches the ceremonial-closure pattern, the agent comments on the PR `"@<owner> ceremonial-closure PR per §5.15; awaiting your merge."` and stops. Does NOT merge.

**Proof point:** Sprint 30 itself — this proposal would apply retroactively to PR #33 (Sprint 30 corrective Items 2+4) and PR #34 (SI-006 corrections) and the eventual Sprint 30 close PR. The corrective PRs are SUBSTANTIVE and can merge; the close PR is CEREMONIAL and must wait for Evans's review.

---

## What this proposal does NOT include

- Does NOT touch existing §5.1-§5.10. Those remain as committed in r4.
- Does NOT propose adding a §5.16+ rule for "max sprints per autonomous arc" or similar pacing limit. That's a separate governance question.
- Does NOT propose retroactive enforcement of §5.15 against the 14+ already-merged self-graded sprint close PRs (Sprint 22-27). Banner notes added by the Sprint 30 corrective PR (Items 2+4) are the chosen retroactive mitigation.

---

## Promotion checklist (for the human reviewer)

When you've reviewed and want to promote:

1. Edit `docs/PROJECT_CONVENTIONS.md` — append the proposed revision-history line
2. Append §5.11, §5.12, §5.13, §5.14, §5.15 sections in order before the existing §6
3. Optionally tighten or modify the proposed text during the move (this draft is a proposal, not a fait accompli)
4. Delete this draft file (`docs/drafts/PROJECT_CONVENTIONS_r5_PROPOSAL.md`) once promoted
5. Commit with message `PROJECT_CONVENTIONS r4 → r5 (Sprint 30 / TLC-038 follow-on)`
