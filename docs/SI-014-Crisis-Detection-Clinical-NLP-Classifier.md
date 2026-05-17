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

**Rule 2 — Failure mode is fail-CLOSED on the safety surface.** If the chosen classifier (Claude API call, on-prem model service, hybrid combiner) throws or times out, the platform MUST NOT return `crisisDetected: false`. Two acceptable fail-closed postures:

- **(a) Combine with the regex floor.** If the chosen primary classifier fails, fall through to the existing regex matchers; if regex also returns no-crisis, return no-crisis (acceptable because the regex floor was the v1.0 baseline anyway).
- **(b) Hard-fail the request.** Throw a typed `CrisisClassifierUnavailableError` and let the chat handler translate it to a 503 with the canonical retry-advisory envelope (mirrors the Mode 1 Category C audit-failure pattern from PR #163; AI-RESIL-001 / FLOOR-020).
  Choice between (a) and (b) is a ratifier judgment — (a) preserves throughput but reduces effective coverage; (b) maintains coverage strictness but increases user-visible failure rate. The chosen option's downstream impl MUST pick one explicitly and document the rationale on the Category A audit detail.

**Rule 3 — PHI handling is encoded in the chosen classifier's deployment posture.** Whatever option ratifies, the downstream impl MUST update `Telecheck_Contracts_Pack_v5_00_INVARIANTS.md` §I-022 (PHI processing posture) with an explicit row for "crisis-detection classifier" naming the deployment location (Anthropic API per existing BAA / AWS VPC per ADR-024 / hybrid both with provenance-stamped audits). Any subsequent change of classifier is a new SI.

**Rule 4 — Latency budget is platform-floor.** The crisis gate's wall-clock budget is ≤500ms P95 (per Master PRD v1.10 §13.5 SLA table; same budget as today's regex). Any classifier whose P95 detection latency exceeds 500ms cannot ship — even if its accuracy is superior — because Mode 1 chat handler's overall request budget is 5s P95 and the crisis-gate is in the synchronous safety path. The downstream impl MUST include a budget regression test (sub-500ms P95 at the realistic input-size distribution).

**Rule 5 — Audit detail captures classifier provenance** (Codex provenance pattern from PR #164). The Category A `crisis_detection_trigger` audit row's `detail` field MUST include:

- `classifier_id: string` — identifies WHICH classifier fired (`'regex_v1'` / `'claude_haiku_v3'` / `'distilbert_crisis_v1.2'` / etc.)
- `classifier_confidence?: number` — only for ML-based classifiers; null for regex
- `classifier_latency_ms: number` — wall-clock from `detect()` entry to `detect()` return; enables P95 monitoring
- `classifier_language_detected?: string` — for multi-language classifiers; null if monolingual
  This is a non-breaking addition to the AUDIT_EVENTS `crisis_detection_trigger` detail schema; the downstream impl MUST emit a Spec Issue against AUDIT_EVENTS to amend the schema before code lands. Without provenance the platform cannot measure classifier accuracy regression or distinguish "regex caught this" vs "ML caught this" forensically.

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

When the code change lands (Options A/B/C — Option D is a non-deliverable), the test suite MUST cover:

1. **Always-on contract preserved**: `new CrisisDetector(anyArg)` STILL throws `DisabledCrisisDetectionError` regardless of which classifier ratified (Rule 1; the I-019 platform-floor must not regress as a side effect of the classifier upgrade)
2. **Fail-closed mode**: chosen primary classifier throws → handler outcome matches Rule 2 (a) or (b) per ratifier choice; the regression test pins WHICH posture ratified and asserts it explicitly
3. **Latency floor**: P95 sub-500ms across a representative input-size distribution (small + medium + 200KB oversized-bypass content per PR #160 R6 closure)
4. **Twi (or chosen non-EN language) coverage**: minimum 50 ratifier-approved crisis utterances → ALL must detect (every false negative is a P0; a hand-curated test corpus is the regression mechanism since the labeled corpus IS the safety surface)
5. **Negative-control coverage**: minimum 50 clinical-context discussions of crisis topics ("the patient discussed their previous suicide-prevention training program" / "my book club is reading a memoir about overdose recovery") → MUST NOT detect, otherwise false-positive alert fatigue would compromise clinician trust in the surface
6. **EN paraphrase coverage**: minimum 50 paraphrased crisis utterances ("I don't see a way forward" / "everything feels final tonight" / "I've made my decision and it's permanent") → ALL must detect at the chosen confidence threshold
7. **Provenance fields populated**: every Category A `crisis_detection_trigger` audit row carries the four Rule 5 fields with valid values per the chosen classifier (classifier_id matches the deployed classifier; classifier_latency_ms is non-zero; classifier_language_detected is non-null for multi-language classifiers)
8. **Round-trip with PR #163 audit-failure injection harness**: an injector for the chosen classifier's external call (Claude API or on-prem service) reproduces the "primary classifier fails → fallback fires → audit records `classifier_id: 'regex_v1'` (or fail-closed 503)" round-trip — uses the generalized factory from PR #165
9. **Bypass invariant from PR #160 R6 still holds**: oversized crisis content (>200KB) still passes through crisis detection BEFORE Zod size constraints reject the request (the bypass plumbing is in the chat handler, but the classifier must handle large inputs without OOM / timeout regressions)

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
