/**
 * Reviews, Q&A and review guidelines (spec 5 and 27). Pure types: no I/O, no clock.
 * Time is epoch milliseconds injected by callers.
 */

export const MODERATION_STATUSES = ["SUBMITTED", "AUTO_CHECKED", "PUBLISHED", "HELD", "REJECTED"] as const;
export type ModerationStatus = (typeof MODERATION_STATUSES)[number];

/** Every user generated item that goes through the moderation pipeline and can be reported. */
export const UGC_TARGET_TYPES = ["review", "review_reply", "question", "answer"] as const;
export type UgcTargetType = (typeof UGC_TARGET_TYPES)[number];

export const FIT_VALUES = ["too_small", "ok", "too_large"] as const;
export type FitValue = (typeof FIT_VALUES)[number];

export const REPORT_REASONS = ["spam", "offensive", "off_topic", "fake", "personal_info", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const HOLD_REASONS = [
  "toxicity",
  "image_flagged",
  "classifier_unavailable",
  "contact_info",
  "reported",
  "moderator",
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

export const REVIEW_LIMITS = {
  ratingMin: 1,
  ratingMax: 5,
  titleMax: 80,
  bodyMin: 10,
  bodyMax: 2000,
  sizeLabelMax: 20,
  fitAreaMax: 30,
  photosMax: 5,
  replyMax: 1000,
  questionMin: 5,
  questionMax: 500,
  answerMin: 2,
  answerMax: 1000,
} as const;

export interface ReviewRulesConfig {
  /** Below this many published reviews no aggregate is shown at all (no stub, no "New"). */
  readonly minAggregateCount: number;
  /** Seller response SLA for a published question (spec 19, 48h). */
  readonly qaResponseSlaMs: number;
  /** Distinct reporters that move a published item to HELD for a human. */
  readonly reportsToHold: number;
  readonly reportsPerReporterPerDay: number;
  /** A review can be written this long after courier confirmed delivery. */
  readonly reviewWindowMs: number;
  /** Classifier scores are integers 0..100. */
  readonly toxicityHoldScore: number;
  readonly toxicityRejectScore: number;
  readonly imageHoldScore: number;
  readonly imageRejectScore: number;
}

const HOUR = 3_600_000;
export const DEFAULT_REVIEW_CONFIG: ReviewRulesConfig = {
  minAggregateCount: 5,
  qaResponseSlaMs: 48 * HOUR,
  reportsToHold: 3,
  reportsPerReporterPerDay: 20,
  reviewWindowMs: 180 * 24 * HOUR,
  toxicityHoldScore: 50,
  toxicityRejectScore: 90,
  imageHoldScore: 50,
  imageRejectScore: 90,
};

/** A line the courier confirmed as delivered. The only evidence a review may rest on. */
export interface DeliveredLine {
  readonly orderLineId: string;
  readonly userId: string;
  readonly storeId: string;
  readonly productId: string;
  /** Size label as bought, for example "M". Never a measurement. */
  readonly sizeLabel: string | null;
  readonly deliveredAtMs: number;
}

export interface Review {
  readonly id: string;
  readonly orderLineId: string;
  readonly userId: string;
  readonly storeId: string;
  readonly productId: string;
  readonly rating: number;
  readonly title: string | null;
  readonly body: string;
  readonly purchasedSize: string | null;
  readonly fit: FitValue | null;
  readonly fitArea: string | null;
  readonly photoIds: readonly string[];
  readonly status: ModerationStatus;
  readonly holdReason: HoldReason | null;
  /** Set when the (rating independent) reward intent was first emitted. */
  readonly rewardIntentAtMs: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly publishedAtMs: number | null;
}

export interface ReviewReply {
  readonly reviewId: string;
  readonly storeId: string;
  readonly authorUserId: string;
  readonly body: string;
  readonly status: ModerationStatus;
  readonly holdReason: HoldReason | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface Question {
  readonly id: string;
  readonly productId: string;
  readonly storeId: string;
  readonly userId: string;
  readonly body: string;
  readonly status: ModerationStatus;
  readonly holdReason: HoldReason | null;
  readonly createdAtMs: number;
  readonly publishedAtMs: number | null;
  /** publishedAt + SLA. The clock starts when shoppers can see the question. */
  readonly slaDueAtMs: number | null;
  readonly answeredAtMs: number | null;
  readonly slaBreachedAtMs: number | null;
}

export interface Answer {
  readonly id: string;
  readonly questionId: string;
  readonly storeId: string;
  readonly authorUserId: string;
  readonly body: string;
  readonly status: ModerationStatus;
  readonly holdReason: HoldReason | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface RatingCounts {
  readonly byStar: readonly [number, number, number, number, number];
}

export interface ReviewSummary {
  readonly count: number;
  /** Average times ten, rounded half up (43 means 4.3). Integer math only. */
  readonly averageTenths: number;
  readonly distribution: readonly [number, number, number, number, number];
}
