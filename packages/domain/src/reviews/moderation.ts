import { DEFAULT_REVIEW_CONFIG, type HoldReason, type ModerationStatus, type ReviewRulesConfig } from "./types";

export type ModerationEvent =
  | "checks_done"
  | "auto_publish"
  | "auto_hold"
  | "auto_reject"
  | "moderator_publish"
  | "moderator_reject"
  | "reported"
  | "edited";

export class InvalidModerationTransitionError extends Error {
  constructor(
    readonly from: ModerationStatus,
    readonly event: ModerationEvent,
  ) {
    super(`Invalid moderation transition: ${from} --${event}-->`);
    this.name = "InvalidModerationTransitionError";
  }
}

/** SUBMITTED -> AUTO_CHECKED -> PUBLISHED | HELD | REJECTED, plus the human and report edges. */
export const MODERATION_TABLE: Readonly<Record<ModerationStatus, Readonly<Partial<Record<ModerationEvent, ModerationStatus>>>>> = {
  SUBMITTED: { checks_done: "AUTO_CHECKED" },
  AUTO_CHECKED: { auto_publish: "PUBLISHED", auto_hold: "HELD", auto_reject: "REJECTED" },
  HELD: { moderator_publish: "PUBLISHED", moderator_reject: "REJECTED", edited: "SUBMITTED" },
  PUBLISHED: { reported: "HELD", moderator_reject: "REJECTED", edited: "SUBMITTED" },
  REJECTED: { edited: "SUBMITTED" },
};

export function transitionModeration(from: ModerationStatus, event: ModerationEvent): ModerationStatus {
  const to = MODERATION_TABLE[from][event];
  if (to === undefined) throw new InvalidModerationTransitionError(from, event);
  return to;
}

export type ImageScores = { readonly nsfw: number; readonly violence: number } | "unavailable";

export interface AutoModerationSignals {
  /** Integer 0..100, or "unavailable" when the classifier failed (fail closed to HELD). */
  readonly toxicity: number | "unavailable";
  readonly images: readonly ImageScores[];
  readonly hasContactInfo: boolean;
}

export type AutoModerationDecision =
  | { readonly event: "auto_publish"; readonly reason: null }
  | { readonly event: "auto_hold"; readonly reason: HoldReason }
  | { readonly event: "auto_reject"; readonly reason: HoldReason };

/** Reject outranks hold outranks publish. A classifier outage never publishes. */
export function decideAutoModeration(
  s: AutoModerationSignals,
  cfg: ReviewRulesConfig = DEFAULT_REVIEW_CONFIG,
): AutoModerationDecision {
  if (s.toxicity !== "unavailable" && s.toxicity >= cfg.toxicityRejectScore) {
    return { event: "auto_reject", reason: "toxicity" };
  }
  for (const img of s.images) {
    if (img !== "unavailable" && Math.max(img.nsfw, img.violence) >= cfg.imageRejectScore) {
      return { event: "auto_reject", reason: "image_flagged" };
    }
  }
  if (s.toxicity === "unavailable" || s.images.includes("unavailable")) {
    return { event: "auto_hold", reason: "classifier_unavailable" };
  }
  if (s.toxicity >= cfg.toxicityHoldScore) return { event: "auto_hold", reason: "toxicity" };
  for (const img of s.images) {
    if (img !== "unavailable" && Math.max(img.nsfw, img.violence) >= cfg.imageHoldScore) {
      return { event: "auto_hold", reason: "image_flagged" };
    }
  }
  if (s.hasContactInfo) return { event: "auto_hold", reason: "contact_info" };
  return { event: "auto_publish", reason: null };
}
