/**
 * ccr-keys.ts — canonical CCR key namespace per Contracts Pack v5.2
 * CCR_RUNTIME contract.
 *
 * Cross-module callers should use these constants instead of hardcoded
 * string literals. A typo in `resolveCcrKey(ctx, 'notification.sms_pvider')`
 * would silently return null (key not configured); routing through these
 * constants gives compile-time validation.
 *
 * Keys are dotted-namespace strings: `<domain>.<setting>`. Domains are
 * stable; new settings within a domain are added as new constants here
 * without touching the existing surface.
 *
 * Spec references:
 *   - Contracts Pack v5.2 CCR_RUNTIME (canonical key namespace)
 *   - CDM v1.2 §4.4 (CCRConfig.config_key column)
 *   - I-009 (CCR resolution is the only path to country/tenant-scoped config)
 */

/**
 * Canonical CCR key constants. The string values MUST match the
 * `ccr_configs.config_key` values used in production overrides AND any
 * keys ratified in the CCR_RUNTIME contract. Keep alphabetized within
 * domain for readability.
 */
export const CCR_KEYS = {
  // Notification domain
  NOTIFICATION_SMS_PROVIDER: 'notification.sms_provider',
  NOTIFICATION_QUIET_HOURS_OVERRIDE: 'notification.quiet_hours_override',

  // Payment domain
  PAYMENT_PROCESSOR: 'payment.processor',
  PAYMENT_PROCESSOR_OVERRIDE: 'payment.processor_override',

  // Pharmacy domain
  PHARMACY_ROUTING_STRATEGY: 'pharmacy.routing_strategy',
  PHARMACY_PRIMARY_ADAPTER: 'pharmacy.primary_adapter',

  // Clinician network domain
  CLINICIAN_NETWORK_PRIMARY_ADAPTER: 'clinician_network.primary_adapter',

  // Lab domain
  LAB_PRIMARY_ADAPTER: 'lab.primary_adapter',

  // Video domain
  VIDEO_PROVIDER: 'video.provider',
} as const;

/**
 * Type alias for the canonical CCR key string-literal union. Use in
 * downstream-slice signatures to pin acceptable keys at compile time.
 */
export type CcrKey = (typeof CCR_KEYS)[keyof typeof CCR_KEYS];
