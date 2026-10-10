import type { AttestationPlatform, AttestationVerifier } from "@outlet/auth-core";

export interface Clock {
  nowMs(): number;
}

export interface Attestation {
  readonly platform: "ios" | "android";
  readonly token: string;
}

const PLATFORM: Readonly<Record<"ios" | "android", AttestationPlatform>> = {
  ios: "ios_app_attest",
  android: "android_play_integrity",
};

/** Returns the attested device key, or null when attestation is missing, invalid or unavailable. */
export async function attestDevice(
  verifier: AttestationVerifier,
  attestation: Attestation | null,
): Promise<string | null> {
  if (attestation === null) return null;
  try {
    // VERIFY BEFORE LAUNCH: App Attest needs a server issued challenge; no challenge endpoint
    // exists in the OpenAPI skeleton, so an empty challenge is passed to the port.
    const verdict = await verifier.verify({
      platform: PLATFORM[attestation.platform],
      token: attestation.token,
      challenge: "",
    });
    return verdict.ok ? verdict.keyId : null;
  } catch {
    return null;
  }
}
