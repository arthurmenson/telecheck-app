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

**Rule 3 — PHI handling is encoded in the chosen classifier's deployment posture (APPLIES ONLY UNDER CLOSURE PATH A — Options A/B/C ship classifier).** Under Closure path A, the downstream impl MUST update `Telecheck_Contracts_Pack_v5_00_INVARIANTS.md` §I-022 (PHI processing posture) with an explicit row for "crisis-detection classifier" naming the deployment location (Anthropic API per existing BAA / AWS VPC per ADR-024 / hybrid both with provenance-stamped audits). Any subsequent change of classifier is a new SI. **UNDER CLOSURE PATH B (Option D defers — SI-014 stays open per §5)**: ZERO I-022 amendment ships — the classifier doesn't deploy, so there's no PHI-processing surface to attribute. Patch 2026-05-17 (per PR #169 Codex R1 H2 closure 2026-05-17): the previous "Whatever option ratifies" framing was unqualified and could let a downstream impl record a non-existent Option D I-022 amendment.

**Rule 4 — Latency budget is platform-floor.** The crisis gate's wall-clock budget is ≤500ms P95 (per Master PRD v1.10 §13.5 SLA table; same budget as today's regex). Any classifier whose P95 detection latency exceeds 500ms cannot ship — even if its accuracy is superior — because Mode 1 chat handler's overall request budget is 5s P95 and the crisis-gate is in the synchronous safety path. The downstream impl MUST include a budget regression test (sub-500ms P95 at the realistic input-size distribution).

**Rule 5 — Audit detail captures classifier provenance, on TWO audit surfaces (APPLIES ONLY UNDER CLOSURE PATH A — Options A/B/C ship classifier)** (Codex provenance pattern from PR #164; Codex R2 H2 closure 2026-05-16 added the always-emitted Category B surface). Under Closure path A, two distinct AUDIT_EVENTS amendments are required so that EVERY classifier invocation is audit-visible regardless of whether it confirmed a crisis or fell back / hard-failed without confirming one — the original single-surface design was a R2 H2 gap (most fail-closed paths return no-crisis, so a `crisis_detection_trigger` row never emits, so the bounded-fall-through couldn't actually be proven from the audit chain). **UNDER CLOSURE PATH B (Option D defers — SI-014 stays open per §5)**: ZERO AUDIT_EVENTS amendments ship — the classifier doesn't deploy, so there's no classifier-invocation surface to instrument. Both the Surface 1 extension of Cat A `crisis_detection_trigger` AND the new Cat B `crisis.classifier_invocation` are Closure-path-A artifacts only. Patch 2026-05-17 (per PR #169 Codex R1 H2 closure 2026-05-17): the previous "Two distinct AUDIT_EVENTS amendments are required" framing was unqualified and could let a downstream impl record non-existent Option D audit surfaces.

**Surface 1 — `crisis_detection_trigger` (Category A) detail extension** (fires only on confirmed crisis, same as today). Add to detail:

- `classifier_id: string` — identifies WHICH classifier fired (`'regex_v1'` / `'claude_haiku_v3'` / `'distilbert_crisis_v1.2'` / etc.)
- `classifier_confidence?: number` — only for ML-based classifiers; null for regex
- `classifier_latency_ms: number` — wall-clock from `detect()` entry to `detect()` return; enables P95 monitoring
- `classifier_language_detected?: string` — for multi-language classifiers; null if monolingual

**Surface 2 — NEW `crisis.classifier_invocation` (Category B)** (fires on EVERY classifier invocation regardless of outcome). This is the always-emitted surface that makes Rule 2's bounded fall-through actually auditable — it captures the fail-closed posture WHETHER OR NOT a crisis was confirmed:

- **Action ID:** `crisis.classifier_invocation` (new; add to AUDIT_EVENTS Category B at ratification)
- **Category:** B (governance/operational follow-up; not safety-floor since the safety surface fires via Category A only when a crisis is detected — this surface captures the classifier's operational state on every invocation)
- **Linked to:** if a Category A `crisis_detection_trigger` fired in the same invocation, `linked_events[]` carries its `audit_id` so a Tier 2 reviewer can correlate the two surfaces
- **Detail fields:**
  - `classifier_id: string`
  - `classifier_confidence?: number`
  - `classifier_latency_ms: number`
  - `classifier_language_detected?: string`
  - `crisis_detected: boolean` — true if this invocation triggered Cat A; false otherwise. Distinguishes "classifier ran, no crisis" from "classifier failed, fell back to regex, regex also said no crisis" via the next field
  - `fail_closed_posture: 'never_invoked' | 'regex_fallback' | 'hard_fail'` — `'never_invoked'` means the primary classifier ran and returned without error (default happy-path state); `'regex_fallback'` means the primary classifier failed AND the input was in the regex coverage envelope so we fell through (Rule 2 (a)); `'hard_fail'` means the primary classifier failed AND the input was OUT of the regex coverage envelope so we 503'd (Rule 2 (b)), or every classifier failure → 503 under Rule 2 (c)
  - `coverage_class?: 'in_coverage' | 'out_of_coverage'` — only populated when `fail_closed_posture !== 'never_invoked'`; records WHY the chosen posture path was taken (Twi detected → out_of_coverage; EN keyword detected → in_coverage). Lets Tier 2 monitor whether the coverage-classifier itself is drifting
- **Emission policy:** mandatory ATTEMPT on every `detect()` invocation regardless of outcome. **FAIL-SOFT** per the PR #164 SI-013 Rule 4 pattern — Category B emission failure logs at ERROR and DOES NOT 503, because the safety surface (Cat A if crisis confirmed, OR the regex fall-through / 503 hard-fail path) has already executed by the time Cat B emits. The fail-soft Category B is the operational-monitoring surface, not the safety-floor surface.

**Why two surfaces.** The Category A row is the safety-floor record (durable; emitted only on confirmed crisis; never deferrable). The Category B row is the always-emitted operational record (captures classifier provenance on every invocation; enables Tier 2 P95-latency monitoring, fail-closed-posture drift detection, and the per-week regression review described in Tier 2 obligation #5). A regression where the bounded fall-through silently extended into out-of-coverage inputs would show up as `fail_closed_posture: 'regex_fallback'` + `coverage_class: 'out_of_coverage'` rows in the Cat B stream — a state combination that should NEVER appear under Rule 2 (a)+(b) and is the regression signal Tier 2 monitors.

The downstream impl MUST emit a Spec Issue against AUDIT_EVENTS for BOTH surface amendments (extension of the existing Category A detail + new Category B action ID + new fail-soft emission policy) before code lands. The two amendments ratify together in the same Promotion Ledger entry.

**Rule 6 — Twi (or whatever non-EN language ratifies) is in-scope at first launch.** A classifier upgrade that ships EN-only is not closure of this SI — it perpetuates the silent-miss exposure for Ghana patients (the very tenant this SI is most-needed for). If the chosen option cannot ship multi-language coverage at launch, the SI does not close — it stays open and the Ghana pilot stays on Option D (chat gated off) until multi-language coverage ships.

## What this SI does NOT propose

- **A specific classifier choice.** Listed as a ratifier judgment above — the SI deliberately presents options with tradeoffs, NOT a recommendation.
- **Replacement of the regex-floor `CRISIS_PATTERNS` array.** Even if a primary classifier ratifies, the regex floor is a defensible secondary surface (Rule 2 option (a)) and SHOULD be preserved as the v1.0 baseline. The regex maintenance lift is small (the patterns are stable; new vocabulary is added on incident review).
- **Voice transcript pipeline integration.** Out of scope until the voice surface activates (no voice-capable tenants at v1.0 per Master PRD v1.10 §10.4 voice ADR). When voice activates, the chosen classifier's audio-transcript interface is a follow-on SI.
- **Forms-intake free-text crisis surfaces.** The Forms Engine processes patient free-text in some flows; whether those route through `crisisDetector.detect()` is a separate Forms-Engine-level decision tracked in the v1.0 Forms slice PRD.
- **A new ADR pre-ratification.** Each of Options A/B/C/D requires a new ADR (ADR-030 candidate) when chosen — the ADR documents the WHY of the chosen posture. The SI does not draft the ADR; the ratifier authors it as part of the resolution path.

## Resolution path

The resolution path is SPLIT by ratifier-chosen option family because Options A/B/C all ship a classifier (and therefore need AUDIT_EVENTS + I-022 amendments + implementation + tests) while Option D ships NO classifier (and therefore has fundamentally different closure obligations). A single-track resolution path that unconditionally required classifier-audit amendments was a Codex R3 M1 internal-inconsistency finding (2026-05-16) — under Option D, those amendments would force schemas for a non-existent invocation surface; under A/B/C they're load-bearing.

### Shared first step (all options)

1. **Ratifier decision** (Evans + Engineering Lead + Platform Clinical Governance + Platform AI Safety) on Option A / B / C / D. The decision is recorded as the new ADR-030 (one of: "Crisis-detection classifier — Claude" / "— on-prem fine-tuned" / "— hybrid" / "— deferred for Mode 1 v1.0"). ADR-030 documents the WHY of the chosen posture + (for A/B/C) the chosen Rule 2 fail-closed posture (a)+(b) or (c) + (for A/B/C) the chosen Tier 2 cadence and ratifier sign-off process.

### Closure path A — Options A/B/C ratified (classifier ships)

When SI-014 closes under Options A/B/C:

2. **AUDIT_EVENTS amendment — Surface 1**: add Rule 5 Surface 1's classifier-provenance fields to the `crisis_detection_trigger` Category A detail schema (purely additive; existing consumers of the schema are unaffected if they ignore the new fields).
3. **AUDIT_EVENTS amendment — Surface 2**: add the new `crisis.classifier_invocation` Category B action ID + its detail schema + its fail-soft emission policy per Rule 5 Surface 2.
4. **INVARIANTS amendment** to I-022 (PHI processing posture) with the chosen classifier's deployment location row (Anthropic API per existing BAA / AWS VPC per ADR-024 / hybrid both).
5. **Engineering authors** the downstream impl checklist matching the chosen option (MUST preserve Rules 1–6 above):
   - `src/lib/crisis-detection.ts` — extend `CrisisDetector` with the chosen classifier; preserve the constructor argument-count fail-closed gate
   - `src/lib/crisis-detection.ts` — `detect()` returns the same `CrisisDetectionOutcome` type but the implementation calls the chosen classifier; latency-instrumented; provenance fields populated
   - `src/modules/ai-service/internal/runCrisisGate.ts` (or equivalent) — Category A audit detail now includes the four provenance fields from Rule 5 Surface 1
   - `src/modules/ai-service/internal/audit.ts` (or equivalent) — NEW emitter `emitCrisisClassifierInvocation` for Rule 5 Surface 2 with fail-soft callsite (mirrors SI-013 PR #164 Rule 4)
   - Multi-language test corpus — see Tier 2 obligations (NOT a CI artifact)
   - If Option C (hybrid): the parallel-execution combiner + the per-classifier audit-detail capture
   - If Option B (on-prem): the model service deployment + the latency-floor regression test + the model-drift monitoring dashboard
   - If Option A or C (Claude): the AI-RESIL-001 adapter wiring per ADR-020. **The fail-closed posture is NOT "fall back to regex if the API fails."** It is whichever of Rule 2's three postures ADR-030 ratifies — (a)+(b) coverage-scoped split (in-coverage → regex fallback; out-of-coverage → typed `CrisisClassifierUnavailableError` → 503), or (c) uniform hard-fail (every classifier failure → 503 regardless of language). The downstream impl MUST implement WHICHEVER posture ADR-030 chose; it must NOT default to blanket regex fallback (which would silently regress to today's Twi/paraphrase miss exposure that this SI was filed to close). Codex R2 H1 closure 2026-05-16.
6. **Regression tests** — Tier 1 + Tier 2 per the split obligation list below
7. **Promotion Ledger entry** documenting ADR-030 + classifier ratification + the two AUDIT_EVENTS amendments + the I-022 amendment

Code-change scope: Option A ~150 LOC + 1 new module for the Claude classifier client. Option B ~400 LOC + the model-service deployment infra. Option C ~250 LOC + both.

### Closure path B — Option D ratified (classifier DEFERRED — SI-014 does NOT close)

**Important (Codex R3 H1 closure 2026-05-16):** Option D is a DEFERRAL posture, NOT a closure posture. SI-014 itself REMAINS OPEN under Option D — it is rescoped from "open / awaiting classifier choice" to "open / deferred behind patient-access gate; classifier choice rescoped to successor SI-014.1." This framing reconciles with the Cross-cutting impact section's statement that Master Completion Plan Phase B verification requires a non-stub classifier: if Option D ratifies, Phase B's I-019 verification gate is satisfied SOLELY by the patient-access gate being in place (no patient surface = no I-019 verification surface to fail) AND by a hard governance block on any future Mode 1 patient-access re-enable until SI-014.1 ratifies a classifier choice.

A previous draft framed Option D as a clean closure with no further SI obligations — that framing was the R3 H1 contradiction, because it would let governance mark SI-014 / P-022 / Phase B closed while the same document's Cross-cutting impact section said Phase B verification requires the non-stub classifier (which under Option D does not exist). The two cannot both be true: either Option D leaves SI-014 open (this section's framing) or the Cross-cutting impact language must be weakened (which would silently soften the I-019 platform-floor — not acceptable for a clinical-safety surface).

When Option D ratifies, the deliverables are FUNDAMENTALLY DIFFERENT from Options A/B/C — no classifier ships, no AUDIT_EVENTS amendments are needed (the new Cat B `crisis.classifier_invocation` would have no producer), no I-022 amendment is needed (no new PHI-processing surface exists). The interim-deliverable path is:

2. **Mode 1 patient-access gate**: configure the Mode 1 chat handler's route guard so patient JWTs cannot access `/v0/ai/chat` at v1.0. Clinician-test JWTs may retain access for internal QA. This is a small handler-level change (~20 LOC + a feature-flag check) — NOT a classifier change.
3. **Hard governance block on patient Mode 1 re-enable**: ADR-030 under Option D MUST specify that lifting the patient-access gate requires successor SI-014.1 (or whichever SI succeeds this one) ratifying a classifier choice + the full Closure path A deliverables landing. The patient-access gate is NOT removable by a routine feature-flag flip; the removal MUST be gated by a Promotion Ledger entry that itself depends on SI-014.1 closure.
4. **Patient-facing surface communication**: any documentation or marketing copy that promised Mode 1 chat to patients at v1.0 launch MUST be updated to reflect the deferred posture. The Master PRD v1.10 §17 engagement KPI projections may need a footnote acknowledging the Mode 1 deferral.
5. **Ghana pilot reaffirmation**: confirm with the Telecheck-Ghana operations team that the chronic-care surfaces (forms, async-consult, prescription/refill) are sufficient for revenue-bearing pilot launch WITHOUT Mode 1 chat — this is a stakeholder-alignment step, not a code change.
6. **Promotion Ledger entry** documenting the DEFERRAL decision (NOT a classifier ratification, NOT a closure of SI-014 — explicitly an "SI-014 rescoped to deferral; patient Mode 1 inaccessible; classifier choice routed to SI-014.1"). The ledger entry includes the trigger event(s) that would re-open classifier work (e.g., new partnership requirement; new tenant onboarding requiring Mode 1; clinical-governance ratifier readiness to evaluate options A/B/C).
7. **SI-014.1 (or successor SI) creation**: filed in the same ratification ceremony, status "Open / awaiting classifier choice" with the option-evaluation framework from this SI carried forward as a baseline. The successor SI is what eventually CLOSES this lineage when Options A/B/C ratify.
8. **NO** AUDIT_EVENTS amendments. **NO** I-022 amendment. **NO** Tier 1 / Tier 2 test deliverables for this SI (the regression-test obligation list applies ONLY to Options A/B/C — see the preamble of that section). **NO** changes to `src/lib/crisis-detection.ts` (the regex stub remains for the clinician-test patient surface where Mode 1 is still reachable).

Code-change scope: ~20 LOC (the patient-access gate) + the governance-block plumbing if the gate's removal needs CI-enforceable protection. The "expensive" deliverables are governance + stakeholder-communication, not engineering.

**Phase B verification reconciliation.** Under Option D, the Master Completion Plan v1.0 Phase B exit gate's I-019 verification is satisfied as follows:

- For Telecheck-Ghana chronic-care surfaces (forms, async-consult, prescription/refill) that DO operate at v1.0: I-019 verification requires the chosen classifier IF those surfaces ever route patient free-text through `crisisDetector.detect()`. The Forms Engine slice PRD scoping at v1.0 does NOT route free-text through crisis detection (per the Forms-Engine §6 docstring; crisis detection on forms is a Forms-Engine-level decision tracked separately) — so the regex stub remains in place for those surfaces' incidental crisis-detection coverage, and Phase B I-019 verification for them is satisfied by the existing stub plus the patient-access gate on Mode 1.
- For Mode 1 chat: I-019 verification under Option D is satisfied by the patient-access gate (no patient surface = no patient-facing I-019 obligation to verify). Clinician-test access remains gated by the regex stub which is documented as adequate for the clinician-test surface where false-negative risk is bounded by clinician oversight.

This Phase B reconciliation MUST be cross-referenced in the Master Completion Plan v1.0 §Phase-B-exit-gate documentation as part of Closure path B's deliverables.

## Regression test obligations (downstream impl)

**Applicability**: this entire regression-test section applies ONLY to closure paths under Options A/B/C. Option D ships no classifier and therefore has no Tier 1 / Tier 2 obligations from this SI (Codex R3 M1 closure 2026-05-16). Option D's closure verification is the patient-access-gate change described in "Closure path B" above, which is exercised by the existing Mode 1 chat handler integration tests (auth+role gates from PR #162) at the route-guard level — no new tests are needed beyond confirming the gate denies patient JWTs.

When the code change lands under Options A/B/C, the test surface MUST be SPLIT into two distinct gates per the discipline floor (Codex R1 M1 closure 2026-05-16): **deterministic CI tests** that gate every PR merge, and **clinical-acceptance gates** that gate promotion-to-production. Conflating the two — running a 50-utterance Twi corpus against the live Claude API on every CI run — would make CI flaky, model-version-dependent, and cost-leaky, AND would not actually block clinical regressions because PR authors would simply re-run flaky CI until it passed.

### Tier 1 — Deterministic CI contract tests (gate every PR merge)

Run on every PR; must be 100% deterministic; MUST NOT make live external calls to Claude (use the PR #165 generic audit-failure injection harness pattern to mock the classifier surface).

1. **Always-on contract preserved**: `new CrisisDetector(anyArg)` STILL throws `DisabledCrisisDetectionError` regardless of which classifier ratified (Rule 1; the I-019 platform-floor must not regress as a side effect of the classifier upgrade)

2. **Fail-closed routing per Rule 2 — CONDITIONAL ON ADR-030 POSTURE (Codex R2 M1 closure 2026-05-16).** The test obligations split depending on which fail-closed posture ADR-030 ratified:
   - **If ADR-030 chose (a)+(b) coverage-scoped split:**
     - (2.a.in) Within-coverage input + classifier throws via injected stub → regex fallback fires; if regex matched, response is 200 with crisis sentinel; Category A audit detail records `fail_closed_posture: 'regex_fallback'` + `classifier_id: 'regex_v1'`; Category B `crisis.classifier_invocation` row records `fail_closed_posture: 'regex_fallback'` + `coverage_class: 'in_coverage'`
     - (2.a.out) Out-of-coverage input (Twi/paraphrase per ADR-030's coverage envelope) + classifier throws via injected stub → handler returns 503 with the canonical retry-advisory envelope; NO silent `crisisDetected: false`; Category B `crisis.classifier_invocation` row records `fail_closed_posture: 'hard_fail'` + `coverage_class: 'out_of_coverage'`
     - (2.a.regression) **REGRESSION GUARD**: out-of-coverage input + classifier throws → there MUST NOT be a Category B row with `fail_closed_posture: 'regex_fallback'` + `coverage_class: 'out_of_coverage'`. This state combination would indicate the bounded fall-through silently extended into out-of-coverage inputs (the exact Rule 2 H1 regression we're guarding against)
   - **If ADR-030 chose (c) uniform hard-fail:**
     - (2.c.any) ANY classifier failure (regardless of input language) → handler returns 503; NO silent regex fall-through; Category B `crisis.classifier_invocation` row records `fail_closed_posture: 'hard_fail'`; `coverage_class` is null OR `coverage_class: 'in_coverage'` (the language-detection branch may still record what it saw)
     - (2.c.regression) **REGRESSION GUARD**: classifier failure on ANY input → there MUST NOT be a Category B row with `fail_closed_posture: 'regex_fallback'`. The (c) posture forbids ALL regex fallback paths; a regex_fallback row would indicate the posture was mis-implemented or silently softened

   The downstream impl's PR description MUST cite which ADR-030 posture is in force and which branch of (2) the test suite implements. CI does not auto-detect this; the human-author + Codex reviewer is the gate.

3. **Provenance fields populated on every detection**: every Category A `crisis_detection_trigger` audit row from a successful detection carries the four Rule 5 Surface 1 fields with non-null `classifier_id`, non-zero `classifier_latency_ms`; AND every classifier invocation (regardless of outcome) emits a Category B `crisis.classifier_invocation` row with the six Rule 5 Surface 2 fields populated per the actual code path taken
4. **Category B always-emit invariant**: for every `detect()` invocation the test setup makes — crisis-detected, no-crisis, fail-closed regex-fallback, fail-closed hard-fail — a Category B `crisis.classifier_invocation` row MUST be present in `audit_records` for that invocation's tenant + correlation. The test asserts the COUNT of Cat B rows equals the count of detect() invocations, with no double-emission and no missing emissions. This is the regression guard that proves Rule 2's bounded fall-through is actually auditable
5. **Round-trip with PR #165 generic audit-failure injection harness**: an injector bound to the chosen classifier's adapter reproduces the "primary classifier fails → fallback or hard-fail per ADR-030 posture → BOTH audit surfaces capture the posture" round-trip; uses the closure-per-emitter pattern from PR #165 so this injector does not collide with the existing `emitMode1ChatResponseAudit` injector when both run in the same test file. A SECOND injector bound to `emitCrisisClassifierInvocation` exercises the fail-soft policy on the new Category B emitter (mirrors SI-013 PR #164 Rule 4 — Cat B emission failure logs ERROR and does NOT 503; safety surface unaffected)
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

The Master Completion Plan v1.0 Phase B "Clinical Care" track depends on this SI's resolution. Phase B I-019 verification semantics are OPTION-SCOPED (Codex R3 H1 v2 closure 2026-05-16; previous unqualified language created a governance-blocking contradiction with Closure path B's Phase B reconciliation):

- **Under Options A/B/C ratified**: Phase B I-019 verification REQUIRES the shipped non-stub classifier (per the docstring's own production-readiness criteria) + the two AUDIT_EVENTS amendments + the I-022 amendment + Tier 1+2 test obligations passing. SI-014 closes; Phase B can mark I-019 verified end-to-end.
- **Under Option D ratified**: Phase B I-019 verification is CONDITIONALLY satisfied while AND ONLY WHILE (a) the Mode 1 patient-access gate from Closure path B is in force, AND (b) the SI-014.1-dependent governance block on gate-removal is in force, AND (c) no other patient-facing surface routes free-text through `crisisDetector.detect()` at v1.0 (per the Forms-Engine slice scoping carve-out documented in Closure path B's Phase B reconciliation). If any of (a)/(b)/(c) lapses, Phase B I-019 verification reverts to "not satisfied" until SI-014.1 ratifies a classifier choice via Closure path A. The Master Completion Plan v1.0 §Phase-B-exit-gate doc MUST cross-reference these three conditions explicitly so the conditional-satisfaction semantics is auditable.

A previous draft made the Phase B language unqualified ("verified requires a non-stub classifier") which contradicted Closure path B's claim that Option D satisfies Phase B via the patient-access gate. The option-scoped framing above reconciles the two by acknowledging that I-019's verification surface is the SET OF PATIENT-ACCESSIBLE SURFACES THAT ROUTE FREE-TEXT THROUGH CRISIS DETECTION — under Option D that set is empty for Mode 1 (gated off) and out-of-scope for v1.0 Forms (carve-out), so the verification obligation has no surface to attach to.

## Status

- **Filed:** 2026-05-16 (autonomous run; Addendum 27 next-entry-point identification)
- **Target Promotion Ledger entry:** P-022 (alongside the other 9 pending SIs in the next ratification ceremony — SI-003/004/005/008/009/010/011/012/013/014)
- **Blocks (OPTION-SCOPED per Codex R3 H1 v2 closure 2026-05-16):**
  - Telecheck-Ghana Mode 1 chat patient launch (per Rule 6) — blocks UNLESS Option D ratifies (in which case the patient-access gate from Closure path B IS the blocking mechanism, by design)
  - Master Completion Plan Phase B exit gate — blocks under Options A/B/C until classifier ships; under Option D, conditionally satisfied while the three Closure-path-B conditions hold (gate in force + SI-014.1 dependency in force + no other patient surface routes free-text through crisisDetector.detect)
- **Blocked by:** ratifier availability for ADR-030 classifier-choice decision (Evans + Engineering Lead + Platform Clinical Governance + Platform AI Safety)
- **Closure semantics (Codex R3 H1 closure 2026-05-16):**
  - **Options A/B/C ratified** → SI-014 CLOSES via Closure path A; Phase B I-019 verification satisfied by the shipped classifier + the two AUDIT_EVENTS amendments + the I-022 amendment + Tier 1+2 test obligations
  - **Option D ratified** → SI-014 DOES NOT CLOSE; it is RESCOPED to "open / deferred behind patient-access gate" via Closure path B. Successor SI-014.1 is filed in the same ratification ceremony. SI-014 only closes when SI-014.1 ratifies a classifier choice + the full Closure path A deliverables land. Phase B I-019 verification under Option D is CONDITIONALLY satisfied while AND ONLY WHILE ALL THREE conditions hold (per the Cross-cutting impact section above; Codex R5 H1 closure 2026-05-16): (a) the Mode 1 patient-access gate from Closure path B is in force; AND (b) the SI-014.1-dependent governance block on gate-removal is in force; AND (c) no other patient-facing surface routes free-text through `crisisDetector.detect()` at v1.0 (per the Forms-Engine slice scoping carve-out). If ANY of (a)/(b)/(c) lapses, Phase B I-019 verification reverts to "not satisfied" until SI-014.1 ratifies a classifier choice via Closure path A. The bullet MUST list all three conditions explicitly so a Status-block-only reader cannot mistake the Mode 1 gate alone for sufficient verification — a previous draft summarized this as "patient-access gate alone" which was the Codex R5 H1 finding (the summary dropped conditions (b) and (c) and could let a ratifier mark Phase B verified even if another patient surface started routing free text through the stub or if the gate became removable without the SI-014.1 dependency).

— Claude (Opus 4.7, 1M context), 2026-05-16 autonomous run
