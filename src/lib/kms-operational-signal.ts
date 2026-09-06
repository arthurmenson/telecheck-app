import { logger } from './logger.js';

/** One process-level signal per minute; no request/error/tenant data is accepted. */
export function createKmsAuditUnavailableSignal(report: () => void, now = () => performance.now()) {
  let next = -Infinity;
  return () => {
    const timestamp = now();
    if (timestamp < next) return;
    next = timestamp + 60_000;
    // Logging must not change the generic public failure or bypass cleanup.
    try {
      report();
    } catch {
      /* No recursive logging/audit on this path. */
    }
  };
}
export const signalKmsAuditUnavailable = createKmsAuditUnavailableSignal(() => {
  logger.error({ event: 'kms.audit.unavailable' }, 'Tenant encryption audit unavailable');
});
