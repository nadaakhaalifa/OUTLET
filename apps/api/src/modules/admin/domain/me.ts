/** Pure parts of `GET /v1/admin/me` (dashboard foundations track 1). No I/O, no client input. */

export const ADMIN_ME_VERSION = 1 as const;

export const CAPABILITY_KEYS = [
  "console.access",
  "flags.read",
  "flags.write",
  "pii.view",
  "kyc.read",
  "kyc.write",
  "kyc_review.read",
  "elevations.admin",
  "ledger.read",
  "ledger.integrity.read",
  "audit_log.read",
  "payout.read",
  "payout.approve",
  "refund.approve",
  "plan_price.update",
  "data_export.create",
  "privacy.read",
  "recon.read",
  "tax.read",
  "brand_review.read",
  "attention.read",
  "metrics.read.counts",
  "metrics.read.money",
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
export type Capabilities = Readonly<Record<CapabilityKey, boolean>>;

export type Assurance = "passkey" | "totp" | "otp";

/** passkey or webauthn -> passkey; else totp -> totp; else otp. */
export function assuranceFromAmr(amr: readonly string[]): Assurance {
  if (amr.includes("passkey") || amr.includes("webauthn")) return "passkey";
  if (amr.includes("totp")) return "totp";
  return "otp";
}

export type IpAllowlistSource = "edge_attested" | "not_configured" | "invalid" | "dev_override";
export type DeviceSource = "posture_source" | "not_configured" | "dev_override";
export type SessionBinding = "passkey_uv_browser_bound" | "passkey_uv_unbound" | "not_passkey" | "revoked";

export interface Posture {
  readonly ip_allowlisted: boolean;
  readonly device_trusted: boolean;
  readonly ip_allowlist_source: IpAllowlistSource;
  readonly device_source: DeviceSource;
  readonly session_binding: SessionBinding;
}

/** Fail closed posture. `deviceTrusted` is false in Phase A for every session (VR-AC-04: no posture source). */
export function composePosture(i: {
  readonly ip: { readonly allowlisted: boolean; readonly source: IpAllowlistSource };
  readonly binding: SessionBinding;
  readonly devTrust: boolean;
}): Posture {
  if (i.devTrust) {
    return { ip_allowlisted: true, device_trusted: true, ip_allowlist_source: "dev_override", device_source: "dev_override", session_binding: i.binding };
  }
  return {
    ip_allowlisted: i.ip.allowlisted && i.ip.source === "edge_attested",
    device_trusted: false,
    ip_allowlist_source: i.ip.source,
    device_source: "not_configured",
    session_binding: i.binding,
  };
}
