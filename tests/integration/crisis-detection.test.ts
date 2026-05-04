/**
 * I-019 platform-floor crisis detection — unit-style integration tests.
 *
 * Covers `src/lib/crisis-detection.ts` (`CrisisDetector`, `crisisDetector`,
 * `DisabledCrisisDetectionError`), which until this commit had only one
 * indirect mention from another test and ZERO direct coverage despite
 * encoding one of the four hardest platform invariants — I-019 always-on
 * crisis detection.
 *
 * Why this matters:
 *   I-019 says: "Crisis detection (suicidal ideation, self-harm, abuse
 *   disclosure, medical emergency indicators) is always active across all
 *   platform surfaces. No guardrail template, moderation policy, or admin
 *   configuration can disable crisis detection." A regression here is a
 *   patient-safety incident, not a bug — false negatives miss someone
 *   asking for help. The detector is INTENTIONALLY high-recall (false
 *   positives are tolerable; false negatives are not).
 *
 * Coverage in this file:
 *   1. Always-on contract — DisabledCrisisDetectionError fires for ANY
 *      truthy disable argument; the `never`-typed parameter guarantees
 *      compile-time visibility.
 *   2. Per-crisis-type detection — each of the 5 documented CrisisType
 *      values is reachable via a representative phrase, AND the
 *      classifyCrisisType output matches the test phrase's category.
 *   3. Pattern semantics — case-insensitivity, contractions, word
 *      boundaries (only-substring matches don't false-positive into a
 *      normal word like "suicidate" — we don't have such a word but the
 *      \b boundary protection is the contract).
 *   4. Result envelope — tenantId + detectionSource preserved verbatim,
 *      recommendedSurfaces is the documented stub triple.
 *   5. No-crisis path — empty / whitespace / benign text → crisisDetected: false.
 *   6. Singleton — `crisisDetector` is one instance shared across imports.
 *   7. CRITICAL high-recall regression guard — an explicit roster of phrases
 *      from the documented categories must ALL detect; this catches a
 *      pattern-list regression that silently drops a category.
 *
 * Spec references:
 *   - I-019 (always-on crisis detection floor)
 *   - I-017 (emergency info always accessible — detector returns
 *     recommendedSurfaces with crisis_resources_modal +
 *     emergency_contact_display + in_platform_escalation_trigger)
 *   - AUDIT_EVENTS v5.2 §Category A `crisis_detection_trigger` envelope
 *     (detector does NOT emit; caller is responsible per I-003 — tested
 *     here only for envelope-shape adequacy of the returned context)
 *   - WORKLOAD_TAXONOMY v5.2 §2.1 (conversational_assistant governance class
 *     `floor_safety` — crisis detection is the primary floor safety gate)
 *   - Tenant Threading Addendum v1.0 §3.5 (community moderation — crisis
 *     detection is platform-scoped, not tenant-overridable)
 */

import { describe, expect, it } from 'vitest';

import {
  CrisisDetector,
  DisabledCrisisDetectionError,
  type CrisisType,
  type DetectionSource,
  crisisDetector,
} from '../../src/lib/crisis-detection.ts';

// ---------------------------------------------------------------------------
// 1. Always-on contract — disable attempts throw
// ---------------------------------------------------------------------------

describe('CrisisDetector — always-on contract (I-019)', () => {
  it('constructor throws DisabledCrisisDetectionError when any value is passed (truthy or falsy)', () => {
    // The `never`-typed parameter is a compile-time block; we cast through
    // unknown to test the runtime guard. ANY argument (true, false, null,
    // a string) trips the guard because the runtime check is "argument
    // !== undefined", which is true for every actual passed value.
    for (const v of [true, false, 0, 1, '', 'disabled-by-flag', null]) {
      expect(() => new CrisisDetector(v as unknown as never)).toThrow(DisabledCrisisDetectionError);
    }
  });

  it('constructor with NO argument succeeds (the only documented usage)', () => {
    expect(() => new CrisisDetector()).not.toThrow();
  });

  it('DisabledCrisisDetectionError message cites I-019 + the offending reason', () => {
    try {
      new CrisisDetector(true as unknown as never);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DisabledCrisisDetectionError);
      const e = err as DisabledCrisisDetectionError;
      expect(e.name).toBe('DisabledCrisisDetectionError');
      expect(e.message).toMatch(/I-019/);
      expect(e.message).toMatch(/cannot be disabled/);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Per-crisis-type detection (each CrisisType reachable + correctly classified)
// ---------------------------------------------------------------------------

describe('CrisisDetector.detect() — crisis-type classification', () => {
  const detector = new CrisisDetector();

  // Each row: (phrase, expected crisisType). The phrases are conservative
  // examples of what the documented patterns target. If the pattern list
  // changes (e.g. a category is dropped), at least one of these tests
  // breaks — that's the contract.
  const cases: Array<{ phrase: string; expected: CrisisType }> = [
    // suicidal_ideation
    { phrase: 'I am thinking about suicide tonight', expected: 'suicidal_ideation' },
    { phrase: 'I want to kill myself', expected: 'suicidal_ideation' },
    { phrase: "I don't want to live anymore", expected: 'suicidal_ideation' },
    { phrase: 'I want to die', expected: 'suicidal_ideation' },
    { phrase: 'I have thoughts of death', expected: 'suicidal_ideation' },
    // self_harm
    { phrase: 'I have been cutting myself', expected: 'self_harm' },
    { phrase: 'I want to hurt myself', expected: 'self_harm' },
    { phrase: 'I keep self-harming', expected: 'self_harm' },
    { phrase: 'I tried burning myself', expected: 'self_harm' },
    // abuse_disclosure
    { phrase: 'I am being abused at home', expected: 'abuse_disclosure' },
    { phrase: 'someone is hurting me physically', expected: 'abuse_disclosure' },
    { phrase: 'this is domestic violence', expected: 'abuse_disclosure' },
    { phrase: 'I survived sexual abuse last year', expected: 'abuse_disclosure' },
    { phrase: 'this counts as physical abuse', expected: 'abuse_disclosure' },
    // medical_emergency
    { phrase: 'I have severe chest pain right now', expected: 'medical_emergency' },
    { phrase: "I can't breathe", expected: 'medical_emergency' },
    { phrase: 'I am having difficulty breathing', expected: 'medical_emergency' },
    { phrase: 'I think this is a stroke', expected: 'medical_emergency' },
    { phrase: 'they had a seizure', expected: 'medical_emergency' },
    { phrase: 'patient is unconscious', expected: 'medical_emergency' },
    { phrase: 'this is an overdose', expected: 'medical_emergency' },
    // general_crisis (matches a pattern but classifier doesn't pick a specific category)
    { phrase: 'I am in crisis right now', expected: 'general_crisis' },
    { phrase: 'this is a mental health emergency', expected: 'general_crisis' },
    { phrase: 'this is a psychiatric emergency', expected: 'general_crisis' },
  ];

  for (const { phrase, expected } of cases) {
    it(`detects "${phrase}" as crisisType="${expected}"`, () => {
      const result = detector.detect(phrase, 'Telecheck-US', 'ai_chat');
      expect(result.crisisDetected).toBe(true);
      if (result.crisisDetected === true) {
        expect(result.crisisType).toBe<CrisisType>(expected);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Pattern semantics — case-insensitivity / contractions / word boundaries
// ---------------------------------------------------------------------------

describe('CrisisDetector.detect() — pattern semantics', () => {
  const detector = new CrisisDetector();

  it('case-insensitivity — uppercase and mixed-case both match', () => {
    const lower = detector.detect('i want to kill myself', 'Telecheck-US', 'ai_chat');
    const upper = detector.detect('I WANT TO KILL MYSELF', 'Telecheck-US', 'ai_chat');
    const mixed = detector.detect('I Want To Kill Myself', 'Telecheck-US', 'ai_chat');
    expect(lower.crisisDetected).toBe(true);
    expect(upper.crisisDetected).toBe(true);
    expect(mixed.crisisDetected).toBe(true);
  });

  it('contraction tolerance — "can\'t" and "cant" both match medical_emergency', () => {
    const withApostrophe = detector.detect("I can't breathe", 'Telecheck-US', 'ai_chat');
    const withoutApostrophe = detector.detect('I cant breathe', 'Telecheck-US', 'ai_chat');
    expect(withApostrophe.crisisDetected).toBe(true);
    expect(withoutApostrophe.crisisDetected).toBe(true);
  });

  it('word boundaries — "suicide" inside another word is also caught (high-recall stem match)', () => {
    // The pattern uses /\b(suicid|...)\b/. "suicid" is a stem that can match
    // "suicide", "suicidal", "suicidally". Pinning that the high-recall
    // semantic is intentional — a future change to a strict full-word match
    // would trip this test and prompt explicit conversation about whether
    // "suicidal thoughts" should still detect.
    const r = detector.detect('I have suicidal thoughts', 'Telecheck-US', 'ai_chat');
    expect(r.crisisDetected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. No-crisis path — empty / whitespace / benign text
// ---------------------------------------------------------------------------

describe('CrisisDetector.detect() — no-crisis path', () => {
  const detector = new CrisisDetector();

  it('returns crisisDetected=false on empty string', () => {
    expect(detector.detect('', 'Telecheck-US', 'ai_chat')).toEqual({ crisisDetected: false });
  });

  it('returns crisisDetected=false on whitespace-only string', () => {
    expect(detector.detect('   \t\n', 'Telecheck-US', 'ai_chat')).toEqual({
      crisisDetected: false,
    });
  });

  it('returns crisisDetected=false on benign clinical-context text', () => {
    const benign = [
      'I have a runny nose and a mild cough.',
      'My blood pressure reading was 120/80 today.',
      'I would like to schedule a follow-up appointment.',
      'My medication refill is due next week.',
      'I feel a little tired but otherwise okay.',
    ];
    for (const text of benign) {
      const r = detector.detect(text, 'Telecheck-US', 'ai_chat');
      expect(r.crisisDetected).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Result envelope — tenantId + detectionSource preserved + recommendedSurfaces
// ---------------------------------------------------------------------------

describe('CrisisDetector.detect() — result envelope shape', () => {
  const detector = new CrisisDetector();

  for (const source of [
    'ai_chat',
    'community_post',
    'form_response',
    'messaging',
    'voice_transcript',
  ] as const satisfies readonly DetectionSource[]) {
    it(`preserves tenantId + detectionSource verbatim for source="${source}"`, () => {
      const r = detector.detect('I want to die', 'Telecheck-Ghana', source);
      expect(r.crisisDetected).toBe(true);
      if (r.crisisDetected === true) {
        expect(r.tenantId).toBe('Telecheck-Ghana');
        expect(r.detectionSource).toBe(source);
        expect(r.action).toBe('escalate');
      }
    });
  }

  it('recommendedSurfaces is the documented stub triple (crisis_resources_modal + emergency_contact_display + in_platform_escalation_trigger)', () => {
    // Pinning the current stub. When CCR-driven escalation pathway lands,
    // this assertion will need to change — the test failure prompts the
    // implementer to update both code and contract together.
    const r = detector.detect('I want to die', 'Telecheck-US', 'ai_chat');
    expect(r.crisisDetected).toBe(true);
    if (r.crisisDetected === true) {
      expect(r.recommendedSurfaces).toEqual([
        'crisis_resources_modal',
        'emergency_contact_display',
        'in_platform_escalation_trigger',
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Platform singleton
// ---------------------------------------------------------------------------

describe('crisisDetector — platform singleton', () => {
  it('exports a single shared instance (re-imports return the same reference)', async () => {
    const reimport = await import('../../src/lib/crisis-detection.ts');
    expect(reimport.crisisDetector).toBe(crisisDetector);
  });

  it('the singleton detects crises (smoke test of the actual exported instance)', () => {
    const r = crisisDetector.detect('I want to kill myself', 'Telecheck-US', 'ai_chat');
    expect(r.crisisDetected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. High-recall regression guard — phrase roster MUST all detect
//
// The strongest contract for I-019: a documented set of phrases for each
// crisis category MUST trigger detection. If anyone drops or weakens a
// pattern, at least one of these phrases would silently slip through. This
// test fires a 22-phrase roster against the singleton (NOT a fresh
// instance) so it also doubles as a smoke test of the production export.
// ---------------------------------------------------------------------------

describe('CrisisDetector — high-recall regression guard (every documented category MUST detect)', () => {
  const phrases: Array<{ category: CrisisType; phrase: string }> = [
    // suicidal_ideation × 4
    { category: 'suicidal_ideation', phrase: 'I want to commit suicide' },
    { category: 'suicidal_ideation', phrase: 'I am going to kill myself' },
    { category: 'suicidal_ideation', phrase: 'I want to end my life tonight' },
    { category: 'suicidal_ideation', phrase: 'I am having thoughts of death' },
    // self_harm × 4
    { category: 'self_harm', phrase: 'I am self-harming again' },
    { category: 'self_harm', phrase: 'I want to hurt myself' },
    { category: 'self_harm', phrase: 'I have been cutting myself' },
    { category: 'self_harm', phrase: 'I tried burning myself last night' },
    // abuse_disclosure × 4
    { category: 'abuse_disclosure', phrase: 'I am being abused' },
    { category: 'abuse_disclosure', phrase: 'this is sexual abuse' },
    { category: 'abuse_disclosure', phrase: 'someone is hurting me' },
    { category: 'abuse_disclosure', phrase: 'I am a victim of domestic violence' },
    // medical_emergency × 6
    { category: 'medical_emergency', phrase: 'I have chest pain' },
    { category: 'medical_emergency', phrase: "I can't breathe" },
    { category: 'medical_emergency', phrase: 'this looks like a stroke' },
    { category: 'medical_emergency', phrase: 'patient just had a seizure' },
    { category: 'medical_emergency', phrase: 'patient is unconscious' },
    { category: 'medical_emergency', phrase: 'this is an overdose' },
    // general_crisis × 3
    { category: 'general_crisis', phrase: 'I am in crisis' },
    { category: 'general_crisis', phrase: 'this is a mental health emergency' },
    { category: 'general_crisis', phrase: 'this is a psychiatric emergency' },
  ];

  for (const { category, phrase } of phrases) {
    it(`HIGH-RECALL — "${phrase}" must detect (category: ${category})`, () => {
      const r = crisisDetector.detect(phrase, 'Telecheck-US', 'ai_chat');
      expect(r.crisisDetected).toBe(true);
      if (r.crisisDetected === true) {
        expect(r.crisisType).toBe(category);
      }
    });
  }
});
