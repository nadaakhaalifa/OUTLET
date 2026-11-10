import { Problems } from "../../platform/problem.js";
import type { DeviceAttestationPort } from "./ports.js";
import type { FieldCipher, OidcVerifier, SmsSender } from "@outlet/auth-core";

/** Fail-closed production defaults (ADR-0029): no provider contract, no key management, no sending. */
export class UnconfiguredSms implements SmsSender {
  readonly provider = "unconfigured";
  send(): Promise<void> {
    return Promise.reject(new Error("SMS provider is not configured"));
  }
}

export class UnconfiguredOidc implements OidcVerifier {
  verify(): Promise<never> {
    return Promise.reject(new Error("OIDC provider is not configured"));
  }
}

/** No KMS-backed cipher exists yet; a registration (which stores phone and date of birth encrypted) cannot proceed without one. */
export class UnconfiguredFieldCipher implements FieldCipher {
  encrypt(): Promise<Uint8Array> {
    return Promise.reject(new Error("field cipher is not configured"));
  }
  decrypt(): Promise<string> {
    return Promise.reject(new Error("field cipher is not configured"));
  }
}

/** No Turnstile / App Attest verifier is wired: device registration answers 503 rather than trusting an unproven install. */
export class UnconfiguredDeviceAttestation implements DeviceAttestationPort {
  verify(): Promise<boolean> {
    return Promise.reject(Problems.unavailable("device-attestation-unavailable"));
  }
}
