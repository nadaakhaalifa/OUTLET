import { MS_PER_DAY, MS_PER_HOUR } from "./types";

/** Automatic enforcement ladder (spec 9.5) as pure functions. */

export const VIOLATION_KINDS = [
  "insufficient_evidence",
  "claim_exceeds_vrp",
  "pre_drop_inflation",
  "cross_channel_cheaper",
  "severe_or_repeat",
] as const;
export type ViolationKind = (typeof VIOLATION_KINDS)[number];

export const CROSS_CHANNEL_FIX_MS = 48 * MS_PER_HOUR;
export const VIOLATION_LOOKBACK_DAYS = 90;
export const VIOLATION_LOOKBACK_MS = VIOLATION_LOOKBACK_DAYS * MS_PER_DAY;
export const STRIKES_FOR_BADGE_LOSS = 3;
export const BADGE_REMOVAL_DAYS = 30;
export const DROPS_BLOCKED_DAYS = 30;
/** Fairness rule: a human reviews a suspension within this many business days. */
export const SUSPENSION_REVIEW_BUSINESS_DAYS = 5;

export type EnforcementAction =
  | { readonly kind: "hide_discount" }
  | { readonly kind: "auto_correct_display" }
  | { readonly kind: "remove_badge"; readonly days: number; readonly rankingPenalty: true }
  | { readonly kind: "demote"; readonly fixDeadlineMs: number }
  | { readonly kind: "auto_pause_sku" }
  | { readonly kind: "strip_verified_badge"; readonly commissionSurcharge: true; readonly dropsBlockedDays: number }
  | { readonly kind: "suspend_store"; readonly holdPayouts: true; readonly humanReviewBusinessDays: number };

export interface EnforcementInput {
  readonly kind: ViolationKind;
  /** Violations by this store in the last 90 days INCLUDING the one being decided. */
  readonly violationsInWindow: number;
  /** When a cross-channel-cheaper finding first opened for this SKU, if one is open. */
  readonly crossChannelOpenSinceMs: number | null;
  readonly nowMs: number;
}

function ladderStep(i: EnforcementInput): EnforcementAction[] {
  switch (i.kind) {
    case "insufficient_evidence":
      return [{ kind: "hide_discount" }];
    case "claim_exceeds_vrp":
      return [{ kind: "auto_correct_display" }];
    case "pre_drop_inflation":
      return [{ kind: "remove_badge", days: BADGE_REMOVAL_DAYS, rankingPenalty: true }];
    case "cross_channel_cheaper": {
      const since = i.crossChannelOpenSinceMs ?? i.nowMs;
      if (i.nowMs - since >= CROSS_CHANNEL_FIX_MS) return [{ kind: "demote", fixDeadlineMs: since + CROSS_CHANNEL_FIX_MS }, { kind: "auto_pause_sku" }];
      return [{ kind: "demote", fixDeadlineMs: since + CROSS_CHANNEL_FIX_MS }];
    }
    case "severe_or_repeat":
      return [{ kind: "suspend_store", holdPayouts: true, humanReviewBusinessDays: SUSPENSION_REVIEW_BUSINESS_DAYS }];
  }
}

/** Deterministic: the same input always yields the same ordered actions. */
export function decideEnforcement(input: EnforcementInput): readonly EnforcementAction[] {
  const actions = ladderStep(input);
  if (input.kind !== "severe_or_repeat" && input.violationsInWindow >= STRIKES_FOR_BADGE_LOSS) {
    actions.push({ kind: "strip_verified_badge", commissionSurcharge: true, dropsBlockedDays: DROPS_BLOCKED_DAYS });
  }
  return actions;
}

export interface TrustInput {
  readonly violationsInWindow: number;
  readonly openCrossChannelFindings: number;
  readonly claimsEvaluated: number;
  readonly claimsAutoCorrected: number;
}

/** Price Trust Score 0..100, integer arithmetic only. */
export function priceTrustScore(i: TrustInput): number {
  const strikes = Math.min(Math.max(i.violationsInWindow, 0), 8) * 10;
  const open = Math.min(Math.max(i.openCrossChannelFindings, 0), 3) * 5;
  const correctedPct = i.claimsEvaluated > 0 ? Math.floor((Math.min(i.claimsAutoCorrected, i.claimsEvaluated) * 100) / i.claimsEvaluated) : 0;
  const corrections = Math.floor(correctedPct / 5);
  return Math.max(0, Math.min(100, 100 - strikes - open - corrections));
}

export type TrustBand = "excellent" | "good" | "at_risk" | "restricted";

export function trustBand(score: number): TrustBand {
  if (score >= 90) return "excellent";
  if (score >= 70) return "good";
  if (score >= 40) return "at_risk";
  return "restricted";
}
