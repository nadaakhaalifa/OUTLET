import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { PasskeyCredential, PasskeyResult, PasskeyVerifier } from "@outlet/auth-core";
import { z } from "zod";

const b64u = z.string().min(1).max(16_384).regex(/^[A-Za-z0-9_-]+$/);

const RegistrationSchema = z.object({
  id: b64u,
  rawId: b64u,
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: b64u,
    attestationObject: b64u,
    transports: z.array(z.string()).max(8).optional(),
  }).passthrough(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.string().optional(),
}).passthrough();

const AssertionSchema = z.object({
  id: b64u,
  rawId: b64u,
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: b64u,
    authenticatorData: b64u,
    signature: b64u,
    userHandle: b64u.optional(),
  }).passthrough(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.string().optional(),
}).passthrough();

type Reason = Extract<PasskeyResult<never>, { ok: false }>["reason"];

function reasonOf(error: unknown): Reason {
  const m = error instanceof Error ? error.message.toLowerCase() : "";
  if (m.includes("counter")) return "sign_count_regression";
  if (m.includes("origin")) return "origin_mismatch";
  if (m.includes("challenge")) return "challenge_mismatch";
  return "invalid_response";
}

export interface WebAuthnConfig {
  readonly rpId: string;
  /** Exact origins responses must come from (https URL or the native app's origin). */
  readonly origins: readonly string[];
}

/**
 * Real WebAuthn verification (@simplewebauthn/server): client data type/challenge/origin, RP ID
 * hash, user presence AND user verification (both required, ASVS 5.0 L2 passkeys), attestation
 * format "none"/"packed"/etc. parsing, COSE key import, signature, counter. The signature counter
 * regression the library detects is surfaced as `sign_count_regression` so the service can mark
 * the credential `suspected_clone`. The challenge string is the exact base64url value stored by
 * the server; it is single use at the store, not here.
 */
export class SimpleWebAuthnVerifier implements PasskeyVerifier {
  constructor(private readonly cfg: WebAuthnConfig) {}

  async verifyRegistration(input: { challenge: string; response: unknown }): Promise<PasskeyResult<PasskeyCredential>> {
    const parsed = RegistrationSchema.safeParse(input.response);
    if (!parsed.success) return { ok: false, reason: "invalid_response" };
    try {
      const v = await verifyRegistrationResponse({
        response: parsed.data as unknown as RegistrationResponseJSON,
        expectedChallenge: input.challenge,
        expectedOrigin: [...this.cfg.origins],
        expectedRPID: this.cfg.rpId,
        requireUserPresence: true,
        requireUserVerification: true,
      });
      if (!v.verified) return { ok: false, reason: "invalid_response" };
      const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
      return {
        ok: true,
        value: {
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString("base64url"),
          signCount: credential.counter,
          backupEligible: credentialDeviceType === "multiDevice",
          backedUp: credentialBackedUp,
        },
      };
    } catch (error) {
      return { ok: false, reason: reasonOf(error) };
    }
  }

  async verifyAssertion(input: {
    challenge: string;
    response: unknown;
    credential: PasskeyCredential;
  }): Promise<PasskeyResult<{ credentialId: string; newSignCount: number; userHandle: string | null; backupEligible?: boolean; backedUp?: boolean }>> {
    const parsed = AssertionSchema.safeParse(input.response);
    if (!parsed.success) return { ok: false, reason: "invalid_response" };
    if (parsed.data.id !== input.credential.credentialId) return { ok: false, reason: "unknown_credential" };
    try {
      const v = await verifyAuthenticationResponse({
        response: parsed.data as unknown as AuthenticationResponseJSON,
        expectedChallenge: input.challenge,
        expectedOrigin: [...this.cfg.origins],
        expectedRPID: this.cfg.rpId,
        credential: {
          id: input.credential.credentialId,
          publicKey: new Uint8Array(Buffer.from(input.credential.publicKey, "base64url")),
          counter: input.credential.signCount,
        },
        requireUserVerification: true,
      });
      if (!v.verified) return { ok: false, reason: "invalid_response" };
      const handle = parsed.data.response.userHandle;
      return {
        ok: true,
        value: {
          credentialId: v.authenticationInfo.credentialID,
          newSignCount: v.authenticationInfo.newCounter,
          userHandle: handle === undefined ? null : Buffer.from(handle, "base64url").toString("utf8"),
          backupEligible: v.authenticationInfo.credentialDeviceType === "multiDevice",
          backedUp: v.authenticationInfo.credentialBackedUp,
        },
      };
    } catch (error) {
      return { ok: false, reason: reasonOf(error) };
    }
  }
}
