import { constantTimeEqual, hmacSha1, hmacSha256, toHex, utf8 } from "./crypto";
import { InvalidStateError } from "./errors";
import { MS, type Csprng } from "./ports";

/**
 * TOTP (RFC 6238) with the parameters every authenticator app supports: HMAC-SHA-1, 6 digits,
 * 30 second step. Pure: time and randomness are injected. Replay prevention and lockout are pure
 * decisions here; the adapter persists `lastUsedStep` / lockout state atomically.
 */
export const TOTP = {
  digits: 6,
  stepMs: 30 * MS.second,
  /** Accepted drift: previous, current and next step. */
  window: 1,
  secretBytes: 20,
  maxFailures: 5,
  lockBaseMs: 15 * MS.minute,
  lockCapMs: 24 * MS.hour,
  recoveryCodeCount: 8,
} as const;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new InvalidStateError("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function generateTotpSecret(rng: Csprng): string {
  const b = rng.randomBytes(TOTP.secretBytes);
  if (b.length !== TOTP.secretBytes) throw new InvalidStateError("csprng returned wrong length");
  return base32Encode(b);
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / TOTP.stepMs);
}

/** HOTP truncation (RFC 4226) of the counter `step` for a base32 secret. */
export function totpCode(secretBase32: string, step: number, digits: number = TOTP.digits): string {
  const counter = new Uint8Array(8);
  const view = new DataView(counter.buffer);
  view.setUint32(0, Math.floor(step / 2 ** 32));
  view.setUint32(4, step >>> 0);
  const mac = hmacSha1(base32Decode(secretBase32), counter);
  const offset = (mac[19] ?? 0) & 0x0f;
  const bin =
    (((mac[offset] ?? 0) & 0x7f) << 24) | ((mac[offset + 1] ?? 0) << 16) | ((mac[offset + 2] ?? 0) << 8) | (mac[offset + 3] ?? 0);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export type TotpCheck =
  | { readonly ok: true; readonly step: number }
  | { readonly ok: false; readonly reason: "invalid" | "replayed" };

/**
 * Accepts the code when it matches a step in the +-window. A step at or below `lastUsedStep` is a
 * replay (the same code, or an older one, was already accepted). All candidate steps are compared
 * in constant time so the matching offset does not leak.
 */
export function verifyTotp(input: {
  secretBase32: string;
  code: string;
  nowMs: number;
  lastUsedStep: number | null;
}): TotpCheck {
  if (!/^[0-9]{6}$/.test(input.code)) return { ok: false, reason: "invalid" };
  const current = totpStep(input.nowMs);
  let matched: number | null = null;
  for (let d = -TOTP.window; d <= TOTP.window; d++) {
    const step = current + d;
    if (step < 0) continue;
    if (constantTimeEqual(totpCode(input.secretBase32, step), input.code) && matched === null) matched = step;
  }
  if (matched === null) return { ok: false, reason: "invalid" };
  if (input.lastUsedStep !== null && matched <= input.lastUsedStep) return { ok: false, reason: "replayed" };
  return { ok: true, step: matched };
}

export function otpauthUri(input: { issuer: string; account: string; secretBase32: string }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const q = `secret=${input.secretBase32}&issuer=${encodeURIComponent(input.issuer)}&algorithm=SHA1&digits=${TOTP.digits}&period=${TOTP.stepMs / 1000}`;
  return `otpauth://totp/${label}?${q}`;
}

// ---- Lockout with backoff -------------------------------------------------------------------

export interface TotpLockState {
  readonly failedCount: number;
  /** How many times the account has been locked since the last success. */
  readonly lockCount: number;
  readonly lockedUntilMs: number | null;
}

export const FRESH_LOCK_STATE: TotpLockState = { failedCount: 0, lockCount: 0, lockedUntilMs: null };

export function isLocked(state: TotpLockState, nowMs: number): boolean {
  return state.lockedUntilMs !== null && nowMs < state.lockedUntilMs;
}

/** 5th consecutive failure locks for 15 min, doubling per lock up to 24 h. */
export function registerTotpFailure(state: TotpLockState, nowMs: number): TotpLockState {
  const failed = state.failedCount + 1;
  if (failed < TOTP.maxFailures) return { ...state, failedCount: failed };
  const lockCount = state.lockCount + 1;
  const wait = Math.min(TOTP.lockBaseMs * 2 ** Math.min(lockCount - 1, 20), TOTP.lockCapMs);
  return { failedCount: 0, lockCount, lockedUntilMs: nowMs + wait };
}

export function registerTotpSuccess(): TotpLockState {
  return FRESH_LOCK_STATE;
}

// ---- Recovery codes -------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const RECOVERY_CODE_FORMAT = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;

/** 8 codes of 10 Crockford base32 characters (50 bits each), shown once. */
export function generateRecoveryCodes(rng: Csprng, count: number = TOTP.recoveryCodeCount): string[] {
  const codes: string[] = [];
  while (codes.length < count) {
    const b = rng.randomBytes(10);
    if (b.length !== 10) throw new InvalidStateError("csprng returned wrong length");
    let s = "";
    for (let i = 0; i < 10; i++) s += CROCKFORD[(b[i] ?? 0) & 31];
    const code = `${s.slice(0, 5)}-${s.slice(5)}`;
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

export function normalizeRecoveryCode(input: string): string {
  return input.trim().toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
}

/** Keyed hash (the pepper is a server secret), bound to the seller so equal codes never collide. */
export function hashRecoveryCode(code: string, sellerUserId: string, pepper: Uint8Array): string {
  return toHex(hmacSha256(pepper, utf8(`recovery:v1:${sellerUserId}:${normalizeRecoveryCode(code)}`)));
}
