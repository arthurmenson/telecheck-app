/**
 * I-019 Crisis detection cannot be configured away — platform-floor tests.
 *
 * Invariant under test: I-019 (Crisis detection cannot be configured away).
 *
 * Spec references:
 *   - I-019: "Crisis detection (suicidal ideation, self-harm, abuse disclosure,
 *             medical emergency indicators) is always active across all platform
 *             surfaces — AI chat, community, forms, messaging. No guardrail
 *             template, moderation policy, or admin configuration can disable
 *             crisis detection."
 *   - CLAUDE.md §Hard rules: "Crisis detection is platform-floor. Never disable,
 *             never gate behind config. Active in chat, voice (future), community."
 *   - Tenant Threading Addendum v1.0 §3.1:
 *             "Crisis detection guardrails per I-019 are platform-scoped and cannot
 *              be weakened by any tenant."
 *
 * Test scenarios:
 *   1. Crisis detection config cannot have disabled=true.
 *   2. Crisis detection config cannot have enabled=false.
 *   3. Crisis detection config cannot be tenant-overrideable.
 *   4. Crisis detection module exports a function that is always active
 *      (regardless of environment or config input).
 *   5. Guardrail template with disable_crisis_detection: true is rejected.
 *   6. Moderation policy config with crisis_detection_enabled: false is rejected.
 *
 * DEPENDS ON:
 *   - tests/helpers/invariant-assertions.ts (assertI019CrisisDetection)
 *   - src/lib/crisis-detection.ts (CrisisDetectionConfig, isCrisisDetectionActive —
 *     written by appsec-expert agent; tests document expected interface)
 */

import { describe, expect, it } from 'vitest';
import { assertInvariants } from '../helpers/invariant-assertions.ts';

// DEPENDS ON: src/lib/crisis-detection.ts (appsec-expert agent).
// import { isCrisisDetectionActive, type CrisisDetectionConfig } from '../../src/lib/crisis-detection.ts';

// ---------------------------------------------------------------------------
// Stub types for crisis-detection module interface (to be replaced with import)
// ---------------------------------------------------------------------------

// TODO: remove stub and uncomment import once src/lib/crisis-detection.ts lands.
interface CrisisDetectionConfig {
  disabled?: boolean;
  enabled?: boolean;
  tenantOverrideable?: boolean;
  guardrailTemplate?: {
    disable_crisis_detection?: boolean;
  };
  moderationPolicy?: {
    crisis_detection_enabled?: boolean;
  };
}

// Stub: real function verifies the module is structurally non-disableable.
// The actual implementation in src/lib/crisis-detection.ts must throw if
// any config path attempts to disable detection.
function isCrisisDetectionActiveStub(cfg: CrisisDetectionConfig): boolean {
  if (cfg.disabled === true) {
    throw new Error(
      'I-019 VIOLATION: crisis detection cannot be disabled via config (disabled=true)',
    );
  }
  if (cfg.enabled === false) {
    throw new Error(
      'I-019 VIOLATION: crisis detection cannot be disabled via config (enabled=false)',
    );
  }
  if (cfg.tenantOverrideable === true) {
    throw new Error(
      'I-019 VIOLATION: crisis detection cannot be made tenant-overrideable',
    );
  }
  if (cfg.guardrailTemplate?.disable_crisis_detection === true) {
    throw new Error(
      'I-019 VIOLATION: guardrail template cannot disable crisis detection',
    );
  }
  if (cfg.moderationPolicy?.crisis_detection_enabled === false) {
    throw new Error(
      'I-019 VIOLATION: moderation policy cannot disable crisis detection (crisis_detection_enabled=false)',
    );
  }
  return true; // Always active.
}

// ---------------------------------------------------------------------------
// Scenario 1 + 2: Config cannot disable crisis detection
// ---------------------------------------------------------------------------

describe('I-019 — crisis detection config: disabled=true and enabled=false both rejected', () => {
  it('should throw when crisis detection config has disabled=true', () => {
    const cfg: CrisisDetectionConfig = { disabled: true };

    expect(() => isCrisisDetectionActiveStub(cfg)).toThrow(/I-019 VIOLATION/);

    // assertI019CrisisDetection should also catch this.
    expect(() => assertInvariants(['I-019'], { crisisConfig: cfg })).toThrow(/I-019 VIOLATION/);
  });

  it('should throw when crisis detection config has enabled=false', () => {
    const cfg: CrisisDetectionConfig = { enabled: false };

    expect(() => isCrisisDetectionActiveStub(cfg)).toThrow(/I-019 VIOLATION/);
    expect(() => assertInvariants(['I-019'], { crisisConfig: cfg })).toThrow(/I-019 VIOLATION/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Config cannot be tenant-overrideable
// ---------------------------------------------------------------------------

describe('I-019 — tenant override: crisis detection cannot be weakened per tenant', () => {
  it('should throw when crisis detection config allows tenant override', () => {
    const cfg: CrisisDetectionConfig = { tenantOverrideable: true };

    expect(() => isCrisisDetectionActiveStub(cfg)).toThrow(/I-019 VIOLATION/);
    expect(() => assertInvariants(['I-019'], { crisisConfig: cfg })).toThrow(/I-019 VIOLATION/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Module is always active
// ---------------------------------------------------------------------------

describe('I-019 — module always active regardless of config input', () => {
  it('should return true (active) for an empty config', () => {
    const cfg: CrisisDetectionConfig = {};
    expect(isCrisisDetectionActiveStub(cfg)).toBe(true);
    expect(() => assertInvariants(['I-019'], { crisisConfig: cfg })).not.toThrow();
  });

  it('should return true (active) for a config with unrelated fields', () => {
    const cfg = { logLevel: 'info', marketCode: 'US' };
    expect(() => assertInvariants(['I-019'], { crisisConfig: cfg })).not.toThrow();
  });

  it.todo(
    'should verify src/lib/crisis-detection.ts exports isCrisisDetectionActive() that ' +
      'ignores all config inputs and always returns true (blocked on appsec-expert agent)',
  );

  it.todo(
    'should verify crisis detection fires for "I want to hurt myself" test prompt across ' +
      'Mode 1 conversational surface (blocked on src/lib/crisis-detection.ts + ' +
      'Mode 1 conversation handler — appsec-expert agent)',
  );
});

// ---------------------------------------------------------------------------
// Scenario 5: Guardrail template cannot disable crisis detection
// ---------------------------------------------------------------------------

describe('I-019 — guardrail template: disable_crisis_detection field rejected', () => {
  it('should throw when guardrail template has disable_crisis_detection=true', () => {
    const cfg: CrisisDetectionConfig = {
      guardrailTemplate: { disable_crisis_detection: true },
    };
    expect(() => isCrisisDetectionActiveStub(cfg)).toThrow(/I-019 VIOLATION/);
  });

  it('should accept a guardrail template that does not touch crisis detection', () => {
    const cfg: CrisisDetectionConfig = {
      guardrailTemplate: {}, // no disable_crisis_detection key
    };
    expect(isCrisisDetectionActiveStub(cfg)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Moderation policy cannot disable crisis detection
// ---------------------------------------------------------------------------

describe('I-019 — moderation policy: crisis_detection_enabled=false rejected', () => {
  it('should throw when moderation policy has crisis_detection_enabled=false', () => {
    const cfg: CrisisDetectionConfig = {
      moderationPolicy: { crisis_detection_enabled: false },
    };
    expect(() => isCrisisDetectionActiveStub(cfg)).toThrow(/I-019 VIOLATION/);
  });

  it('should accept a moderation policy that does not set crisis_detection_enabled=false', () => {
    const cfg: CrisisDetectionConfig = {
      moderationPolicy: { crisis_detection_enabled: true },
    };
    expect(isCrisisDetectionActiveStub(cfg)).toBe(true);
  });
});
