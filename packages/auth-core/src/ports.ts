import { z } from "zod";

/** Per-key sliding-window limiter. `hit` records the attempt only when allowed. */
export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number, now: Date): Promise<{ allowed: boolean; remaining: number; retryAfterMs?: number }>;
}

export interface SmsSender {
  readonly provider: string;
  send(msg: { phoneE164: string; code: string; channel: "sms" | "whatsapp" }): Promise<void>;
}

/** Envelope for P3 fields. Real KMS-backed implementation comes later (BUILD-PROMPT section 4). */
export interface FieldCipher {
  /** `aad` binds the ciphertext to its column (for example "users.phone_ct"); decrypt must pass the same value. */
  encrypt(plaintext: string, aad: string): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array, aad: string): Promise<string>;
}

/*
 * TODO (ADR-lite): passkey and Apple/Google verification are ports + DTOs only.
 * The WebAuthn ceremony (likely @simplewebauthn/server) and OIDC JWKS verification
 * belong to the HTTP layer and are not implemented here. Verified results must be
 * turned into sessions with amr "passkey" / "apple" / "google" via SessionService.issue.
 */
export const passkeyAssertionDtoSchema = z.object({
  credentialId: z.string().min(1),
  clientDataJSON: z.string().min(1),
  authenticatorData: z.string().min(1),
  signature: z.string().min(1),
  challengeId: z.string().min(1),
});
export type PasskeyAssertionDto = z.infer<typeof passkeyAssertionDtoSchema>;

export const oidcLoginDtoSchema = z.object({
  provider: z.enum(["apple", "google"]),
  idToken: z.string().min(1),
  nonce: z.string().min(1),
});
export type OidcLoginDto = z.infer<typeof oidcLoginDtoSchema>;

export interface PasskeyVerifier {
  verifyAssertion(dto: PasskeyAssertionDto): Promise<{ userId: string; credentialId: string }>;
}

export interface OidcVerifier {
  verify(dto: OidcLoginDto): Promise<{ provider: "apple" | "google"; subject: string; email?: string }>;
}
