import type { OidcVerifier, OtpService, SessionService } from "@outlet/auth-core";
import type { PasskeyPort } from "./passkeys.js";

export interface SessionRow {
  readonly id: string;
  readonly deviceId: string;
  readonly platform: string;
  readonly uaFamily: string | null;
  readonly amr: readonly string[];
  readonly createdAt: Date;
  readonly lastSeenAt: Date | null;
}

/** Own active session families (outlet_app, user context, keyset by created_at desc, id desc). */
export interface SessionReaderPort {
  list(userId: string, page: { readonly limit: number; readonly cursor?: string }): Promise<{ readonly items: readonly SessionRow[]; readonly nextCursor: string | null }>;
}

/**
 * Proves a device registration comes from a genuine install (Cloudflare Turnstile on web, App Attest / Play Integrity on apps).
 * `verify` resolves true/false; an unconfigured provider rejects with 503 so production fails CLOSED (ADR-0029).
 */
export interface DeviceAttestationPort {
  verify(input: { readonly platform: "web" | "ios" | "android"; readonly installId: string; readonly token: string | undefined }): Promise<boolean>;
}

/** Everything the auth routes use for one market. Built on the outlet_auth pool (ADR-0011), except the session reader. */
export interface AuthServices {
  readonly otp: Pick<OtpService, "request" | "verify">;
  readonly sessions: Pick<SessionService, "issue" | "refresh" | "revoke" | "revokeByRefreshToken">;
  readonly sessionReader: SessionReaderPort;
  readonly devices: { register(input: { platform: "web" | "ios" | "android"; installId: string; now: Date }): Promise<string> };
  /** Apple/Google ID-token verification. Production: UnconfiguredOidc (fail closed). */
  readonly oidc: OidcVerifier;
  readonly attestation: DeviceAttestationPort;
  readonly passkeys: PasskeyPort;
}
