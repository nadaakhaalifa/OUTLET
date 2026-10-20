import { SellerSettingsError } from "./errors";

/** Status record only. ETA credentials and signing tokens are never stored in this module (secrets go through the SecretsPort). */
export const ETA_STATUSES = ["not_enrolled", "pending_verification", "verified", "failed", "revoked"] as const;
export type EtaStatus = (typeof ETA_STATUSES)[number];
export type EtaEvent = "request" | "verified" | "failed" | "revoke";

export function etaTransition(status: EtaStatus, event: EtaEvent): EtaStatus {
  switch (event) {
    case "request":
      if (status === "not_enrolled" || status === "failed" || status === "revoked") return "pending_verification";
      break;
    case "verified":
    case "failed":
      if (status === "pending_verification") return event === "verified" ? "verified" : "failed";
      break;
    case "revoke":
      if (status === "verified" || status === "pending_verification") return "revoked";
      break;
  }
  throw new SellerSettingsError("eta_invalid_transition");
}
