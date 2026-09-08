/**
 * pii-screener/backup-redaction.ts — Layer 5 backup redaction (Sprint 1.2c).
 *
 * Layer 5 is the last line of defense on the DURABLE-STORAGE path: a
 * `pg_dump` is piped through this pass before it reaches disk, so a backup
 * that is ever shared for troubleshooting is clean.
 *
 * ## Why this is not `redactString`
 *
 * Layer 3 (`redactString`) deliberately scrubs only the `redactInLogs`
 * subset of the library — IP addresses, for instance, are operational
 * signal in a log line. A backup has no such carve-out: the spec's success
 * metric for Layer 5 is 100% recall against the WHOLE regex library on an
 * adversarial pg_dump pass. So this pass runs every pattern, with the same
 * `validate` hook (Luhn, context binding) and the same token as Layer 3,
 * and it is regex-only — Layer 3 is ratified regex-only, and the local NER
 * decision is still unratified, so NER is not on this path either.
 *
 * ## Fidelity
 *
 * Numeric fidelity is NOT preserved: a 10-digit id column that matches the
 * phone pattern is redacted. The spec accepts that ("degrades Pilot 1
 * backup fidelity slightly") because Pilot 1 holds no PHI worth preserving
 * faithfully. A restore from a redacted dump is a diagnostic aid, never a
 * recovery path.
 */

import { redactionToken } from './log-redaction.js';
import { PII_PATTERNS } from './patterns.js';

/** Redact every library pattern in `value` (whole library, validate-gated). */
export function redactForBackup(value: string): string {
  let out = value;
  for (const pattern of PII_PATTERNS) {
    const re = new RegExp(pattern.regex.source, pattern.regex.flags);
    out = out.replace(re, (match) => {
      if (pattern.validate && !pattern.validate(match)) return match;
      return redactionToken(pattern.label);
    });
  }
  return out;
}

/** Pattern ids this pass covers — the whole library, by construction. */
export function backupRedactionPatternIds(): readonly string[] {
  return PII_PATTERNS.map((p) => p.id);
}
