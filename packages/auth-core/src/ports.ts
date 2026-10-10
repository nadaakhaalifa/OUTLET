import { z } from "zod";

/** Cryptographically secure random source. Injected; the domain never touches platform RNG. */
export interface Csprng {
  randomBytes(length: number): Uint8Array;
}

export const MS = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;

// ---- OTP delivery -------------------------------------------------------------------

export const otpChannelSchema = z.enum(["sms", "whatsapp"]);
export type OtpChannel = z.infer<typeof otpChannelSchema>;

export interface OtpSendRequest {
  readonly phoneE164: string;
  /** Plaintext code, passed to the provider only; never logged or stored. */
  readonly code: string;
  readonly locale: "ar" | "en";
  readonly idempotencyKey: string;
}

export type OtpSendResult =
  | { readonly ok: true; readonly providerMessageId: string }
  | { readonly ok: false; readonly retryable: boolean; readonly reason: string };

export interface OtpSender {
  readonly id: string;
  readonly channel: OtpChannel;
  send(request: OtpSendRequest): Promise<OtpSendResult>;
}

// ---- Federated identity -------------------------------------------------------------

export const verifiedIdentitySchema = z.object({
  provider: z.enum(["apple", "google"]),
  subject: z.string().min(1),
  email: z.string().email().nullable(),
  emailVerified: z.boolean(),
  /** Apple private relay addresses are valid (spec 1 edge cases). */
  isPrivateRelay: z.boolean(),
});
export type VerifiedIdentity = z.infer<typeof verifiedIdentitySchema>;

export type IdentityVerification =
  | { readonly ok: true; readonly identity: VerifiedIdentity }
  | { readonly ok: false; readonly reason: "invalid_token" | "expired" | "nonce_mismatch" | "audience_mismatch" | "provider_unavailable" };

export interface AppleIdentityVerifier {
  verify(input: { identityToken: string; expectedNonce: string }): Promise<IdentityVerification>;
}

export interface GoogleIdentityVerifier {
  verify(input: { idToken: string; expectedNonce: string }): Promise<IdentityVerification>;
}

// ---- Passkeys -----------------------------------------------------------------------

export const passkeyCredentialSchema = z.object({
  credentialId: z.string().min(1),
  publicKey: z.string().min(1),
  signCount: z.number().int().nonnegative(),
});
export type PasskeyCredential = z.infer<typeof passkeyCredentialSchema>;

export type PasskeyResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "invalid_response" | "challenge_mismatch" | "origin_mismatch" | "sign_count_regression" | "unknown_credential" };

export interface PasskeyVerifier {
  verifyRegistration(input: { challenge: string; response: unknown }): Promise<PasskeyResult<PasskeyCredential>>;
  verifyAssertion(input: {
    challenge: string;
    response: unknown;
    credential: PasskeyCredential;
  }): Promise<PasskeyResult<{ credentialId: string; newSignCount: number; userHandle: string }>>;
}

// ---- Device attestation -------------------------------------------------------------

export const attestationPlatformSchema = z.enum(["ios_app_attest", "android_play_integrity"]);
export type AttestationPlatform = z.infer<typeof attestationPlatformSchema>;

export type AttestationVerdict =
  | { readonly ok: true; readonly platform: AttestationPlatform; readonly keyId: string }
  | { readonly ok: false; readonly reason: "invalid_token" | "challenge_mismatch" | "integrity_failed" | "provider_unavailable" };

export interface AttestationVerifier {
  verify(input: { platform: AttestationPlatform; token: string; challenge: string }): Promise<AttestationVerdict>;
}
