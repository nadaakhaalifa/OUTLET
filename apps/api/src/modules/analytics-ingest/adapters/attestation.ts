import type { AttestationPlatform, AttestationVerifier } from "@outlet/auth-core";
import { ProblemError } from "../../../platform/problem";
import type { AttestationCheck, AttestationVerdictLite } from "../domain/ports";

const PLATFORM: Readonly<Record<"ios" | "android", AttestationPlatform>> = {
  ios: "ios_app_attest",
  android: "android_play_integrity",
};

/**
 * Calls the existing auth verifier port. VERIFY BEFORE LAUNCH (VR-DASH-07): the verifier is still
 * called with an empty challenge because no server-issued challenge exists; replay is therefore not
 * prevented, which is why real-user ingest stays blocked until Security accepts or fixes this.
 */
export class VerifierAttestationCheck implements AttestationCheck {
  constructor(private readonly verifier: AttestationVerifier) {}
  async verify(platform: "ios" | "android", token: string): Promise<AttestationVerdictLite> {
    try {
      const v = await this.verifier.verify({ platform: PLATFORM[platform], token, challenge: "" });
      return v.ok ? { ok: true } : { ok: false, reason: v.reason };
    } catch (e) {
      // An Unconfigured verifier is a 503 (ProblemError), not "the device is untrusted".
      if (e instanceof ProblemError) throw e;
      return { ok: false, reason: "verifier_error" };
    }
  }
}
