/**
 * Forms-Intake publish-gates bypass kill-switch (SI-011 cross-cutting
 * production safety, defense-in-depth layer 1 + 2).
 *
 * Background: `templateService.publishVersion()` currently fails closed
 * via the `FORMS_PUBLISH_GATES_BYPASS='unsafe-test-only'` sentinel.
 * Setting that env var bypasses all four governance gates (I-015 L3
 * dual-control, I-030 six-category analysis, L4 MarketingCopy approval,
 * Mode 2 input contract). Per SI-011 the bypass is intentionally
 * hostile-named so a routine env-config typo can't accidentally open
 * the gate — but env-config drift remains a credible production threat
 * (copy-pasted test envs, mis-set NODE_ENV, post-boot dynamic config
 * injection by a sidecar).
 *
 * SI-011 specifies a four-layer defense-in-depth kill-switch:
 *
 *   1. APP STARTUP GUARD — Fastify boot hook reads `process.env` and
 *      fails fast (process exits non-zero, listener never binds) if
 *      ANY of the bypass / per-gate-test-override env vars are
 *      present in any environment where `NODE_ENV !== 'test'`. Glob
 *      match on the `FORMS_PUBLISH_GATES_TEST_OVERRIDE_*` prefix
 *      (deny-list, not allow-list) — so a future per-gate var added
 *      without updating this file still fails closed.
 *
 *   2. publishVersion() RE-CHECK — defense-in-depth: the publish path
 *      itself re-checks before doing any work. Catches the case
 *      where the startup guard was somehow bypassed (env var
 *      injected post-boot, dynamic config reload, hot-patched).
 *      Emits `forms.publish.bypass_attempt_in_production` Category B
 *      audit on detection (audit emission is wired in template-service
 *      where the actor + tenant context are available; this module
 *      exposes the predicate).
 *
 *   3. CI STATIC CHECK — separate piece of work (CI workflow); not
 *      in this module's responsibility.
 *
 *   4. DEPLOY SMOKE VALIDATION — separate piece of work (deploy
 *      runbook); not in this module's responsibility.
 *
 * This module implements layers 1 and 2.
 *
 * Spec reference: docs/SI-011-Forms-Publish-Governance-Gates.md
 * §"Production environment guard (kill-switch)".
 */

/**
 * The full set of env vars whose presence in `NODE_ENV !== 'test'` is
 * categorically forbidden. The all-gates bypass plus the four per-gate
 * test overrides specified in SI-011's resolution path §4.
 *
 * Per SI-011: "Glob-match the prefix (deny-list), not an allow-list" —
 * we also check for any env var whose name starts with
 * `FORMS_PUBLISH_GATES_TEST_OVERRIDE_` so future per-gate vars added
 * without updating this constant still fail closed.
 */
export const FORBIDDEN_PUBLISH_GATE_BYPASS_VARS = [
  'FORMS_PUBLISH_GATES_BYPASS',
  'FORMS_PUBLISH_GATES_TEST_OVERRIDE_L3_DUAL_CONTROL',
  'FORMS_PUBLISH_GATES_TEST_OVERRIDE_I030_ANALYSIS',
  'FORMS_PUBLISH_GATES_TEST_OVERRIDE_MARKETING_COPY',
  'FORMS_PUBLISH_GATES_TEST_OVERRIDE_MODE_2_CONTRACT',
] as const;

/**
 * Prefix the deny-list glob matches against. Any env var whose name
 * starts with this prefix is treated as a forbidden bypass var even if
 * it isn't enumerated in `FORBIDDEN_PUBLISH_GATE_BYPASS_VARS`.
 */
export const FORBIDDEN_PUBLISH_GATE_BYPASS_PREFIX = 'FORMS_PUBLISH_GATES_TEST_OVERRIDE_';

/**
 * The sentinel string used in error messages when the boot-hook detects
 * a forbidden env var in a non-test environment. Stable for log/alert
 * tooling to grep for.
 */
export const PUBLISH_GATES_BYPASS_IN_PRODUCTION = 'forms.publish.bypass_in_production';

/**
 * Result of scanning `env` for forbidden publish-gate bypass vars.
 * Mode: 'allowed' when `NODE_ENV === 'test'` OR no forbidden var present;
 * 'forbidden' when at least one var is present in a non-test env.
 */
export type PublishGateBypassScanResult =
  | { mode: 'allowed' }
  | {
      mode: 'forbidden';
      nodeEnv: string | undefined;
      forbiddenVars: ReadonlyArray<string>;
    };

/**
 * Scan a process-env-shaped object for the presence of any
 * publish-gates-bypass env var when `NODE_ENV !== 'test'`. Pure
 * function — takes the env as a parameter so callers can pass a
 * snapshot (production boot) or a fixture (tests). Does not throw,
 * does not read `process.env` directly.
 *
 * Detection rules (per SI-011 §"Production environment guard"):
 *   - If `NODE_ENV === 'test'`, ANY override may be present. The
 *     production guard does not fire in tests.
 *   - In any other env (or when NODE_ENV is unset / empty), the
 *     presence of any enumerated forbidden var OR any var matching
 *     the `FORMS_PUBLISH_GATES_TEST_OVERRIDE_` prefix is a forbidden
 *     condition. The actual VALUE is irrelevant — empty-string,
 *     'false', 'unsafe-test-only', anything — presence alone fails
 *     closed. This matches SI-011's "Glob-match the prefix
 *     (deny-list), not an allow-list" requirement.
 */
export function scanPublishGateBypassEnv(env: NodeJS.ProcessEnv): PublishGateBypassScanResult {
  const nodeEnv = env['NODE_ENV'];
  if (nodeEnv === 'test') {
    return { mode: 'allowed' };
  }

  const forbidden: string[] = [];
  // Enumerated names — guarantees we always detect the canonical four
  // even if the prefix is renamed in some future migration.
  for (const name of FORBIDDEN_PUBLISH_GATE_BYPASS_VARS) {
    if (Object.prototype.hasOwnProperty.call(env, name)) {
      forbidden.push(name);
    }
  }
  // Prefix glob — catches future per-gate overrides added without
  // updating the enumerated list.
  for (const name of Object.keys(env)) {
    if (name.startsWith(FORBIDDEN_PUBLISH_GATE_BYPASS_PREFIX) && !forbidden.includes(name)) {
      forbidden.push(name);
    }
  }

  if (forbidden.length === 0) {
    return { mode: 'allowed' };
  }

  return {
    mode: 'forbidden',
    nodeEnv,
    // Sort for deterministic test/log output.
    forbiddenVars: [...forbidden].sort(),
  };
}

/**
 * Boot-time assertion. Called from `buildApp()` BEFORE any plugin is
 * registered — if it throws, the Fastify instance is never constructed
 * and the listener never binds.
 *
 * The thrown Error carries `PUBLISH_GATES_BYPASS_IN_PRODUCTION` as its
 * message so operational tooling can grep boot logs for the canonical
 * code. The thrown error also names the specific forbidden vars
 * detected so a quick remediation is possible without reading source.
 */
export function assertNoPublishGateBypassAtBoot(env: NodeJS.ProcessEnv): void {
  const result = scanPublishGateBypassEnv(env);
  if (result.mode === 'forbidden') {
    const details =
      `NODE_ENV=${result.nodeEnv ?? '(unset)'}; ` +
      `forbidden vars present: ${result.forbiddenVars.join(', ')}`;
    throw new Error(`${PUBLISH_GATES_BYPASS_IN_PRODUCTION}: ${details}`);
  }
}

/**
 * Publish-path runtime check. Called from the publish HTTP handler
 * AFTER tenant context is resolved, BEFORE any publish-related DB
 * write or idempotency reservation. Returns the scan result so the
 * caller can emit a Category B audit naming the exact forbidden vars
 * detected and then throw the canonical sentinel error.
 *
 * This is layer 2b of the four-layer defense — catches the case where
 * the boot-time guard (layer 1) and the early-request guard (layer 2a)
 * both failed to fire. Practically belt-and-suspenders.
 */
export function checkPublishGateBypassAtRuntime(
  env: NodeJS.ProcessEnv,
): PublishGateBypassScanResult {
  return scanPublishGateBypassEnv(env);
}

/**
 * Regex matching the publish HTTP route — used by the layer-2a Fastify
 * onRequest hook to scope the kill-switch to publish requests only.
 *
 * Route shape: `/v0/forms/templates/:templateId/versions/:versionId/publish`
 *
 * The regex deliberately accepts any non-empty ULID-shaped segment in the
 * `:templateId` and `:versionId` slots — we don't validate identifiers
 * here, just match the URL pattern. The pattern allows an optional
 * query string and trailing slash.
 */
export const PUBLISH_ROUTE_URL_PATTERN =
  /^\/v0\/forms\/templates\/[^/]+\/versions\/[^/]+\/publish\/?(\?.*)?$/i;

/**
 * Returns true if the given URL targets the forms publish route.
 *
 * Used by the layer-2a Fastify onRequest hook to short-circuit publish
 * requests when a forbidden bypass env var is present, BEFORE the
 * tenant-context plugin performs any DB resolution.
 */
export function isPublishRouteUrl(url: string): boolean {
  return PUBLISH_ROUTE_URL_PATTERN.test(url);
}
