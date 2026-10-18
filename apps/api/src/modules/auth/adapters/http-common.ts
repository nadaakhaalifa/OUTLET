import { DEFAULT_LOCALE, maskPhone } from "@outlet/validation";
import { z } from "zod";
import { UuidSchema } from "@outlet/validation";
import { headerValue, type ApiRequest } from "../../../platform/http-types";
import { ProblemError } from "../../../platform/problem";
import type { Attestation } from "../application/common";
import type { User } from "../domain/ports";

export const DeviceSchema = z
  .object({
    platform: z.enum(["ios", "android"]),
    install_id: UuidSchema,
    app_version: z.string().max(32).optional(),
    push_token: z.string().max(4096).optional(),
  })
  .strict();

/**
 * Passkey assertion device. `web` is admitted here only (deny by default on every other route).
 * A client-supplied install_id for web is accepted and ignored: the server mints it.
 */
export const PasskeyDeviceSchema = z.union([
  DeviceSchema,
  z
    .object({
      platform: z.literal("web"),
      install_id: UuidSchema.optional(),
      app_version: z.string().max(32).optional(),
    })
    .strict(),
]);

export const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Attestation travels in X-App-Attest (OpenAPI `appAttest`). The client platform header is NOT in
 * the OpenAPI skeleton yet (proposed: X-Client-Platform); without it attestation cannot be
 * routed to App Attest or Play Integrity.
 */
export function attestationFrom(req: ApiRequest, platformHint?: "ios" | "android"): Attestation | null {
  const token = headerValue(req, "x-app-attest");
  const platform = platformHint ?? headerValue(req, "x-client-platform");
  if (token === undefined || token.length === 0 || token.length > 8192) return null;
  if (platform !== "ios" && platform !== "android") return null;
  return { token, platform };
}

export function attestationProblem(): ProblemError {
  return new ProblemError(403, "attestation-failed", "Device attestation failed", { code: "attestation_failed" });
}

export function ageGateRequiredProblem(): ProblemError {
  return new ProblemError(403, "age-gate-required", "Confirm your date of birth first", {
    detail: "POST /v1/auth/age-gate must succeed for this device before sign-in.",
    code: "age_gate_required",
  });
}

export function ageBlockedProblem(blockedUntilMs: number): ProblemError {
  return new ProblemError(403, "age-blocked", "This service is not available to you yet", {
    code: "age_blocked",
    extensions: { blocked_until: iso(blockedUntilMs) },
  });
}

export function toMe(user: User): Record<string, unknown> {
  return {
    id: user.id,
    ...(user.phoneE164 !== null ? { phone_masked: maskPhone(user.phoneE164) } : {}),
    email: user.email,
    locale: user.language === "ar" ? DEFAULT_LOCALE : "en",
    age_band: user.ageBand === null ? "unverified" : user.ageBand === "18_20" ? "18_20" : "21_plus",
    limited_capacity: user.limitedCapacity,
    phone_verified: user.phoneE164 !== null,
    status: "active",
    created_at: iso(user.createdAtMs),
  };
}

export function tokenPair(result: {
  accessToken: string;
  accessExpiresAtMs: number;
  refreshToken: string;
  refreshExpiresAtMs: number;
  user: User;
  /** Web sign-in only: returned once, never stored in clear, never logged. */
  installToken?: string;
  /** OTP verify only: true when this call created the account. Omitted by every other flow. */
  isNewAccount?: boolean;
}): Record<string, unknown> {
  return {
    ...(result.isNewAccount !== undefined ? { is_new_account: result.isNewAccount } : {}),
    ...(result.installToken !== undefined ? { install_token: result.installToken } : {}),
    access_token: result.accessToken,
    access_expires_at: iso(result.accessExpiresAtMs),
    refresh_token: result.refreshToken,
    refresh_expires_at: iso(result.refreshExpiresAtMs),
    second_factor_required: false,
    user: toMe(result.user),
  };
}
