# ADR-030 Decision Brief — Crisis-Detection Clinical NLP Classifier

**Date:** 2026-05-17
**Status:** DECISION-BRIEF (clinical-safety quorum input; does NOT pre-commit to any option)
**Quorum required:** Evans (workstream lead) + Engineering Lead + Platform Clinical Governance + Platform AI Safety
**Triggering SI:** SI-014 (`docs/SI-014-Crisis-Detection-Clinical-NLP-Classifier.md`) — workstream-canonical source
**Decision scope:** Choose ONE of Options A/B/C/D below. The choice becomes ADR-030.

**This brief is NOT a recommendation.** The decision is a CRITICAL clinical-safety + regulatory + cost judgment that the quorum must make. The brief surfaces the 4 options with their tradeoffs along the dimensions that matter (clinical efficacy, regulatory posture, latency budget, multi-tenant cost, multi-language coverage, PHI handling), plus the 6 hard rules that constrain ANY chosen implementation.

---

## Why this decision matters now

### The clinical-safety surface

Mode 1 chat (the patient-facing conversational assistant per Master PRD v1.10 §16) routes free-text patient input through `crisisDetector.detect()` before generating any assistant response. Today's detector is a **regex-based stub** that matches a known English crisis vocabulary (suicidal ideation; self-harm; abuse; emergency keywords). The platform-floor invariant I-019 says crisis detection is always-on for every free-text patient input.

The regex stub has **known coverage gaps**:
- **Non-English languages.** Twi (the dominant non-English language for the Telecheck-Ghana pilot tenant) has zero coverage. Pidgin English is partial. Any patient writing in Twi who expresses crisis content silently bypasses the platform-floor.
- **Paraphrases.** "I want to disappear forever" is not in the regex set; "I don't want to live anymore" is. The miss class is meaningful — patients in crisis often use indirect language.
- **Quotation context.** "I read a poem yesterday that said 'kill myself'" matches the regex; the patient is not in crisis. False positive rate is high enough that Tier 1 reviewers see noise.

The Ghana pilot launch (Track 1 critical-path; SI-012 + SI-007 ratified 2026-05-17) brings the Twi coverage gap from theoretical to active risk. Decision deadline is pilot-launch-dependent.

### The pilot-launch dependency

| Decision | Pilot-launch impact |
| --- | --- |
| **A / B / C ratified** → classifier ships → Mode 1 chat opens to patients in pilot launch | Marquee feature live at launch; engagement KPIs on plan |
| **D ratified** → Mode 1 chat gated off for patients; chronic-care surfaces (forms, async-consult, prescriptions) ship normally | 60-90 day delay minimum on Mode 1 chat patient access; 6-12 months if Option B; opportunity cost to engagement KPIs + WHO/UN partnership Mode 1 demo gate (per ADR-028 some scopings) |

### The Master Completion Plan Phase B gate

Per Master Completion Plan §"Hard sequencing rules", Phase B (anchor slices) exit gate verifies I-019. **Under Options A/B/C, Phase B exits when the classifier ships.** **Under Option D, Phase B is conditionally satisfied** ONLY WHILE three conditions hold (per SI-014 §5 R5 H1 closure): (a) Mode 1 patient-access gate in force, AND (b) SI-014.1-dependent governance block on gate-removal in force, AND (c) no other patient-facing surface routes free-text through `crisisDetector.detect()`. If any of (a)/(b)/(c) lapses, Phase B reverts to "not satisfied" until SI-014.1 ratifies a classifier.

---

## The 4 options

### Option A — Anthropic Claude as the classifier

**Mechanism.** Call Claude Haiku (or similar small/fast model) via the multi-provider abstraction the Mode 1 chat handler already uses per ADR-020. Tightly-scoped system prompt: "Classify this patient-authored text for crisis indicators. Return JSON: { crisis: bool, type: enum, confidence: 0-1, reasoning: string }." Runs IN-LINE in the chat-handler safety gate BEFORE the response prompt fires.

| Dimension | Value |
| --- | --- |
| **Clinical efficacy** | Multi-language out of the box (Twi + EN + Pidgin natively). Paraphrase + negation + quotation context handled. Continuous improvement as Anthropic improves the model. |
| **Regulatory posture (HIPAA)** | Covered under existing Anthropic BAA per ADR-024. PHI surface widened (every patient utterance → Anthropic API). |
| **Regulatory posture (FDA)** | Quality System documentation per 21 CFR 820 required (classification accuracy tracked + reported). Classification record-keeping in Cat A + Cat B audit surfaces per SI-014 Rule 5. |
| **Regulatory posture (GDPR)** | Out of scope for v1.0 launch — neither pilot tenant has EU patients. Future EU expansion = explicit consent + DPA + processor-controller mapping. |
| **Latency budget** | P50 ~400ms for a small classification call. **Risk:** the 500ms P95 platform-floor for the full crisis gate (per Rule 4) leaves ~100ms margin. Anthropic latency variance could exceed budget during outages. |
| **Cost order-of-magnitude (pilot scale)** | 1k patients × 5 utterances/day × 90 days = 450k calls/quarter at Haiku rates ≈ **$45–$90/quarter** (negligible at pilot scale). |
| **Cost order-of-magnitude (full scale)** | 100k patients × 20 utterances/day × 365 days = 730M calls/year ≈ **$73k–$146k/year** + model upgrade pricing variance (material but bounded). |
| **Failure mode** | Provider unavailable → must combine with regex fallback per Rule 2 OR uniform hard-fail (503 every call). |
| **Engineering complexity** | LOW — ~150 LOC + 1 new module for the Claude classifier client. Uses existing AI provider abstraction. |
| **Time to launch-ready** | 2-4 weeks (mostly Quality System documentation + regression test harness). |

### Option B — On-prem fine-tuned classifier (e.g., DistilBERT + crisis-trained dataset)

**Mechanism.** Train (or fine-tune from a pretrained base model) a small classifier on a curated crisis-language dataset. Deploy on-prem in AWS us-east-1 VPC per ADR-026. Each detection is a sub-50ms forward pass on commodity GPU.

| Dimension | Value |
| --- | --- |
| **Clinical efficacy** | Strong on the trained-data distribution; weaker than Claude on edge cases (rare paraphrases, unusual registers). Drift management is platform-team responsibility. |
| **Regulatory posture (HIPAA)** | **Simplest of all options.** PHI never leaves the AWS VPC. Tightest HIPAA posture. |
| **Regulatory posture (FDA)** | Same Quality System documentation as Option A, but the platform OWNS the model — easier to audit but heavier to maintain. |
| **Regulatory posture (GDPR)** | **Simplest** (data residency controlled). |
| **Latency budget** | Sub-50ms P95. Leaves full chat-handler safety budget for the response prompt. **Best latency profile of all options.** |
| **Cost order-of-magnitude (one-time)** | **$50k–$200k per language** (clinical dataset curation + annotation + model dev + clinical validation). Twi dataset doesn't exist publicly — must be created with clinical + linguistic + legal partner. |
| **Cost order-of-magnitude (recurring)** | $2–$8k/month fixed AWS GPU lease at projected v1.0 traffic. Plus 0.5–1 FTE for model drift monitoring + retraining (clinical + linguistic + ML engineer time). |
| **Failure mode** | Local — model service restart is a known operational pattern. No external dependency. |
| **Engineering complexity** | HIGH — ~400 LOC + model-service deployment infra + per-language training pipeline + drift monitoring dashboard. |
| **Time to launch-ready** | **6–12 months** (Twi dataset creation is the long pole; EN-only could be 3-4 months). Would push pilot launch past calendar 2026. |

### Option C — Hybrid (regex stub as floor + Claude as primary)

**Mechanism.** Detection runs BOTH the existing regex floor (sub-1ms; high-recall on known EN crisis vocabulary) AND a Claude call IN PARALLEL. Outcome: crisis IF either fires. Audit records WHICH classifier fired (for forensic correlation + classifier-accuracy tracking) on the Cat A `crisis_detection_trigger` row + the new Cat B `crisis.classifier_invocation` row per SI-014 Rule 5.

| Dimension | Value |
| --- | --- |
| **Clinical efficacy** | Same as Option A (Claude carries the multi-language + paraphrase + negation surface) + regex floor as graceful-degradation fallback for EN. Side-by-side classifier-accuracy measurement is built in (per SI-014 §3 Option C: every Claude detection the regex did NOT detect is a measurable "Twi or paraphrase save" that justifies the OPEX). The source does NOT claim quantified accuracy superiority over Options A or B; the value is the measurement surface + graceful degradation, not a sourced accuracy delta. |
| **Regulatory posture (HIPAA)** | Same as Option A (Anthropic BAA). |
| **Regulatory posture (FDA)** | Same as Option A (Quality System), plus dual-classifier audit-row complexity. |
| **Regulatory posture (GDPR)** | Same as Option A. |
| **Latency budget** | Same as Option A (regex runs in parallel; doesn't reduce wall-clock). |
| **Cost order-of-magnitude (recurring)** | **Same Claude per-call cost as Option A** (one Claude call per detection; regex runs in parallel locally with no API cost) + ongoing regex maintenance burden. Per SI-014 §3 Option C: "Same as Option A + maintenance of the regex floor." Pilot scale ≈ Option A's $45–90/quarter + regex maintenance time; full scale ≈ Option A's $73–146k/year + regex maintenance time. The "2× Option A" framing some earlier drafts used was unsourced — the source explicitly says one Claude call, parallel to regex. |
| **Failure mode** | **Graceful degradation.** If Claude is down, the regex floor still detects EN crisis content (Twi + paraphrase coverage is lost during the outage but EN crisis is preserved). Side-by-side classifier-accuracy measurement is built in. |
| **Engineering complexity** | MEDIUM — ~250 LOC (Option A scope + parallel-execution combiner + per-classifier audit-detail capture). |
| **Time to launch-ready** | Same as Option A (2-4 weeks). |

### Option D — Defer pilot launch on Mode 1 chat surface until classifier ratifies

**Mechanism.** Mark Mode 1 chat as "internal alpha only" (clinician-test tenant only; no patient access) until one of Options A/B/C ratifies. The Telecheck-Ghana pilot proceeds with chronic-care management surfaces (forms, async-consult, prescription/refill — all unblocked by sub-ceremony 1 SI-007 + SI-012 ratification) but **Mode 1 chat is gated off for patients**.

| Dimension | Value |
| --- | --- |
| **Clinical efficacy** | N/A — classifier doesn't deploy. **Zero clinical-safety risk from stub-coverage gaps.** |
| **Regulatory posture** | Bypasses FDA Quality System overhead at v1.0 (no clinical-decision-supporting AI in patient-facing surface). |
| **Latency budget** | N/A. |
| **Cost order-of-magnitude** | Zero technical cost. |
| **Opportunity cost** | **Significant.** Mode 1 chat is the marquee feature per Master PRD v1.10 §17 + patient acquisition + engagement projections. Delays engagement KPIs and the WHO/UN partnership Mode 1 demo gate (per ADR-028 some scopings). |
| **Time to launch-ready** | Chronic-care pilot launches on the originally-planned timeline (post-PR-A2/A3 of sub-ceremony 1 closing); Mode 1 chat patient access deferred ≥60-90 days minimum (≥6-12 months under Option B as the eventual classifier choice). |
| **Engineering complexity** | LOW — patient-access gate (likely a feature-flag check in the Mode 1 chat handler that 403s on patient role) + the SI-014.1-dependent governance block on gate-removal. |
| **SI-014 closure semantics** | **Option D is a DEFERRAL posture, NOT a closure posture.** SI-014 itself REMAINS OPEN under Option D — rescoped from "open / awaiting classifier choice" to "open / deferred behind patient-access gate; classifier choice rescoped to successor SI-014.1." Per SI-014 §5 R3 H1 closure 2026-05-16. |

---

## Hard rules constraining ANY chosen implementation

Per SI-014 §4 (verified across 5 Codex review rounds; immutable requirements):

| # | Rule | Applies to |
| --- | --- | --- |
| **1** | **Always-on.** No config flag or feature toggle can disable detection. The existing `CrisisDetector` constructor's `arguments.length > 0` fail-closed gate must be preserved. Any classifier passed via injection MUST be a non-nullable parameter. | A / B / C (D doesn't deploy classifier) |
| **2** | **Failure mode is fail-CLOSED scoped by coverage class.** ADR-030 MUST document whether the chosen impl uses **(a)+(b) split** (in-coverage → regex fallback; out-of-coverage → typed `CrisisClassifierUnavailableError` → 503) OR **(c) uniform hard-fail** (every classifier failure → 503 regardless of language). The naïve "fall through to regex; return no-crisis if regex misses" posture is a SAFETY REGRESSION and is REJECTED. | A / B / C |
| **3** | **PHI handling encoded in INVARIANTS §I-022.** Under Closure path A (Options A/B/C ship classifier), the downstream impl MUST update §I-022 with an explicit row for "crisis-detection classifier" naming the deployment location (Anthropic API per existing BAA / AWS VPC per ADR-024 / hybrid). Any subsequent change of classifier is a new SI. **Under Closure path B (Option D defers):** ZERO §I-022 amendment ships. | A / B / C only (NOT D) |
| **4** | **Latency budget is platform-floor.** Crisis gate's wall-clock ≤500ms P95 (per Master PRD v1.10 §13.5 SLA). The downstream impl MUST include a budget regression test (sub-500ms P95 at realistic input-size distribution). Any classifier exceeding 500ms P95 cannot ship even if accuracy is superior. | A / B / C |
| **5** | **Audit detail captures classifier provenance on TWO audit surfaces** (Cat A `crisis_detection_trigger` extension + NEW Cat B `crisis.classifier_invocation` always-emitted surface). Cat B has fail-soft emission policy (logs at ERROR; does NOT 503 because the safety surface already executed). **Under Closure path B (Option D defers):** ZERO AUDIT_EVENTS amendments ship. | A / B / C only (NOT D) |
| **6** | **Multi-language coverage at first launch.** A classifier upgrade that ships EN-only is NOT closure of SI-014 — it perpetuates the silent-miss exposure for Ghana patients (the very tenant SI-014 is most-needed for). If the chosen option cannot ship multi-language at launch, SI-014 does NOT close — it stays open and the Ghana pilot stays on Option D (chat gated off) until multi-language ships. | A / B / C (Option A satisfies natively; Option B requires per-language training; Option C inherits A's multi-language) |

**Note on Rule 6 + Option B interaction:** Option B's $50–$200k + 6-12 month per-language training requirement means selecting Option B is effectively selecting Option D for the Ghana pilot until the Twi DistilBERT ships. The quorum should consider this as a **hybrid Option B+D path**: chronic-care launches now; Mode 1 chat patient access waits for Twi-trained classifier. Note that no part of this brief asserts the per-language training cost or duration as exact — these are SI-014 §3 order-of-magnitude estimates and the quorum should re-validate against current vendor/labeling-partner pricing.

---

## Decision matrix

| Quorum-priority dimension | Option A (Claude) | Option B (on-prem) | Option C (hybrid) | Option D (defer) |
| --- | :---: | :---: | :---: | :---: |
| **Multi-language at launch (Rule 6)** | ✅ Native | ❌ 6-12 mo Twi training | ✅ Via Claude leg | N/A — defers |
| **Time-to-launch** | ✅ 2-4 wk | ❌ 6-12 mo | ✅ 2-4 wk | ✅ chronic-care now; chat: ≥60-90 days |
| **Latency** | ⚠️ ~400ms P50; risk of exceeding 500ms P95 | ✅ <50ms P95 | ⚠️ Same as A (parallel) | N/A — defers |
| **PHI surface (HIPAA)** | ⚠️ External API (BAA) | ✅ VPC-internal | ⚠️ Same as A | ✅ N/A |
| **Recurring cost (pilot)** | ✅ ~$45-90/qtr | ⚠️ $2-8k/mo GPU + 0.5-1 FTE | ✅ Same as A + regex maintenance time | ✅ Zero |
| **Recurring cost (full scale)** | ⚠️ $73-146k/yr | ✅ Stable GPU lease + FTE | ⚠️ Same as A + regex maintenance time | ✅ Zero |
| **Engineering complexity** | ✅ ~150 LOC | ❌ ~400 LOC + infra + drift mgmt | ⚠️ ~250 LOC | ✅ Minimal (access gate) |
| **Graceful degradation under outage** | ⚠️ Requires Rule 2 (a)+(b) or (c) | ✅ Local; no external dep | ✅ Regex floor preserves EN crisis detection | N/A |
| **SI-014 closes at ratification** | ✅ Yes (Closure path A) | ✅ Yes (Closure path A) | ✅ Yes (Closure path A) | ❌ No — stays open per §5 (Closure path B) |
| **Mode 1 patient launch on pilot day-1** | ✅ Yes | ❌ No (Twi delay) | ✅ Yes | ❌ No (deferred) |
| **WHO/UN partnership Mode 1 demo gate** | ✅ Met | ⚠️ Met after Twi training | ✅ Met | ❌ Met after SI-014.1 |

---

## What ships per option (closure deliverables)

### Closure path A (Options A / B / C ratified — classifier ships)

Per SI-014 §5 Resolution path:

1. **ADR-030 authored + ratified** with the chosen option + Rule 2 fail-closed posture (a+b split OR c uniform) + Tier 2 cadence + ratifier sign-off process
2. **AUDIT_EVENTS amendment** (two surfaces per Rule 5): Cat A `crisis_detection_trigger` detail extension + NEW Cat B `crisis.classifier_invocation` action ID with fail-soft emission policy
3. **INVARIANTS §I-022 amendment** (per Rule 3) — new row for "crisis-detection classifier" naming deployment location
4. **Implementation** scoped by option:
   - **Option A or C (Claude):** AI-RESIL-001 adapter wiring per ADR-020 + Rule 2 fail-closed posture impl + Cat A + Cat B audit emission ~150 LOC + 1 new module
   - **Option B (on-prem):** model service deployment + latency-floor regression test + model-drift monitoring dashboard ~400 LOC + infra
   - **Option C (hybrid):** Option A scope + parallel-execution combiner + per-classifier audit-detail capture ~250 LOC
5. **Regression tests:**
   - Sub-500ms P95 budget test at realistic input distribution (per Rule 4)
   - Fail-closed posture test (classifier outage scenario for each coverage class)
   - Multi-language test (per Rule 6 — coverage of at least EN + Twi for Telecheck-Ghana pilot)
6. **SI-014 closes** at Promotion Ledger entry (target P-022 alongside the other queued SIs, or earlier slot if Evans batches it)

### Closure path B (Option D ratified — classifier DEFERRED; SI-014 stays open)

Per SI-014 §5 R3 H1 closure:

1. **ADR-030 authored + ratified** as "Crisis-detection classifier — deferred for Mode 1 v1.0" with the patient-access gate design + the SI-014.1-dependent governance block on gate-removal
2. **Mode 1 chat patient-access gate** implemented (feature-flag check in handler; 403s on patient role; clinician-test tenant access preserved for internal validation)
3. **SI-014.1 filed** as the successor SI for the eventual classifier choice (Options A/B/C re-presented when ratifier is ready)
4. **Governance block** on Mode 1 patient-access re-enable: requires SI-014.1 ratification PLUS the three SI-014 §5 conditions (a)+(b)+(c) maintained while Option D is in force
5. **Phase B I-019 verification** marked CONDITIONALLY SATISFIED in the Master Completion Plan tracker while the three conditions hold
6. **ZERO AUDIT_EVENTS / INVARIANTS / impl deliverables ship under path B** (per Rule 3 + Rule 5 closure-path-B carve-outs)

---

## Quorum decision checklist (one page; sign-off surface)

**Step 1: each quorum member reviews this brief + SI-014 source file end-to-end.**

**Step 2: convene synchronously (recommended; the 4-axis tradeoff requires real-time discussion across clinical-safety + engineering + AI safety dimensions).**

**Step 3: each quorum member signs off on:**

- [ ] Selected option: **A** / **B** / **C** / **D**
- [ ] If A/B/C: Rule 2 fail-closed posture — **(a)+(b) split** / **(c) uniform**
- [ ] If A/B/C: Coverage envelope explicitly documented (which language-set + which paraphrase-class the regex floor is approved to back-stop under posture (a))
- [ ] If A/B/C: Tier 2 cadence (how often is classifier accuracy reviewed; who reviews; what triggers a re-evaluation)
- [ ] If A/B/C: ratifier sign-off process for future classifier swaps (any change is a new SI)
- [ ] If D: SI-014.1 filing committed (the successor SI; who authors; when)
- [ ] If D: patient-access gate design approved (feature-flag check spec)
- [ ] If D: governance block on gate-removal approved (the three conditions enforcement spec)
- [ ] Rule 6 multi-language plan acknowledged (which languages ship at launch; per Option A/C this is Claude-native; per Option B this is the per-language training plan)

**Step 4: Engineering authors ADR-030 v1.0 reflecting the quorum's decision; routes through standard ADR ratification flow (Codex pre-ratification gate + Promotion Ledger entry).**

**Step 5: SI-014 closes (Path A) OR is rescoped (Path B) per the chosen closure path.**

---

## What this brief is NOT

- **Not a recommendation.** The quorum chooses; this brief surfaces tradeoffs.
- **Not a Spec Issue.** SI-014 is the source; this brief is decision input.
- **Not authorization to implement any option.** No code work begins until ADR-030 ratifies + SI-014 closes (path A) or rescopes (path B).
- **Not a substitute for reading SI-014.** The source file has the full Codex-closure trajectory + the cross-cutting impact analysis + the closure semantics deep dive. This brief condenses for quorum-decision input; it does not replace the source.

---

## Cross-references

- **SI-014 source:** `docs/SI-014-Crisis-Detection-Clinical-NLP-Classifier.md` (277 lines; full Codex closure trajectory + cross-cutting impact analysis)
- **Master Completion Plan v1.0** §"Hard sequencing rules" — Phase B I-019 verification gate
- **Master PRD v1.10** §16 — Mode 1 chat surface description
- **Master PRD v1.10** §17 — patient acquisition + engagement KPI projections (impacted by Option D)
- **Master PRD v1.10** §13.5 — SLA table including the 500ms P95 crisis-gate budget
- **ADR-020** — multi-provider AI abstraction (Option A/C use this)
- **ADR-024** — country-driven config + Anthropic BAA reference
- **ADR-026** — AWS us-east-1 primary + us-west-2 cold DR (Option B deployment target)
- **ADR-028** — WHO/UN partnership Posture A (Mode 1 demo gate dependency)
- **INVARIANTS §I-019** — crisis detection always-on platform-floor
- **INVARIANTS §I-022** — PHI processing posture (amended by Closure path A only)
- **AUDIT_EVENTS** — Cat A + new Cat B amendments per Rule 5 (path A only)
- **WORKLOAD_TAXONOMY v5.2** — classifier classification (where the crisis-detection workload lives in the taxonomy)
- **PR #160** — Mode 1 chat handler (where the crisis gate fires)
- **PR #163** — Mode 1 audit-failure injection harness (precedent for fail-soft Cat B emission)
- **PR #164** — SI-013 CCR crisis-helpline keys (precedent for the classifier-provenance audit pattern)

---

— Claude (Opus 4.7, 1M context), 2026-05-17 ADR-030 Decision Brief authored at the post-sub-ceremony-1-ratification milestone per Evans's 2026-05-17 directive ("Author an ADR-030 Decision Brief surfacing the 4 options + tradeoffs ... clinical decision itself remains 100% with the quorum"). This brief does NOT pre-commit to any classifier choice.
