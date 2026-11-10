import { PromotionError } from "./errors.js";
import type { PromotionStatus } from "./rules.js";

/** DRAFT -> SCHEDULED -> ACTIVE -> (PAUSED <-> ACTIVE) -> ENDED | EXHAUSTED (data-model 7.22). */
export const PROMOTION_TRANSITIONS: Readonly<Record<PromotionStatus, readonly PromotionStatus[]>> = {
  DRAFT: ["SCHEDULED", "ACTIVE", "ENDED"],
  SCHEDULED: ["ACTIVE", "PAUSED", "ENDED"],
  ACTIVE: ["PAUSED", "ENDED", "EXHAUSTED"],
  PAUSED: ["ACTIVE", "ENDED"],
  ENDED: [],
  EXHAUSTED: [],
};

export const assertTransition = (from: PromotionStatus, to: PromotionStatus): void => {
  if (!PROMOTION_TRANSITIONS[from].includes(to)) throw new PromotionError("INVALID_TRANSITION", `${from} -> ${to}`);
};

/** Rules, funding and limits may change only before the promotion runs (or while paused): in-flight orders cite a version. */
export const isEditable = (s: PromotionStatus): boolean => s === "DRAFT" || s === "SCHEDULED" || s === "PAUSED";
