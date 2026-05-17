# SI-014 — Crisis-detection clinical-grade NLP classifier upgrade

**Raised by:** Engineering (autonomous run 2026-05-16; PR #165 cycle Addendum 27 next-entry-point identification)
**Date:** 2026-05-16
**Severity:** HIGH at pilot launch — the current `src/lib/crisis-detection.ts` implementation is a regex-keyword stub explicitly flagged in its own docstring as "REQUIRED before patient-facing deployment." I-019 is platform-floor (always-on crisis detection across AI chat, voice, community, messaging). The stub provides high-recall English-only keyword coverage; it cannot meet the I-019 invariant for Telecheck-Ghana chronic-care pilot (TWI bypass + paraphrasing bypass on EN) and is not adequate as the production safety surface for any tenant.
**Status:** Open — awaiting spec-corpus ratifier (Evans + Engineering Lead + Platform Clinical Governance + Platform AI Safety) to decide between the four ratifier-decision options below before any code can land
**Target spec docs:** `Telecheck_Master_Platform_PRD_v1_10.md` §16 (AI safety surface), `Telecheck_AI_Clinical_Assistant_Slice_PRD_v1_0.md` §6 (crisis-detection surface), `Telecheck_Contracts_Pack_v5_00_AI_LAYERING.md` §6 (FLOOR-020 + crisis-detection floor), `Telecheck_Contracts_Pack_v5_00_INVARIANTS.md` §I-019 (crisis detection always-on), `Telecheck_Contracts_Pack_v5_00_WORKLOAD_TAXONOMY.md` §2.1 (`conversational_assistant` floor_safety class), `Telecheck_ADR_Set_v1_0.md` (new ADR-030 needed per option chosen — see Resolution path)
**Target slice:** Mode 1 conversational assistant (caller in `src/modules/ai-service/internal/handlers/chat.ts`); voice transcript pipeline when activated; community moderation when activated; forms-intake when free-text crisis surfaces ratify
**Parallel SIs:** does not block / not blocked by other open SIs; touches the same `runCrisisGate` callsite SI-013 ratifies CCR helplines for, so SI-013 + SI-014 should land in the same ratification ceremony if possible (single re-test cycle for the crisis-bypass branch)

---

## What this is

`src/lib/crisis-detection.ts` is the I-019 platform-floor crisis-detection guard. Today's implementation:

- **Regex keyword matchers** across 6 pattern classes (`suicid\w*`, `self[\s-]?harm\w*`, `chest\s+pain`, etc.) tuned for high-recall in English
- **EN-only** — TWI / pidgin / informal Ghanaian English bypass the patterns entirely
- **No paraphrase coverage** — "I want it all to be over" / "I don't see a way forward" / "tonight feels like the last night" pass through with `crisisDetected: false`
- **No context awareness** — "I'm reading a book about suicide prevention" matches the same as "I'm planning to commit suicide"; both fire (false positive direction is the SAFE direction per I-019's "high-recall priority", but the lack of any negation / quotation / clinical-context handling means alert fatigue is structurally guaranteed)
- **Stub `recommendedSurfaces`** — returns the same three surface IDs for every detection; the SI-013 CCR-resolved helpline pathway will replace this for chat, but voice / community / forms have not been ratified

The docstring explicitly documents this is a stub:

> **PRODUCTION FOLLOW-UP REQUIRED:**
>
> - Replace stub patterns with a clinical-grade NLP classifier trained on crisis language (per clinical safety officer review).
> - Add multi-language support (EN + TWI for Ghana market at minimum).
> - Add voice transcript pipeline integration (when voice surface activates).
> - Integrate with tenant-specific crisis escalation pathways (from CCR `country_of_care` → emergency contact chain).

This SI scopes the classifier upgrade as a formal deliverable so the spec-corpus ratifier can batch the classifier-choice decision with the other 9 pending SIs.

## Why this matters for pilot launch

Telecheck-Ghana chronic-care is the first revenue-bearing pilot (Heros Health Ghana DBA at ghana.heroshealth.com). Per the implementation-state audit (2026-05-15) + the Master Completion Plan v1.0 Phase B "Clinical Care" track:

1. **Chronic care patients DO surface crisis content** in conversational interfaces (depression comorbidity with chronic disease is well documented; the Mode 1 chat handler routes everything through `runCrisisGate`)
2. **The Ghana pilot tenant is configured with `country_of_care: 'GH'` + `primary_language` set to either 'en' or a Twi variant** depending on patient profile. EN-only regex matching means a patient who code-switches into Twi for the most emotionally-loaded crisis content (a documented pattern in bilingual mental-health research) will be silently missed
3. **I-019 platform-floor compliance** — "crisis detection (suicidal ideation, self-harm, abuse disclosure, medical emergency indicators) is always active across all platform surfaces — AI chat, community, forms, messaging. No guardrail template, moderation policy, or admin configuration can disable crisis detection." The current stub satisfies the "always-on" part of the invariant (the `arguments.length > 0` guard fail-closes), but a stub that misses Twi crisis content is not actually performing the invariant's underlying safety function
4. **AUDIT_EVENTS Category A `crisis_detection_trigger`** — every detection emits a durable safety-floor audit row. A miss is silently absent from the audit chain; there is no "negative-detection" audit (rightly so — every text message would emit one). A clinician reviewing patient chat history retrospectively cannot tell from the audit chain that a missed-crisis happened; the gap is only visible by reading transcripts. This makes regression detection on the classifier itself a clinical-ops surface, not a code-CI surface — which is part of why the classifier choice IS a clinical-safety judgment

Codex on PR #160 (Mode 1 chat handler R6) flagged the crisis-gate-bypass invariant explicitly: oversized text must STILL pass through crisis detection before Zod size constraints reject. The handler implements this correctly. But the detection itself is only as strong as its classifier — a 200KB crisis message in informal Twi is detected by the bypass plumbing, then handed to a regex that does not understand it.

## Ratifier-decision options (FOR REVIEW — not authoritative)

This SI deliberately does NOT recommend an option. The classifier choice is a CRITICAL clinical-safety + regulatory + cost judgment that the spec-corpus ratifier must make. The four options below are presented with explicit tradeoffs along the dimensions that matter: clinical efficacy, regulatory posture, latency budget, multi-tenant cost amortization, multi-language coverage, and PHI handling.

### Option A — Anthropic Claude as the classifier

**Mechanism.** Call Claude (via the same multi-provider abstraction the Mode 1 chat handler uses per ADR-020) with a tightly-scoped system prompt: "Classify the following patient-authored text for crisis indicators. Return JSON: { crisis: bool, type: enum, confidence: 0-1, reasoning: string }." The detection runs IN-LINE in the request path BEFORE the chat-response prompt.

**Pros.** Multi-language out of the box (Twi + EN + pidgin handled natively without separate training data). Paraphrase / negation / quotation context handled. Zero training-data engineering — the model already understands crisis language across registers. Same infrastructure path as Mode 1 → operational simplicity. Continuous improvement as Anthropic improves the model.

**Cons.** Per-detection cost (every patient utterance in chat, voice, community, forms is a Claude call — at scale this is a real OPEX line). Per-detection latency (P50 ~400ms for a small classification call, but the chat handler's safety budget is sub-500ms for the full crisis-gate before the response prompt fires — eats most of it). PHI handling: every classification sends raw patient text to Anthropic's API; even with the Anthropic data-retention BAA (signed per ADR-024), this is a wider PHI surface than an on-prem classifier. Failure mode: provider unavailable means crisis detection unavailable — must combine with the regex stub as a fallback (the AI-RESIL-001 pattern from PR #160) to preserve I-019 always-on.

**Regulatory posture.** HIPAA covered under existing Anthropic BAA. FDA: requires Quality System documentation + classification record-keeping per 21 CFR 820 (the classification is a clinical-decision-supporting output; classification accuracy must be measured and tracked). GDPR for any EU patient: explicit consent + DPA + processor-controller mapping — out of scope for v1.0 launch since neither pilot tenant has EU patients.

**Cost order-of-magnitude.** At 1k patients × 5 chat utterances/day × 90 days = 450k calls/quarter at Anthropic Haiku rates is ~$45-$90/quarter — negligible. At 100k patients × 20 utterances/day × 365 days = 730M calls/year is ~$73k-$146k/year + Claude model upgrade pricing variance — material but bounded.

### Option B — On-prem fine-tuned classifier (e.g., DistilBERT + crisis-trained dataset)

**Mechanism.** Train (or fine-tune from a pretrained model) a small classifier on a curated crisis-language dataset. Deploy on-prem (AWS us-east-1 per ADR-026); each detection is a sub-50ms forward pass on commodity GPU.

**Pros.** Zero per-detection variable cost — fixed GPU lease. Sub-50ms latency leaves the full chat-handler safety budget for the response prompt. PHI never leaves the AWS VPC — tighter HIPAA posture than any external-API option. Failure mode is local: a model service restart is a known operational pattern.

**Cons.** Training-data engineering required (clinical-grade crisis dataset; curated + labeled; multi-language requires per-language training). Model drift management is on the platform team — must measure detection accuracy continuously and retrain when drift exceeds threshold. Multi-language: a single DistilBERT trained on EN + Twi crisis data is feasible but the labeled Twi corpus does not exist publicly — must be created (clinical + linguistic + legal partner). This is a 6-12 month workstream before launch-ready.

**Regulatory posture.** HIPAA: simplest of all options (PHI stays in VPC). FDA: same Quality System documentation requirements as Option A, but the platform owns the model — easier to audit but heavier to maintain. GDPR: simplest (data residency controlled).

**Cost order-of-magnitude.** Training: $50k-$200k one-time per language (annotation + model dev + clinical validation). Inference: ~$2-$8k/month fixed AWS GPU lease for the projected v1.0 traffic. Ongoing: clinical + linguistic + ML engineer time to monitor accuracy and retrain on drift (~0.5-1 FTE).

### Option C — Hybrid (regex stub as floor + Claude as primary)

**Mechanism.** Detection runs BOTH the existing regex floor (sub-1ms; high-recall on the known EN crisis vocabulary) AND a Claude call IN PARALLEL. Outcome: crisis IF either fires. Audit records WHICH classifier fired (for forensic-correlation + classifier-accuracy tracking) on the Category A `crisis_detection_trigger` row.

**Pros.** Provider-unavailable degradation is graceful — if Claude is down, the regex floor still detects EN crisis content; only the Twi + paraphrase coverage is lost. Side-by-side classifier-accuracy measurement is built in (every Claude detection that the regex did NOT detect is a measurable "Twi or paraphrase save" that justifies the OPEX). Same operational simplicity as Option A.

**Cons.** Doubles the cost of Option A (still pays per-call) AND keeps the regex maintenance burden. Latency overhead of Option A unchanged (regex runs in parallel, doesn't reduce wall-clock). Audit-row complexity (must record both classifier outcomes, not just one).

**Regulatory posture.** Same as Option A.

**Cost.** Same as Option A + maintenance of the regex floor.

### Option D — Defer pilot launch on the Mode 1 chat surface until the classifier ratifies

**Mechanism.** Mark Mode 1 chat as "internal alpha only" (clinician-test tenant only; no patient access) until one of Options A/B/C ratifies. The Telecheck-Ghana pilot proceeds with chronic-care management surfaces (forms, async-consult, prescription/refill) but Mode 1 chat is gated off for patients.

**Pros.** Zero clinical-safety risk from stub-coverage gaps. Clean separation: ratifier can take 60-90 days to evaluate options A/B/C without blocking the chronic-care pilot which doesn't depend on Mode 1 chat. Bypasses the FDA Quality System overhead at v1.0 entirely (no clinical-decision-supporting AI in patient-facing surface).

**Cons.** Mode 1 chat is the marquee feature of the platform — patient acquisition + engagement projections in Master PRD v1.10 §17 assume conversational assistant access. Delaying it pushes engagement KPIs and partnership-grant deliverables (the WHO/UN partnership in ADR-028 has a Mode 1 demo gate in some scopings). The 60-90 day delay is the _minimum_ — Option B requires 6-12 months which would push pilot launch past calendar 2026.

**Cost.** No technical cost; significant opportunity cost.

## Hard rules constraining any chosen implementation

Regardless of which option ratifies, these rules MUST hold per I-019 + I-027 + audit-event policy:

**Rule 1 — Always-on. The classifier upgrade MUST NOT introduce a config flag or feature toggle that can disable detection.** The existing `CrisisDetector` constructor's `arguments.length > 0` fail-closed gate must be preserved (Codex crisis-detection-r1 closure 2026-05-03). Any classifier implementation passed via injection MUST be a non-nullable parameter — the platform-singleton at the bottom of the file remains the single sanctioned construction site.

**Rule 2 — Failure mode is fail-CLOSED on the safety surface, SCOPED BY COVERAGE CLASS (Codex R1 H1 closure 2026-05-16).** If the chosen classifier (Claude API call, on-prem model service, hybrid combiner) throws or times out, the platform MUST NOT silently return `crisisDetected: false` for any input the regex floor cannot meaningfully classify.

The naïve "fall through to regex on classifier failure; return no-crisis if regex doesn't match" posture is a SAFETY REGRESSION: for inputs in Twi, paraphrased EN, or any other coverage class the regex floor is documented to miss (see "What this is" above), a classifier outage would convert real crisis content into `crisisDetected: false` — the exact failure mode Rule 6 was added to prevent. The fail-closed posture MUST therefore be SCOPED to coverage classes the regex floor is known to handle:

- **(a) Bounded fall-through to regex.** Acceptable IF AND ONLY IF the input's detected language (and, for the hybrid case, paraphrase-class heuristic) is within the regex floor's documented coverage envelope (today: English known crisis vocabulary). If the classifier failed AND the input is in-coverage for regex, fall through to regex; if regex also returns no-crisis, return no-crisis (acceptable because the regex floor IS the v1.0 baseline for that coverage class).
- **(b) Hard-fail OUT-OF-COVERAGE inputs.** For any input where the chosen primary classifier failed AND the input is OUT of the regex floor's documented coverage envelope (e.g., detected language is Twi; or detected paraphrase-class is in the "not-handled-by-regex" set per Rule 6 corpus), throw a typed `CrisisClassifierUnavailableError` and let the chat handler translate it to a 503 with the canonical retry-advisory envelope (mirrors the Mode 1 Category C audit-failure pattern from PR #163; AI-RESIL-001 / FLOOR-020). This is the ONLY acceptable posture for out-of-coverage inputs — silent fall-through is not an option.
- **(c) Uniform hard-fail.** Acceptable as a simpler alternative to the (a)/(b) split — every classifier failure becomes a 503 regardless of coverage class. Trades user-visible failure rate (every Mode 1 chat 503s under classifier outage) for implementation simplicity (no language-detection branch in the fail-closed path). The ratifier may judge this acceptable for Telecheck-US English-only patients with stable Claude availability and not acceptable for the broader matrix; the choice MUST be explicit and documented on the Category A audit detail.

The chosen option's downstream impl MUST pick the (a+b) split OR the (c) uniform posture explicitly. ADR-030 (per the Resolution path) MUST document the choice + the coverage envelope (which language-set + which paraphrase-class the regex floor is approved to back-stop). The Category A `crisis_detection_trigger` audit detail MUST carry `fail_closed_posture: 'regex_fallback' | 'hard_fail' | 'never_invoked'` per classifier invocation so retrospective ops review can distinguish "I had a Claude outage and we fell back to regex (covered)" from "I had a Claude outage and we 503'd (covered differently)" from "Claude was healthy" — a regression where the bounded fall-through silently extended into out-of-coverage inputs would be visible from the audit chain.

**Rule 3 — PHI handling is encoded in the chosen classifier's deployment posture.** Whatever option ratifies, the downstream impl MUST update `Telecheck_Contracts_Pack_v5_00_INVARIANTS.md` §I-022 (PHI processing posture) with an explicit row for "crisis-detection classifier" naming the deployment location (Anthropic API per existing BAA / AWS VPC per ADR-024 / hybrid both with provenance-stamped audits). Any subsequent change of classifier is a new SI.

**Rule 4 — Latency budget is platform-floor.** The crisis gate's wall-clock budget is ≤500ms P95 (per Master PRD v1.10 §13.5 SLA table; same budget as today's regex). Any classifier whose P95 detection latency exceeds 500ms cannot ship — even if its accuracy is superior — because Mode 1 chat handler's overall request budget is 5s P95 and the crisis-gate is in the synchronous safety path. The downstream impl MUST include a budget regression test (sub-500ms P95 at the realistic input-size distribution).

**Rule 5 — Audit detail captures classifier provenance** (Codex provenance pattern from PR #164). The Category A `crisis_detection_trigger` audit row's `detail` field MUST include:

- `classifier_id: string` — identifies WHICH classifier fired (`'regex_v1'` / `'claude_haiku_v3'` / `'distilbert_crisis_v1.2'` / etc.)
- `classifier_confidence?: number` — only for ML-based classifiers; null for regex
- `classifier_latency_ms: number` — wall-clock from `detect()` entry to `detect()` return; enables P95 monitoring
- `classifier_language_detected?: string` — for multi-language classifiers; null if monolingual
- `fail_closed_posture: 'never_invoked' | 'regex_fallback' | 'hard_fail'` — records which Rule 2 branch fired on this detection invocation. `'never_invoked'` means the primary classifier ran and returned without error (default state); `'regex_fallback'` means the primary classifier failed AND the input was in the regex coverage envelope so we fell through; `'hard_fail'` means the primary classifier failed AND the input was OUT of the regex coverage envelope so we 503'd (this state will only ever appear on the Cat A row for the rare case where regex itself caught a fail-out-of-coverage input — most hard-fail cases never reach this audit because no crisis was confirmed, but where regex caught it the audit must capture that the primary classifier was unavailable). This is the Codex R1 H1 audit-visibility hook for Rule 2 (2026-05-16).
  This is a non-breaking addition to the AUDIT_EVENTS `crisis_detection_trigger` detail schema; the downstream impl MUST emit a Spec Issue against AUDIT_EVENTS to amend the schema before code lands. Without provenance the platform cannot measure classifier accuracy regression or distinguish "regex caught this" vs "ML caught this" forensically, nor verify Rule 2's coverage-class bounded fall-through is operating correctly.

**Rule 6 — Twi (or whatever non-EN language ratifies) is in-scope at first launch.** A classifier upgrade that ships EN-only is not closure of this SI — it perpetuates the silent-miss exposure for Ghana patients (the very tenant this SI is most-needed for). If the chosen option cannot ship multi-language coverage at launch, the SI does not close — it stays open and the Ghana pilot stays on Option D (chat gated off) until multi-language coverage ships.

## What this SI does NOT propose

- **A specific classifier choice.** Listed as a ratifier judgment above — the SI deliberately presents options with tradeoffs, NOT a recommendation.
- **Replacement of the regex-floor `CRISIS_PATTERNS` array.** Even if a primary classifier ratifies, the regex floor is a defensible secondary surface (Rule 2 option (a)) and SHOULD be preserved as the v1.0 baseline. The regex maintenance lift is small (the patterns are stable; new vocabulary is added on incident review).
- **Voice transcript pipeline integration.** Out of scope until the voice surface activates (no voice-capable tenants at v1.0 per Master PRD v1.10 §10.4 voice ADR). When voice activates, the chosen classifier's audio-transcript interface is a follow-on SI.
- **Forms-intake free-text crisis surfaces.** The Forms Engine processes patient free-text in some flows; whether those route through `crisisDetector.detect()` is a separate Forms-Engine-level decision tracked in the v1.0 Forms slice PRD.
- **A new ADR pre-ratification.** Each of Options A/B/C/D requires a new ADR (ADR-030 candidate) when chosen — the ADR documents the WHY of the chosen posture. The SI does not draft the ADR; the ratifier authors it as part of the resolution path.

## Resolution path

When SI-014 closes:

1. **Ratifier decision** (Evans + Engineering Lead + Platform Clinical Governance + Platform AI Safety) on Option A / B / C / D. The decision is recorded as the new ADR-030 (one of: "Crisis-detection classifier — Claude" / "— on-prem fine-tuned" / "— hybrid" / "— deferred for Mode 1 v1.0").
2. **AUDIT_EVENTS amendment** to add Rule 5's classifier-provenance fields to the `crisis_detection_trigger` Category A detail schema (purely additive; existing consumers of the schema are unaffected if they ignore the new fields).
3. **INVARIANTS amendment** to I-022 (PHI processing posture) with the chosen classifier's deployment location row.
4. **Engineering authors** the downstream impl checklist matching the chosen option (MUST preserve Rules 1–6 above):
   - `src/lib/crisis-detection.ts` — extend `CrisisDetector` with the chosen classifier; preserve the constructor argument-count fail-closed gate
   - `src/lib/crisis-detection.ts` — `detect()` returns the same `CrisisDetectionOutcome` type but the implementation calls the chosen classifier; latency-instrumented; provenance fields populated
   - `src/modules/ai-service/internal/runCrisisGate.ts` (or equivalent) — Category A audit detail now includes the four provenance fields from Rule 5
   - Multi-language test corpus — at minimum 50 ratifier-approved Twi crisis utterances + 50 EN paraphrase crisis utterances + 50 negative-control (clinical-context discussion of crisis topics that MUST NOT detect) covering the full language matrix
   - If Option C (hybrid): the parallel-execution combiner + the per-classifier audit-detail capture
   - If Option B (on-prem): the model service deployment + the latency-floor regression test + the model-drift monitoring dashboard
   - If Option A or C (Claude): the AI-RESIL-001 fail-soft path + the fallback to regex if the API fails
5. **Regression tests** — see the obligation list below
6. **Promotion Ledger entry** documenting the ADR-030 + classifier ratification

Code change is bounded to the chosen option's scope. Option A: ~150 LOC + 1 new module for the Claude classifier client. Option B: ~400 LOC + the model-service deployment infra. Option C: ~250 LOC + both. Option D: 0 LOC (the chat handler's route guard becomes the SI's resolution).

## Regression test obligations (downstream impl)

When the code change lands (Options A/B/C — Option D is a non-deliverable), the test surface MUST be SPLIT into two distinct gates per the discipline floor (Codex R1 M1 closure 2026-05-16): **deterministic CI tests** that gate every PR merge, and **clinical-acceptance gates** that gate promotion-to-production. Conflating the two — running a 50-utterance Twi corpus against the live Claude API on every CI run — would make CI flaky, model-version-dependent, and cost-leaky, AND would not actually block clinical regressions because PR authors would simply re-run flaky CI until it passed.

### Tier 1 — Deterministic CI contract tests (gate every PR merge)

Run on every PR; must be 100% deterministic; MUST NOT make live external calls to Claude (use the PR #165 generic audit-failure injection harness pattern to mock the classifier surface).

1. **Always-on contract preserved**: `new CrisisDetector(anyArg)` STILL throws `DisabledCrisisDetectionError` regardless of which classifier ratified (Rule 1; the I-019 platform-floor must not regress as a side effect of the classifier upgrade)
2. **Fail-closed routing per Rule 2 — within-coverage**: chosen primary classifier throws via injected stub AND input is within the regex coverage envelope → handler outcome matches the ratified posture from ADR-030 (regex fallback fires; Category A audit detail records `fail_closed_posture: 'regex_fallback'` + `classifier_id: 'regex_v1'`)
3. **Fail-closed routing per Rule 2 — out-of-coverage**: chosen primary classifier throws via injected stub AND input is OUT of the regex coverage envelope (Twi, paraphrase-class) → handler returns 503 with the canonical retry-advisory envelope; NO silent `crisisDetected: false`; Category A audit (if a regex floor catch happened en route) records `fail_closed_posture: 'hard_fail'`
4. **Provenance fields populated on every detection**: every Category A `crisis_detection_trigger` audit row from a successful detection carries the five Rule 5 fields with non-null `classifier_id`, non-zero `classifier_latency_ms`, and `fail_closed_posture: 'never_invoked'` (the normal happy-path value)
5. **Round-trip with PR #165 generic audit-failure injection harness**: an injector bound to the chosen classifier's adapter reproduces the "primary classifier fails → fallback or hard-fail per Rule 2 → audit detail captures the posture" round-trip; uses the closure-per-emitter pattern from PR #165 so this injector does not collide with the existing `emitMode1ChatResponseAudit` injector when both run in the same test file
6. **Bypass invariant from PR #160 R6 still holds**: oversized crisis content (>200KB) still passes through `detect()` BEFORE Zod size constraints reject the request (the bypass plumbing is in the chat handler, but the classifier adapter must handle large inputs without OOM / timeout regressions; mocked classifier path)
7. **Latency budget on the MOCKED path**: P95 of the orchestration overhead (detect-entry to detect-return, with the classifier adapter mocked to return in 1ms) stays under a small budget (~50ms P95) — this catches regressions in the orchestration layer (extra serialization, redundant DB calls in the safety path, etc.) without depending on external-API latency stability
8. **Frozen-corpus smoke set**: a SMALL (5-10 utterances each) corpus of well-known crisis + non-crisis test cases checked into the repo MUST classify correctly via the chosen classifier's deterministic mode — for Option A this means a recorded-response fixture (Claude returned X for input Y; replay the recording); for Option B this means the on-prem model artifact pinned to the test's expected outputs. The corpus is small enough to maintain in code; the GIANT clinical corpus stays in Tier 2

### Tier 2 — Clinical-acceptance gates (gate promotion-to-production; NOT every PR)

Run against the LIVE chosen classifier (pinned model version per ADR-030), with the full clinical-corpus assertions. Owned by Platform Clinical Governance + Platform AI Safety, not by code reviewers. Gates promotion of a new classifier version (or initial v1.0 launch) — separate sign-off ceremony, separate cadence (e.g., per quarterly model refresh), not on every PR.

1. **Twi (or chosen non-EN language) coverage**: minimum 50 ratifier-approved crisis utterances → ALL must detect against the pinned classifier model version. Every false negative is a P0 promotion blocker; the labeled corpus IS the safety surface
2. **Negative-control coverage**: minimum 50 clinical-context discussions of crisis topics ("the patient discussed their previous suicide-prevention training program" / "my book club is reading a memoir about overdose recovery") → MUST NOT detect against the pinned classifier model version. False-positive rate above a ratifier-set threshold compromises clinician trust in the surface
3. **EN paraphrase coverage**: minimum 50 paraphrased crisis utterances ("I don't see a way forward" / "everything feels final tonight" / "I've made my decision and it's permanent") → ALL must detect against the pinned classifier model version
4. **Live-classifier P95 latency**: P95 sub-500ms across the representative input-size distribution (small + medium + 200KB oversized-bypass), measured against the pinned classifier in the production deployment posture. Not in CI because external-API latency variance would make CI flaky; lives in the pre-promotion canary suite
5. **Provenance audit chain regression**: the per-week sample of Category A `crisis_detection_trigger` audit rows is reviewed for fail_closed_posture distribution — any unexpected drift (e.g., `regex_fallback` rate climbs from 0.5% to 5%) is an ops-triage signal that the primary classifier is degrading, even if it's not yet throwing

**The split rationale**: Tier 1 proves the plumbing is correct (the classifier surface is wired into the right places; failures route correctly; audits capture the right shape). Tier 2 proves the classifier itself is clinically adequate. The two CANNOT be conflated because the failure modes are different — a Tier 1 regression is a code bug fixable by a developer; a Tier 2 regression is a clinical-safety issue requiring ratifier judgment on whether to roll back to a previous model version. Putting Tier 2 in CI would conflate "developer can re-run the build" with "ratifier must convene to decide whether to ship this model."

The ADR-030 (per the Resolution path) MUST document the Tier 2 cadence + the ratifier sign-off process. ADR-030 may NOT shift Tier 2 obligations into CI — that's an automatic block.

## Cross-cutting impact

This SI's resolution materially changes the platform-floor safety posture. Until ratification:

- Telecheck-US (Heros Health DBA) launch on Mode 1 chat carries the EN-only stub limitation. Acceptable IF the ratifier explicitly judges so (most US patients write EN; the false-negative gap is paraphrase coverage, not language).
- Telecheck-Ghana (Heros Health Ghana DBA) launch on Mode 1 chat is BLOCKED by Rule 6 — the stub does not satisfy I-019 for the Ghana tenant's expected language mix.

The Master Completion Plan v1.0 Phase B "Clinical Care" track depends on this SI's resolution. The plan's exit gate for Phase B includes I-019 verified end-to-end; "verified" requires a non-stub classifier per the docstring's own production-readiness criteria.

## Status

- **Filed:** 2026-05-16 (autonomous run; Addendum 27 next-entry-point identification)
- **Target Promotion Ledger entry:** P-022 (alongside the other 9 pending SIs in the next ratification ceremony — SI-003/004/005/008/009/010/011/012/013/014)
- **Blocks:** Telecheck-Ghana Mode 1 chat patient launch (per Rule 6); Master Completion Plan Phase B exit gate
- **Blocked by:** ratifier availability for ADR-030 classifier-choice decision (Evans + Engineering Lead + Platform Clinical Governance + Platform AI Safety)

— Claude (Opus 4.7, 1M context), 2026-05-16 autonomous run
