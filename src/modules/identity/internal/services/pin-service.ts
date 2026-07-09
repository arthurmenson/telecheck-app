/**
 * pin-service.ts — 6-digit-PIN credential hashing + verification with a
 * failed-attempt lockout, for the email+PIN auth path (migration 078;
 * docs/SI-EMAIL-PIN-AUTH.md).
 *
 * Security posture:
 *   - The PIN is a PERSISTENT credential over a small (1e6) space, so it is
 *     hashed with scrypt (a slow KDF) + a 16-byte per-credential random salt.
 *     A DB leak therefore costs a scrypt derivation per candidate PIN per row
 *     rather than a trivial reversal (contrast the SHA-256 OTP codes, which
 *     are short-lived + rate-limited).
 *   - Constant-time comparison of derived keys (timingSafeEqual).
 *   - Rate limiting: MAX_ATTEMPTS wrong PINs → LOCKOUT_MINUTES cooldown. The
 *     caller checks the lockout BEFORE deriving (no scrypt work while locked),
 *     and records success/failure via the repo.
 *
 * NOT a state machine transition — this is a credential primitive. Audit of
 * the login/reset OUTCOME is emitted by the calling handler.
 *
 * Spec references: migration 078 (account_pin_credentials), Identity &
 * Authentication Spec v1.0 (analogue disciplines — OTP §2.1/§3.1 lockout),
 * I-025 (tenant-blind — callers never leak which factor failed).
 */

import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Policy constants (SI-EMAIL-PIN-AUTH — ratify into the Identity spec)
// ---------------------------------------------------------------------------

/** 6 digits, exactly. */
export const PIN_PATTERN = /^[0-9]{6}$/;
/** Wrong-PIN attempts before a cooldown lockout. */
export const MAX_PIN_ATTEMPTS = 5;
/** Cooldown length once MAX_PIN_ATTEMPTS is hit. */
export const PIN_LOCKOUT_MINUTES = 15;

const SCRYPT_KEYLEN = 64; // 128 hex chars — within the migration 078 CHECK
const SALT_BYTES = 16; // 32 hex chars

// Trivially-weak PINs rejected at set-time (defense-in-depth on top of the
// slow hash + lockout — a leaked hash of '123456' is still guessable offline).
const WEAK_PINS = new Set([
  '000000',
  '111111',
  '222222',
  '333333',
  '444444',
  '555555',
  '666666',
  '777777',
  '888888',
  '999999',
  '123456',
  '654321',
  '012345',
  '121212',
]);

// ---------------------------------------------------------------------------
// PIN shape validation
// ---------------------------------------------------------------------------

export function isValidPinShape(pin: unknown): pin is string {
  return typeof pin === 'string' && PIN_PATTERN.test(pin);
}

/** True if the PIN is acceptable to SET (shape + not trivially weak). */
export function isAcceptablePin(pin: unknown): pin is string {
  return isValidPinShape(pin) && !WEAK_PINS.has(pin);
}

// ---------------------------------------------------------------------------
// Hash / verify
// ---------------------------------------------------------------------------

export interface PinHash {
  pinHash: string; // lowercase hex, SCRYPT_KEYLEN*2 chars
  pinSalt: string; // lowercase hex, SALT_BYTES*2 chars
  algorithm: 'scrypt';
}

/** Derive a fresh scrypt hash + salt for a PIN. */
export function hashPin(pin: string): PinHash {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = crypto.scryptSync(pin, salt, SCRYPT_KEYLEN);
  return {
    pinHash: derived.toString('hex'),
    pinSalt: salt.toString('hex'),
    algorithm: 'scrypt',
  };
}

/**
 * Constant-time verify of a candidate PIN against a stored hash+salt.
 * Returns false on any malformed stored material (fail-closed) rather than
 * throwing, so a corrupt row cannot become an auth bypass or a 500.
 */
export function verifyPin(pin: string, storedHashHex: string, storedSaltHex: string): boolean {
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(storedSaltHex, 'hex');
    expected = Buffer.from(storedHashHex, 'hex');
    if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;
  } catch {
    return false;
  }
  const derived = crypto.scryptSync(pin, salt, SCRYPT_KEYLEN);
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

// A fixed dummy salt (never a real credential's salt) used to burn an
// equivalent scrypt derivation on the no-account / no-credential / locked
// paths, so login latency does not reveal whether an email is registered
// (Codex round-6 HIGH: work-factor timing oracle).
const DUMMY_SALT = Buffer.alloc(SALT_BYTES, 0x5a);

/**
 * Run a scrypt derivation and discard it. Called on the login paths that
 * would otherwise skip the (slow) real verify, so every /login/pin request
 * performs exactly one scrypt regardless of account existence.
 */
export function dummyVerify(pin: string): void {
  // Same cost as a real verifyPin derivation; result intentionally unused.
  crypto.scryptSync(pin, DUMMY_SALT, SCRYPT_KEYLEN);
}

// ---------------------------------------------------------------------------
// Lockout helpers (pure — the repo persists failed_attempts + locked_until)
// ---------------------------------------------------------------------------

export interface LockoutState {
  failedAttempts: number;
  lockedUntil: Date | null;
}

/**
 * True if the credential is currently in cooldown lockout. This is the
 * pre-verify optimization (short-circuits before a scrypt derivation); the
 * authoritative, concurrency-safe accounting is the row-atomic
 * `recordFailureAtomic` in pin-credentials-repo (Codex 2026-07-09 HIGH — the
 * lockout must not be computed read-modify-write in app code).
 */
export function isLockedOut(state: LockoutState, now: Date = new Date()): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}
