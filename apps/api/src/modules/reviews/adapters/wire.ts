import type { Answer, ModerationStatus, Review, ReviewSummary } from "../domain/bridge";
import type { UgcItem } from "../domain/ports";
import type { QuestionView } from "../application/qa";
import type { ReviewView } from "../application/reviews";

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Public payload rules (PDPL): no user id, no store staff id, no order line id. The reviewer is
 * the initial of the first name or null. Photos are opaque upload ids.
 */
export function publicReviewWire(v: ReviewView) {
  const r = v.review;
  return {
    id: r.id,
    rating: r.rating,
    title: r.title,
    body: r.body,
    purchased_size: r.purchasedSize,
    fit: r.fit,
    fit_area: r.fitArea,
    photo_ids: r.photoIds,
    verified_purchase: true as const,
    reviewer_initial: v.reviewerInitial,
    published_at: r.publishedAtMs === null ? null : iso(r.publishedAtMs),
    seller_reply: v.reply === null ? null : { body: v.reply.body, replied_at: iso(v.reply.updatedAtMs) },
  };
}

/** The author sees the moderation state of their own review, never anyone else's. */
export function ownReviewWire(r: Review) {
  return {
    id: r.id,
    product_id: r.productId,
    rating: r.rating,
    title: r.title,
    body: r.body,
    purchased_size: r.purchasedSize,
    fit: r.fit,
    fit_area: r.fitArea,
    photo_ids: r.photoIds,
    moderation_status: r.status,
    created_at: iso(r.createdAtMs),
    published_at: r.publishedAtMs === null ? null : iso(r.publishedAtMs),
  };
}

export function summaryWire(s: ReviewSummary | null) {
  if (s === null) return null;
  const [one, two, three, four, five] = s.distribution;
  return {
    count: s.count,
    average: s.averageTenths / 10,
    distribution: { "1": one, "2": two, "3": three, "4": four, "5": five },
  };
}

const answerWire = (a: Answer) => ({ id: a.id, body: a.body, answered_at: iso(a.updatedAtMs), by: "seller" as const });

export function publicQuestionWire(v: QuestionView) {
  const q = v.question;
  return {
    id: q.id,
    body: q.body,
    asker_initial: v.askerInitial,
    asked_at: q.publishedAtMs === null ? null : iso(q.publishedAtMs),
    answers: v.answers.map(answerWire),
  };
}

/** Seller view: same public content plus the SLA clock. No asker identity beyond the initial. */
export function sellerQuestionWire(v: QuestionView) {
  const q = v.question;
  return {
    ...publicQuestionWire(v),
    answered: q.answeredAtMs !== null,
    sla_due_at: q.slaDueAtMs === null ? null : iso(q.slaDueAtMs),
    sla_overdue: v.overdue,
  };
}

export function moderationItemWire(i: UgcItem) {
  return {
    target_type: i.type,
    target_id: i.id,
    status: i.status,
    hold_reason: i.holdReason,
    text: i.text,
    photo_ids: i.photoIds,
    product_id: i.productId,
    store_id: i.storeId,
    created_at: iso(i.createdAtMs),
  };
}

export type { ModerationStatus };
