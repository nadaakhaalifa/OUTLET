import {
  checkReviewEligibility,
  summarizeRatings,
  validateReviewDraft,
  validateShortText,
  type FieldError,
  type ModerationStatus,
  type Review,
  type ReviewDraftInput,
  type ReviewReply,
  type ReviewSummary,
} from "../domain/bridge";
import type {
  PhotoUploadPort,
  PurchaseVerificationPort,
  ReviewEvent,
  ReviewerProfilePort,
  SellerIdentityPort,
} from "../domain/ports";
import type { ModerationPipeline } from "./moderation";
import { initialOf, keyset, type PageOutcome, type ReviewDeps } from "./shared";

export interface ReviewView {
  readonly review: Review;
  readonly reviewerInitial: string | null;
  /** Published reply only (the author and the store see their own pending reply elsewhere). */
  readonly reply: ReviewReply | null;
}

async function toViews(
  d: ReviewDeps,
  profiles: ReviewerProfilePort,
  reviews: readonly Review[],
): Promise<ReviewView[]> {
  const replies = await d.store.publishedReplies(reviews.map((r) => r.id));
  const out: ReviewView[] = [];
  for (const r of reviews) {
    out.push({ review: r, reviewerInitial: await initialOf(profiles, r.userId), reply: replies.get(r.id) ?? null });
  }
  return out;
}

export type SubmitResult =
  | { readonly kind: "created"; readonly view: ReviewView; readonly status: ModerationStatus }
  | { readonly kind: "invalid"; readonly errors: readonly FieldError[] }
  | { readonly kind: "not_found" }
  | { readonly kind: "self_review" }
  | { readonly kind: "window_elapsed" }
  | { readonly kind: "already_reviewed" }
  | { readonly kind: "invalid_photos" };

export interface ReviewPorts {
  readonly purchases: PurchaseVerificationPort;
  readonly sellers: SellerIdentityPort;
  readonly profiles: ReviewerProfilePort;
  readonly photos: PhotoUploadPort;
}

export class SubmitReview {
  constructor(
    private readonly d: ReviewDeps,
    private readonly p: ReviewPorts,
    private readonly pipeline: ModerationPipeline,
  ) {}

  async execute(input: {
    readonly userId: string;
    readonly actorStoreIds: readonly string[];
    readonly orderLineId: string;
    readonly draft: ReviewDraftInput;
  }): Promise<SubmitResult> {
    const v = validateReviewDraft(input.draft);
    if (!v.ok) return { kind: "invalid", errors: v.errors };
    const line = await this.p.purchases.findDeliveredLine(input.orderLineId);
    // Someone else's line and a missing line are the same answer (no probing of order ids).
    if (line === null || line.userId !== input.userId) return { kind: "not_found" };
    const owned = await this.p.sellers.storeIdsOf(input.userId);
    const elig = checkReviewEligibility({
      line,
      reviewerUserId: input.userId,
      reviewerStoreIds: [...owned, ...input.actorStoreIds],
      nowMs: this.d.clock.nowMs(),
      cfg: this.d.cfg,
    });
    if (!elig.ok) {
      if (elig.reason === "self_review") return { kind: "self_review" };
      if (elig.reason === "window_elapsed") return { kind: "window_elapsed" };
      return { kind: "not_found" };
    }
    if (v.value.photoIds.length > 0 && !(await this.p.photos.areOwnedImages(input.userId, v.value.photoIds))) {
      return { kind: "invalid_photos" };
    }
    const now = this.d.clock.nowMs();
    const review: Review = {
      id: this.d.ids.uuidV7(),
      orderLineId: line.orderLineId,
      userId: input.userId,
      storeId: line.storeId,
      productId: line.productId,
      rating: v.value.rating,
      title: v.value.title,
      body: v.value.body,
      purchasedSize: line.sizeLabel,
      fit: v.value.fit,
      fitArea: v.value.fitArea,
      photoIds: v.value.photoIds,
      status: "SUBMITTED",
      holdReason: null,
      rewardIntentAtMs: null,
      createdAtMs: now,
      updatedAtMs: now,
      publishedAtMs: null,
    };
    if ((await this.d.store.insertReview(review, [])) === "exists") return { kind: "already_reviewed" };
    const status = (await this.pipeline.run("review", review.id)) ?? "SUBMITTED";
    const fresh = (await this.d.store.getReview(review.id)) ?? review;
    const [view] = await toViews(this.d, this.p.profiles, [fresh]);
    return { kind: "created", status, view: view as ReviewView };
  }
}

export type EditResult =
  | { readonly kind: "ok"; readonly view: ReviewView }
  | { readonly kind: "invalid"; readonly errors: readonly FieldError[] }
  | { readonly kind: "invalid_photos" }
  | { readonly kind: "not_found" }
  | { readonly kind: "busy" };

export class EditReview {
  constructor(
    private readonly d: ReviewDeps,
    private readonly p: ReviewPorts,
    private readonly pipeline: ModerationPipeline,
  ) {}

  async execute(input: { readonly userId: string; readonly reviewId: string; readonly draft: ReviewDraftInput }): Promise<EditResult> {
    const v = validateReviewDraft(input.draft);
    if (!v.ok) return { kind: "invalid", errors: v.errors };
    const cur = await this.d.store.getReview(input.reviewId);
    if (cur === null || cur.userId !== input.userId) return { kind: "not_found" };
    if (v.value.photoIds.length > 0 && !(await this.p.photos.areOwnedImages(input.userId, v.value.photoIds))) {
      return { kind: "invalid_photos" };
    }
    const events: ReviewEvent[] =
      cur.status === "PUBLISHED"
        ? [{ type: "review.unpublished", reviewId: cur.id, productId: cur.productId, storeId: cur.storeId }]
        : [];
    const r = await this.d.store.editReview({
      id: cur.id,
      userId: input.userId,
      draft: v.value,
      nowMs: this.d.clock.nowMs(),
      logId: this.d.ids.uuidV7(),
      events,
    });
    if (r.kind !== "ok") return { kind: r.kind };
    await this.pipeline.run("review", cur.id);
    const fresh = (await this.d.store.getReview(cur.id)) ?? r.review;
    const [view] = await toViews(this.d, this.p.profiles, [fresh]);
    return { kind: "ok", view: view as ReviewView };
  }
}

export class DeleteReview {
  constructor(private readonly d: ReviewDeps) {}

  async execute(input: { readonly userId: string; readonly reviewId: string }): Promise<boolean> {
    const cur = await this.d.store.getReview(input.reviewId);
    if (cur === null || cur.userId !== input.userId) return false;
    const events: ReviewEvent[] =
      cur.status === "PUBLISHED"
        ? [{ type: "review.unpublished", reviewId: cur.id, productId: cur.productId, storeId: cur.storeId }]
        : [];
    return this.d.store.deleteReview(cur.id, input.userId, events);
  }
}

export type ProductReviewsResult =
  | {
      readonly kind: "ok";
      readonly items: readonly ReviewView[];
      readonly nextCursor: string | null;
      /** null below the minimum count: nothing is shown instead of a stub. */
      readonly summary: ReviewSummary | null;
    }
  | { readonly kind: "invalid_cursor" };

export class ListProductReviews {
  constructor(
    private readonly d: ReviewDeps,
    private readonly profiles: ReviewerProfilePort,
  ) {}

  async execute(productId: string, cursor: string | null, limit: number): Promise<ProductReviewsResult> {
    const page = await keyset(
      cursor,
      limit,
      (p) => this.d.store.listPublishedReviews(productId, p),
      (r) => ({ ms: r.publishedAtMs ?? 0, id: r.id }),
    );
    if (page.kind === "invalid_cursor") return page;
    const summary = summarizeRatings(await this.d.store.ratingCounts(productId), this.d.cfg);
    return { kind: "ok", items: await toViews(this.d, this.profiles, page.items), nextCursor: page.nextCursor, summary };
  }
}

export class ListMyReviews {
  constructor(private readonly d: ReviewDeps) {}

  async execute(userId: string, cursor: string | null, limit: number): Promise<PageOutcome<Review>> {
    return keyset(
      cursor,
      limit,
      (p) => this.d.store.listReviewsByUser(userId, p),
      (r) => ({ ms: r.createdAtMs, id: r.id }),
    );
  }
}

export class ListSellerReviews {
  constructor(
    private readonly d: ReviewDeps,
    private readonly profiles: ReviewerProfilePort,
  ) {}

  async execute(storeIds: readonly string[], cursor: string | null, limit: number): Promise<PageOutcome<ReviewView>> {
    const page = await keyset(
      cursor,
      limit,
      (p) => this.d.store.listReviewsByStores(storeIds, p),
      (r) => ({ ms: r.publishedAtMs ?? 0, id: r.id }),
    );
    if (page.kind === "invalid_cursor") return page;
    return { kind: "ok", items: await toViews(this.d, this.profiles, page.items), nextCursor: page.nextCursor };
  }
}

export type ReplyResult =
  | { readonly kind: "ok"; readonly status: ModerationStatus }
  | { readonly kind: "invalid"; readonly errors: readonly FieldError[] }
  | { readonly kind: "not_found" };

export class ReplyToReview {
  constructor(
    private readonly d: ReviewDeps,
    private readonly pipeline: ModerationPipeline,
  ) {}

  async execute(input: {
    readonly reviewId: string;
    readonly actorUserId: string;
    readonly actorStoreIds: readonly string[];
    readonly body: string;
  }): Promise<ReplyResult> {
    const review = await this.d.store.getReview(input.reviewId);
    // A review of another store, or one nobody can see yet, is a 404 for the seller.
    if (review === null || review.status !== "PUBLISHED" || !input.actorStoreIds.includes(review.storeId)) {
      return { kind: "not_found" };
    }
    const v = validateShortText("body", input.body, "reply");
    if (!v.ok) return { kind: "invalid", errors: v.errors };
    const now = this.d.clock.nowMs();
    await this.d.store.upsertReply(
      {
        reviewId: review.id,
        storeId: review.storeId,
        authorUserId: input.actorUserId,
        body: v.value,
        status: "SUBMITTED",
        holdReason: null,
        createdAtMs: now,
        updatedAtMs: now,
      },
      this.d.ids.uuidV7(),
    );
    const status = (await this.pipeline.run("review_reply", review.id)) ?? "SUBMITTED";
    return { kind: "ok", status };
  }
}
