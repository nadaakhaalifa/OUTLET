import {
  containsContactInfo,
  decideAutoModeration,
  reviewRewardIntent,
  transitionModeration,
  InvalidModerationTransitionError,
  type ImageScores,
  type HoldReason,
  type ModerationEvent,
  type ModerationStatus,
  type UgcTargetType,
} from "../domain/bridge";
import type {
  ActorKind,
  ImageClassifierPort,
  ReviewEvent,
  ToxicityClassifierPort,
  UgcItem,
} from "../domain/ports";
import { keyset, type PageOutcome, type ReviewDeps } from "./shared";

/**
 * Events and the reward flag that go with a status change, computed once so the automatic
 * pipeline, the human decision and the report auto-hold cannot drift apart.
 */
async function effects(
  d: ReviewDeps,
  item: UgcItem,
  to: ModerationStatus,
  reason: HoldReason | null,
  nowMs: number,
): Promise<{ events: ReviewEvent[]; markRewardIntent: boolean }> {
  const events: ReviewEvent[] = [{ type: "ugc.moderated", targetType: item.type, targetId: item.id, to, reason }];
  let markRewardIntent = false;
  if (to === "PUBLISHED") {
    if (item.type === "review") {
      const r = await d.store.getReview(item.id);
      if (r !== null) {
        events.push({ type: "review.published", reviewId: r.id, productId: r.productId, storeId: r.storeId, rating: r.rating });
        if (r.fit !== null) {
          events.push({
            type: "review.fit_feedback_submitted",
            reviewId: r.id,
            orderLineId: r.orderLineId,
            productId: r.productId,
            fit: r.fit,
            fitArea: r.fitArea,
            sizeLabel: r.purchasedSize,
          });
        }
        if (r.rewardIntentAtMs === null) {
          markRewardIntent = true;
          events.push({
            type: "review.reward_intent",
            reviewId: r.id,
            userId: r.userId,
            // The intent is built without the rating: the signature has no such parameter.
            intent: reviewRewardIntent({ orderLineId: r.orderLineId, photoCount: r.photoIds.length, fit: r.fit }),
            idempotencyKey: `review-reward:${r.id}`,
          });
        }
      }
    } else if (item.type === "question") {
      const q = await d.store.getQuestion(item.id);
      if (q !== null) {
        events.push({
          type: "qa.question_published",
          questionId: q.id,
          productId: q.productId,
          storeId: q.storeId,
          slaDueAtMs: q.slaDueAtMs ?? nowMs + d.cfg.qaResponseSlaMs,
        });
      }
    } else if (item.type === "answer") {
      const a = await d.store.getAnswer(item.id);
      if (a !== null) events.push({ type: "qa.question_answered", questionId: a.questionId, storeId: a.storeId });
    }
  } else if (item.status === "PUBLISHED" && item.type === "review") {
    events.push({ type: "review.unpublished", reviewId: item.id, productId: item.productId, storeId: item.storeId });
  }
  return { events, markRewardIntent };
}

/** One guarded status change with its events, log row and side effects. */
export async function changeStatus(
  d: ReviewDeps,
  item: UgcItem,
  to: ModerationStatus,
  by: { readonly kind: ActorKind; readonly id: string | null; readonly reason: HoldReason | null },
): Promise<"ok" | "stale"> {
  const nowMs = d.clock.nowMs();
  const fx = to === "AUTO_CHECKED" ? { events: [] as ReviewEvent[], markRewardIntent: false } : await effects(d, item, to, by.reason, nowMs);
  return d.store.transition({
    type: item.type,
    id: item.id,
    from: item.status,
    to,
    actorKind: by.kind,
    actorId: by.id,
    reason: by.reason,
    nowMs,
    logId: d.ids.uuidV7(),
    slaMs: d.cfg.qaResponseSlaMs,
    markRewardIntent: fx.markRewardIntent,
    events: fx.events,
  });
}

/**
 * SUBMITTED -> AUTO_CHECKED -> PUBLISHED | HELD | REJECTED. Classifier outages fail closed to
 * HELD, never to PUBLISHED. Safe to call again on an item stuck in SUBMITTED or AUTO_CHECKED.
 */
export class ModerationPipeline {
  constructor(
    private readonly d: ReviewDeps,
    private readonly toxicity: ToxicityClassifierPort,
    private readonly images: ImageClassifierPort,
  ) {}

  async run(type: UgcTargetType, id: string): Promise<ModerationStatus | null> {
    let item = await this.d.store.getUgc(type, id);
    if (item === null) return null;
    if (item.status === "SUBMITTED") {
      transitionModeration("SUBMITTED", "checks_done");
      if ((await changeStatus(this.d, item, "AUTO_CHECKED", { kind: "system", id: null, reason: null })) === "stale") {
        return (await this.d.store.getUgc(type, id))?.status ?? null;
      }
      item = { ...item, status: "AUTO_CHECKED" };
    }
    if (item.status !== "AUTO_CHECKED") return item.status;

    const decision = decideAutoModeration(
      {
        toxicity: await this.toxicityOf(item.text),
        images: await Promise.all(item.photoIds.map((p) => this.imageOf(p))),
        hasContactInfo: containsContactInfo(item.text),
      },
      this.d.cfg,
    );
    const to = transitionModeration("AUTO_CHECKED", decision.event);
    const r = await changeStatus(this.d, item, to, { kind: "system", id: null, reason: decision.reason });
    if (r === "stale") return (await this.d.store.getUgc(type, id))?.status ?? null;
    return to;
  }

  private async toxicityOf(text: string): Promise<number | "unavailable"> {
    try {
      const s = await this.toxicity.score(text);
      return Number.isFinite(s) ? s : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  private async imageOf(uploadId: string): Promise<ImageScores> {
    try {
      return await this.images.scores(uploadId);
    } catch {
      return "unavailable";
    }
  }
}

/** Re-runs items whose request died between SUBMITTED and the final state. */
export class ProcessModerationBacklog {
  constructor(
    private readonly d: ReviewDeps,
    private readonly pipeline: ModerationPipeline,
  ) {}

  async execute(limit = 100, olderThanMs = 60_000): Promise<number> {
    const cutoff = this.d.clock.nowMs() - olderThanMs;
    const stuck = await this.d.store.listModeration(
      { statuses: ["SUBMITTED", "AUTO_CHECKED"], type: null },
      { after: null, limit },
    );
    let n = 0;
    for (const item of stuck) {
      if (item.createdAtMs > cutoff) continue;
      await this.pipeline.run(item.type, item.id);
      n += 1;
    }
    return n;
  }
}

export interface QueueFilter {
  readonly status: ModerationStatus;
  readonly type: UgcTargetType | null;
}

export class ListModerationQueue {
  constructor(private readonly d: ReviewDeps) {}

  async execute(filter: QueueFilter, cursor: string | null, limit: number): Promise<PageOutcome<UgcItem>> {
    return keyset(
      cursor,
      limit,
      (page) => this.d.store.listModeration({ statuses: [filter.status], type: filter.type }, page),
      (i) => ({ ms: i.createdAtMs, id: i.id }),
    );
  }
}

export type DecisionResult =
  | { readonly kind: "ok"; readonly status: ModerationStatus }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid_transition"; readonly from: ModerationStatus }
  | { readonly kind: "conflict" };

export class DecideModeration {
  constructor(private readonly d: ReviewDeps) {}

  async execute(input: {
    readonly type: UgcTargetType;
    readonly id: string;
    readonly moderatorId: string;
    readonly decision: "publish" | "reject";
  }): Promise<DecisionResult> {
    const item = await this.d.store.getUgc(input.type, input.id);
    if (item === null) return { kind: "not_found" };
    const event: ModerationEvent = input.decision === "publish" ? "moderator_publish" : "moderator_reject";
    let to: ModerationStatus;
    try {
      to = transitionModeration(item.status, event);
    } catch (e) {
      if (e instanceof InvalidModerationTransitionError) return { kind: "invalid_transition", from: item.status };
      throw e;
    }
    const r = await changeStatus(this.d, item, to, {
      kind: "moderator",
      id: input.moderatorId,
      reason: to === "PUBLISHED" ? null : "moderator",
    });
    return r === "ok" ? { kind: "ok", status: to } : { kind: "conflict" };
  }
}
