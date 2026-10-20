import { constantTimeEqual, hmacSha256, toHex, utf8 } from "./crypto";
import { InvalidStateError } from "./errors";
import { OTP_POLICY, type OtpPolicy } from "./otp-policy";
import type { Csprng } from "./ports";

/** Uniform 6-digit code via rejection sampling over uint32 (no modulo bias). */
export function generateOtp(rng: Csprng, digits: number = OTP_POLICY.digits): string {
  if (!Number.isInteger(digits) || digits < 4 || digits > 9) throw new InvalidStateError("unsupported OTP length");
  const space = 10 ** digits;
  const limit = Math.floor(2 ** 32 / space) * space;
  for (let i = 0; i < 64; i++) {
    const b = rng.randomBytes(4);
    if (b.length !== 4) throw new InvalidStateError("csprng returned wrong length");
    const n = ((b[0] ?? 0) * 2 ** 24 + (b[1] ?? 0) * 2 ** 16 + (b[2] ?? 0) * 2 ** 8 + (b[3] ?? 0));
    if (n < limit) return String(n % space).padStart(digits, "0");
  }
  throw new InvalidStateError("csprng failed to produce an unbiased value");
}

export function generateSalt(rng: Csprng): string {
  return toHex(rng.randomBytes(16));
}

/** HMAC keyed with a server-side pepper; the salt binds the hash to one challenge and phone. */
export function hashOtp(code: string, salt: string, phoneE164: string, pepper: Uint8Array): string {
  return toHex(hmacSha256(pepper, utf8(`otp:v1:${phoneE164}:${salt}:${code}`)));
}

export type OtpChallenge = {
  readonly id: string;
  readonly phoneE164: string;
  readonly salt: string;
  readonly codeHash: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly attempts: number;
  readonly status: "pending" | "consumed" | "locked";
};

export function createOtpChallenge(input: {
  id: string;
  phoneE164: string;
  rng: Csprng;
  pepper: Uint8Array;
  nowMs: number;
  policy?: OtpPolicy;
}): { challenge: OtpChallenge; code: string } {
  const policy = input.policy ?? OTP_POLICY;
  const code = generateOtp(input.rng, policy.digits);
  const salt = generateSalt(input.rng);
  return {
    code,
    challenge: {
      id: input.id,
      phoneE164: input.phoneE164,
      salt,
      codeHash: hashOtp(code, salt, input.phoneE164, input.pepper),
      issuedAtMs: input.nowMs,
      expiresAtMs: input.nowMs + policy.validForMs,
      attempts: 0,
      status: "pending",
    },
  };
}

export type OtpVerifyOutcome = "ok" | "wrong_code" | "expired" | "locked" | "already_consumed";

export function verifyOtp(
  challenge: OtpChallenge,
  candidate: string,
  nowMs: number,
  pepper: Uint8Array,
  policy: OtpPolicy = OTP_POLICY,
): { outcome: OtpVerifyOutcome; challenge: OtpChallenge; attemptsLeft: number } {
  const left = (c: OtpChallenge) => Math.max(0, policy.maxAttempts - c.attempts);
  if (challenge.status === "consumed") return { outcome: "already_consumed", challenge, attemptsLeft: 0 };
  if (challenge.status === "locked") return { outcome: "locked", challenge, attemptsLeft: 0 };
  if (nowMs >= challenge.expiresAtMs) return { outcome: "expired", challenge, attemptsLeft: left(challenge) };

  const attempts = challenge.attempts + 1;
  const match = constantTimeEqual(hashOtp(candidate, challenge.salt, challenge.phoneE164, pepper), challenge.codeHash);
  if (match) {
    const next: OtpChallenge = { ...challenge, attempts, status: "consumed" };
    return { outcome: "ok", challenge: next, attemptsLeft: left(next) };
  }
  const locked = attempts >= policy.maxAttempts;
  const next: OtpChallenge = { ...challenge, attempts, status: locked ? "locked" : "pending" };
  return { outcome: locked ? "locked" : "wrong_code", challenge: next, attemptsLeft: left(next) };
}
