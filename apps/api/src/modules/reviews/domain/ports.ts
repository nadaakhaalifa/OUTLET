import type {
  Answer,
  DeliveredLine,
  FitValue,
  HoldReason,
  KeysetPosition,
  ModerationStatus,
  Question,
  RatingCounts,
  ReportReason,
  Review,
  ReviewDraft,
  ReviewReply,
  ReviewRewardIntent,
  UgcTargetType,
} from "./bridge";

export interface IdPort {
  uuidV7(): string;
}

export interface Clock {
  nowMs(): number;
}

// ---- ports owned by other modules (fakes live in adapters/in-memory.ts) ----------------------

/** Orders module. Only lines whose courier confirmed `delivered_at` are returned. */
export interface PurchaseVerificationPort {
  findDeliveredLine(orderLineId: string): Promise<DeliveredLine | null>;
}

/** Sellers module: which stores a user owns or works for (self review and self reply control). */
export interface SellerIdentityPort {
  storeIdsOf(userId: string): Promise<readonly string[]>;
}

/** Catalog module: which store sells a product, null when the product is unknown or unlisted. */
export interface ProductStorePort {
  storeOfProduct(productId: string): Promise<string | null>;
}

/** Users module: the first name only. Never a surname, phone or email. */
export interface ReviewerProfilePort {
  firstName(userId: string): Promise<string | null>;
}

/** Uploads module: are these upload ids the caller's own, scanned images. */
export interface PhotoUploadPort {
  areOwnedImages(userId: string, uploadIds: readonly string[]): Promise<boolean>;
}

/** Integer score 0..100. Throws or rejects when the classifier is unavailable. */
export interface ToxicityClassifierPort {
  score(text: string): Promise<number>;
}

export interface ImageClassifierPort {
  scores(uploadId: string): Promise<{ readonly nsfw: number; readonly violence: number }>;
}

// ---- events (written to the outbox in the same transaction as the state change) -------------

export type ReviewEvent =
  | { readonly type: "review.published"; readonly reviewId: string; readonly productId: string; readonly storeId: string; readonly rating: number }
  | { readonly type: "review.unpublished"; readonly reviewId: string; readonly productId: string; readonly storeId: string }
  | {
      readonly type: "review.fit_feedback_submitted";
      readonly reviewId: string;
      readonly orderLineId: string;
      readonly productId: string;
      readonly fit: FitValue;
      readonly fitArea: string | null;
      readonly sizeLabel: string | null;
    }
  | {
      readonly type: "review.reward_intent";
      readonly reviewId: string;
      readonly userId: string;
      readonly intent: ReviewRewardIntent;
      readonly idempotencyKey: string;
    }
  | { readonly type: "qa.question_published"; readonly questionId: string; readonly productId: string; readonly storeId: string; readonly slaDueAtMs: number }
  | { readonly type: "qa.question_answered"; readonly questionId: string; readonly storeId: string }
  | { readonly type: "qa.sla_breached"; readonly questionId: string; readonly storeId: string; readonly dueAtMs: number }
  | { readonly type: "ugc.reported"; readonly targetType: UgcTargetType; readonly targetId: string; readonly reason: ReportReason }
  | {
      readonly type: "ugc.moderated";
      readonly targetType: UgcTargetType;
      readonly targetId: string;
      readonly to: ModerationStatus;
      readonly reason: HoldReason | null;
    };

// ---- repository -----------------------------------------------------------------------------

export interface KeysetPage {
  readonly after: KeysetPosition | null;
  readonly limit: number;
}

export type ActorKind = "system" | "moderator" | "author" | "reports";

export interface UgcItem {
  readonly type: UgcTargetType;
  readonly id: string;
  readonly status: ModerationStatus;
  readonly holdReason: HoldReason | null;
  readonly authorUserId: string;
  readonly storeId: string;
  readonly productId: string;
  /** Text the classifiers and moderators read. */
  readonly text: string;
  readonly photoIds: readonly string[];
  readonly createdAtMs: number;
}

export interface TransitionInput {
  readonly type: UgcTargetType;
  readonly id: string;
  readonly from: ModerationStatus;
  readonly to: ModerationStatus;
  readonly actorKind: ActorKind;
  readonly actorId: string | null;
  readonly reason: HoldReason | null;
  readonly nowMs: number;
  readonly logId: string;
  /** Questions: SLA length applied when the question first becomes visible. */
  readonly slaMs: number;
  /** Reviews: record that the (rating independent) reward intent is being emitted now. */
  readonly markRewardIntent: boolean;
  readonly events: readonly ReviewEvent[];
}

export interface ModerationLogEntry {
  readonly id: string;
  readonly targetType: UgcTargetType;
  readonly targetId: string;
  readonly from: ModerationStatus;
  readonly to: ModerationStatus;
  readonly actorKind: ActorKind;
  readonly actorId: string | null;
  readonly reason: string | null;
  readonly atMs: number;
}

export interface Report {
  readonly id: string;
  readonly targetType: UgcTargetType;
  readonly targetId: string;
  readonly reporterId: string;
  readonly reason: ReportReason;
  readonly createdAtMs: number;
}

export type EditResult =
  | { readonly kind: "ok"; readonly review: Review; readonly wasPublished: boolean }
  | { readonly kind: "not_found" }
  | { readonly kind: "busy" };

export interface ReviewStore {
  insertReview(review: Review, events: readonly ReviewEvent[]): Promise<"inserted" | "exists">;
  getReview(id: string): Promise<Review | null>;
  getReviewByOrderLine(orderLineId: string): Promise<Review | null>;
  editReview(input: {
    readonly id: string;
    readonly userId: string;
    readonly draft: ReviewDraft;
    readonly nowMs: number;
    readonly logId: string;
    readonly events: readonly ReviewEvent[];
  }): Promise<EditResult>;
  deleteReview(id: string, userId: string, events: readonly ReviewEvent[]): Promise<boolean>;
  listPublishedReviews(productId: string, page: KeysetPage): Promise<readonly Review[]>;
  listReviewsByUser(userId: string, page: KeysetPage): Promise<readonly Review[]>;
  listReviewsByStores(storeIds: readonly string[], page: KeysetPage): Promise<readonly Review[]>;
  /** Published reviews only. */
  ratingCounts(productId: string): Promise<RatingCounts>;

  upsertReply(reply: ReviewReply, logId: string): Promise<void>;
  getReply(reviewId: string): Promise<ReviewReply | null>;
  /** Published replies only, keyed by review id. */
  publishedReplies(reviewIds: readonly string[]): Promise<ReadonlyMap<string, ReviewReply>>;

  insertQuestion(question: Question): Promise<void>;
  getQuestion(id: string): Promise<Question | null>;
  listPublishedQuestions(productId: string, page: KeysetPage): Promise<readonly Question[]>;
  listQuestionsByStores(
    storeIds: readonly string[],
    filter: { readonly unansweredOnly: boolean },
    page: KeysetPage,
  ): Promise<readonly Question[]>;
  upsertAnswer(answer: Answer, logId: string): Promise<void>;
  getAnswer(id: string): Promise<Answer | null>;
  getAnswerByQuestionStore(questionId: string, storeId: string): Promise<Answer | null>;
  /** Published answers only, keyed by question id. */
  publishedAnswers(questionIds: readonly string[]): Promise<ReadonlyMap<string, readonly Answer[]>>;
  /** Published, unanswered, past due and not yet flagged. */
  listOverdueQuestions(nowMs: number, limit: number): Promise<readonly Question[]>;
  markSlaBreached(id: string, nowMs: number, events: readonly ReviewEvent[]): Promise<boolean>;

  getUgc(type: UgcTargetType, id: string): Promise<UgcItem | null>;
  transition(input: TransitionInput): Promise<"ok" | "stale">;
  listModeration(
    filter: { readonly statuses: readonly ModerationStatus[]; readonly type: UgcTargetType | null },
    page: KeysetPage,
  ): Promise<readonly UgcItem[]>;
  moderationLog(type: UgcTargetType, id: string): Promise<readonly ModerationLogEntry[]>;

  addReport(report: Report, events: readonly ReviewEvent[]): Promise<"added" | "duplicate">;
  countReportsBy(reporterId: string, sinceMs: number): Promise<number>;
  countDistinctReporters(type: UgcTargetType, id: string): Promise<number>;
}
