import { AUTO_BUY_LIMITS } from "./types";

export type TermsViolation =
  | "target_not_positive"
  | "target_not_below_current"
  | "max_below_target"
  | "expiry_not_in_future"
  | "expiry_too_far"
  | "size_invalid";

export interface TermsInput {
  readonly currentPrice: bigint;
  readonly targetPrice: bigint;
  readonly maxPrice: bigint;
  readonly expiresAtMs: number;
  readonly nowMs: number;
  readonly sizeLabel: string;
}

const DAY_MS = 86_400_000;

/**
 * Rules for a new mandate (spec Flow 1 and Rules). Every violation is returned so the client can
 * show them together; an empty array means the terms are acceptable.
 */
export function validateMandateTerms(i: TermsInput): readonly TermsViolation[] {
  const out: TermsViolation[] = [];
  if (i.targetPrice <= 0n) out.push("target_not_positive");
  else if (i.targetPrice >= i.currentPrice) out.push("target_not_below_current");
  if (i.maxPrice < i.targetPrice) out.push("max_below_target");
  if (!Number.isFinite(i.expiresAtMs) || i.expiresAtMs <= i.nowMs) out.push("expiry_not_in_future");
  else if (i.expiresAtMs > i.nowMs + AUTO_BUY_LIMITS.maxExpiryDays * DAY_MS) out.push("expiry_too_far");
  const size = i.sizeLabel.trim();
  if (size.length === 0 || size.length > AUTO_BUY_LIMITS.sizeLabelMax) out.push("size_invalid");
  return out;
}
