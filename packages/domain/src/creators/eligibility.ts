import type { CreatorConfig } from "./config";

export const KYC_STATES = ["DRAFT", "SUBMITTED", "AUTO_CHECKS", "APPROVED", "NEEDS_INFO", "REJECTED"] as const;
export type CreatorKycState = (typeof KYC_STATES)[number];

export const CREATOR_STATUSES = ["APPLIED", "ACTIVE", "SUSPENDED", "REJECTED"] as const;
export type CreatorStatus = (typeof CREATOR_STATUSES)[number];

export const PAYOUT_PREFS = ["cash", "credit"] as const;
export type PayoutPref = (typeof PAYOUT_PREFS)[number];

export type IneligibleReason =
  | "under_age"
  | "age_unknown"
  | "kyc_incomplete"
  | "terms_not_accepted"
  | "seller_conflict"
  | "handle_reserved"
  | "handle_invalid"
  | "not_active";

const HANDLE = /^[a-z][a-z0-9_]{2,29}$/;

/** Lower-cases and trims; null when the handle shape is invalid. Reserved names are separate. */
export function normalizeHandle(raw: string): string | null {
  const h = raw.trim().toLowerCase();
  return HANDLE.test(h) ? h : null;
}

export function isReservedHandle(cfg: CreatorConfig, handle: string): boolean {
  const compact = handle.replace(/_/g, "");
  return cfg.reservedHandles.some((r) => r.replace(/[-_]/g, "") === compact);
}

export interface ApplicantFacts {
  readonly ageYears: number | null;
  readonly handle: string;
  readonly termsVersionAccepted: number | null;
  /** True when the applicant is a seller of a store whose items the link targets (checked per link too). */
  readonly sellerConflict: boolean;
}

/** Application gate. Order matters: the first failing reason is the one shown. */
export function checkApplication(cfg: CreatorConfig, a: ApplicantFacts): IneligibleReason | null {
  if (a.ageYears === null) return "age_unknown";
  if (a.ageYears < cfg.minAgeYears) return "under_age";
  if (normalizeHandle(a.handle) === null) return "handle_invalid";
  if (isReservedHandle(cfg, a.handle)) return "handle_reserved";
  if (a.termsVersionAccepted === null) return "terms_not_accepted";
  if (a.sellerConflict) return "seller_conflict";
  return null;
}

export interface CreatorFacts {
  readonly status: CreatorStatus;
  readonly kycState: CreatorKycState;
  readonly ageYears: number | null;
  readonly termsAccepted: boolean;
}

/** Earning gate (links work, commission can accrue). Payout adds `payoutEligible`. */
export function canEarn(cfg: CreatorConfig, c: CreatorFacts): IneligibleReason | null {
  if (c.status !== "ACTIVE") return "not_active";
  if (c.ageYears === null) return "age_unknown";
  if (c.ageYears < cfg.minAgeYears) return "under_age";
  if (!c.termsAccepted) return "terms_not_accepted";
  return null;
}

/** Cash payout needs KYC APPROVED on top of earning rights. A creator under 21 never gets a payout. */
export function payoutEligible(cfg: CreatorConfig, c: CreatorFacts): IneligibleReason | null {
  const e = canEarn(cfg, c);
  if (e !== null) return e;
  return c.kycState === "APPROVED" ? null : "kyc_incomplete";
}

export const LINK_TARGET_TYPES = ["product", "store", "look"] as const;
export type LinkTargetType = (typeof LINK_TARGET_TYPES)[number];
