import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { Authorize, AuthenticatedSelf, Idempotent, Public, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import { FIT_VALUES, REPORT_REASONS, UGC_TARGET_TYPES, type FieldError } from "../domain/bridge";
import type { DecideModeration, ListModerationQueue } from "../application/moderation";
import type { AnswerQuestion, AskQuestion, ListProductQuestions, ListSellerQuestions } from "../application/qa";
import type { ReportContent } from "../application/reports";
import type {
  DeleteReview,
  EditReview,
  ListMyReviews,
  ListProductReviews,
  ListSellerReviews,
  ReplyToReview,
  SubmitReview,
} from "../application/reviews";
import {
  ANSWER_QUESTION,
  ASK_QUESTION,
  DECIDE_MODERATION,
  DELETE_REVIEW,
  EDIT_REVIEW,
  LIST_MODERATION_QUEUE,
  LIST_MY_REVIEWS,
  LIST_PRODUCT_QUESTIONS,
  LIST_PRODUCT_REVIEWS,
  LIST_SELLER_QUESTIONS,
  LIST_SELLER_REVIEWS,
  REPLY_TO_REVIEW,
  REPORT_CONTENT,
  REVIEW_MODERATION_RESOLVER,
  REVIEW_ORDER_LINE_RESOLVER,
  REVIEW_OWN_RESOLVER,
  REVIEW_QUESTION_STORE_RESOLVER,
  REVIEW_STORE_LIST_RESOLVER,
  REVIEW_STORE_RESOLVER,
  SUBMIT_REVIEW,
} from "./tokens";
import { storeIdsOf } from "./resolvers";
import {
  moderationItemWire,
  ownReviewWire,
  publicQuestionWire,
  publicReviewWire,
  sellerQuestionWire,
  summaryWire,
} from "./wire";

const Id = z.uuid();
const Cursor = z.string().min(1).max(80);
const Limit = z.coerce.number().int().min(1).max(50).default(20);

const ReviewFields = {
  rating: z.number().int().min(1).max(5),
  title: z.string().max(400).nullish(),
  body: z.string().min(1).max(8000),
  fit: z.enum(FIT_VALUES).nullish(),
  fit_area: z.string().max(200).nullish(),
  photo_ids: z.array(z.string().max(64)).max(20).optional(),
};
const CreateReviewBody = z.object(ReviewFields).strict();
const EditReviewBody = z.object(ReviewFields).strict();
const TextBody = z.object({ body: z.string().min(1).max(8000) }).strict();
const ListQuery = z.object({ cursor: Cursor.optional(), limit: Limit }).strict();
const SellerQuestionsQuery = z
  .object({ cursor: Cursor.optional(), limit: Limit, unanswered: z.enum(["true", "false"]).optional() })
  .strict();
const ReportBody = z
  .object({ target_type: z.enum(UGC_TARGET_TYPES), target_id: Id, reason: z.enum(REPORT_REASONS) })
  .strict();
const QueueQuery = z
  .object({
    status: z.enum(["HELD", "SUBMITTED", "AUTO_CHECKED"]).default("HELD"),
    target_type: z.enum(UGC_TARGET_TYPES).optional(),
    cursor: Cursor.optional(),
    limit: Limit,
  })
  .strict();
const DecisionParams = z.object({ targetType: z.enum(UGC_TARGET_TYPES), targetId: Id }).strict();
const DecisionBody = z.object({ decision: z.enum(["publish", "reject"]) }).strict();

const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};

const fieldProblem = (errors: readonly FieldError[]): ProblemError =>
  Problems.validation(errors.map((e) => ({ pointer: `/body/${e.field}`, code: e.code })));

const invalidCursor = (): ProblemError =>
  new ProblemError(400, "validation-failed", "Request validation failed", {
    code: "invalid_cursor",
    errors: [{ pointer: "/query/cursor", code: "invalid_cursor" }],
  });

const unprocessable = (code: string, title: string): ProblemError =>
  new ProblemError(422, code.replaceAll("_", "-"), title, { code });

const MODERATOR_ROLES = ["trust_safety", "ops", "super_admin"] as const;

@Controller()
export class ReviewsController {
  constructor(
    @Inject(SUBMIT_REVIEW) private readonly submit: SubmitReview,
    @Inject(EDIT_REVIEW) private readonly edit: EditReview,
    @Inject(DELETE_REVIEW) private readonly remove: DeleteReview,
    @Inject(LIST_PRODUCT_REVIEWS) private readonly productReviews: ListProductReviews,
    @Inject(LIST_MY_REVIEWS) private readonly myReviews: ListMyReviews,
    @Inject(LIST_SELLER_REVIEWS) private readonly sellerReviews: ListSellerReviews,
    @Inject(REPLY_TO_REVIEW) private readonly reply: ReplyToReview,
    @Inject(ASK_QUESTION) private readonly ask: AskQuestion,
    @Inject(LIST_PRODUCT_QUESTIONS) private readonly productQuestions: ListProductQuestions,
    @Inject(LIST_SELLER_QUESTIONS) private readonly sellerQuestions: ListSellerQuestions,
    @Inject(ANSWER_QUESTION) private readonly answer: AnswerQuestion,
    @Inject(REPORT_CONTENT) private readonly report: ReportContent,
    @Inject(LIST_MODERATION_QUEUE) private readonly queue: ListModerationQueue,
    @Inject(DECIDE_MODERATION) private readonly decide: DecideModeration,
  ) {}

  // ---- buyer: reviews ----

  @Post("orders/lines/:orderLineId/review")
  @Authorize({ action: "create", resourceType: "review", resolver: REVIEW_ORDER_LINE_RESOLVER, idParam: "orderLineId" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  async create(
    @Req() req: ApiRequest,
    @Param("orderLineId") orderLineId: string,
    @Body(new ZodPipe(CreateReviewBody)) b: z.infer<typeof CreateReviewBody>,
  ) {
    const actor = principalOf(req).actor;
    const r = await this.submit.execute({
      userId: actor.id,
      actorStoreIds: storeIdsOf(actor),
      orderLineId: orderLineId.toLowerCase(),
      draft: {
        rating: b.rating,
        title: b.title ?? null,
        body: b.body,
        fit: b.fit ?? null,
        fitArea: b.fit_area ?? null,
        photoIds: b.photo_ids ?? [],
      },
    });
    switch (r.kind) {
      case "created":
        return { ...ownReviewWire(r.view.review) };
      case "invalid":
        throw fieldProblem(r.errors);
      case "not_found":
        throw Problems.notFound();
      case "self_review":
        throw unprocessable("self_review_forbidden", "A seller cannot review its own products");
      case "window_elapsed":
        throw unprocessable("review_window_elapsed", "The review window for this item has ended");
      case "already_reviewed":
        throw new ProblemError(409, "already-reviewed", "This item already has a review", { code: "already_reviewed" });
      case "invalid_photos":
        throw Problems.validation([{ pointer: "/body/photo_ids", code: "invalid" }]);
    }
  }

  @Get("me/reviews")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async mine(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) q: z.infer<typeof ListQuery>) {
    const r = await this.myReviews.execute(principalOf(req).actor.id, q.cursor ?? null, q.limit);
    if (r.kind === "invalid_cursor") throw invalidCursor();
    return { items: r.items.map(ownReviewWire), page: { next_cursor: r.nextCursor, has_more: r.nextCursor !== null } };
  }

  @Patch("me/reviews/:reviewId")
  @Authorize({ action: "update", resourceType: "review", resolver: REVIEW_OWN_RESOLVER, idParam: "reviewId" })
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  async update(
    @Req() req: ApiRequest,
    @Param("reviewId") reviewId: string,
    @Body(new ZodPipe(EditReviewBody)) b: z.infer<typeof EditReviewBody>,
  ) {
    const r = await this.edit.execute({
      userId: principalOf(req).actor.id,
      reviewId: reviewId.toLowerCase(),
      draft: {
        rating: b.rating,
        title: b.title ?? null,
        body: b.body,
        fit: b.fit ?? null,
        fitArea: b.fit_area ?? null,
        photoIds: b.photo_ids ?? [],
      },
    });
    switch (r.kind) {
      case "ok":
        return ownReviewWire(r.view.review);
      case "invalid":
        throw fieldProblem(r.errors);
      case "invalid_photos":
        throw Problems.validation([{ pointer: "/body/photo_ids", code: "invalid" }]);
      case "not_found":
        throw Problems.notFound();
      case "busy":
        throw new ProblemError(409, "review-busy", "The review is being checked, try again shortly", { code: "review_busy" });
    }
  }

  @Delete("me/reviews/:reviewId")
  @HttpCode(204)
  @Authorize({ action: "delete", resourceType: "review", resolver: REVIEW_OWN_RESOLVER, idParam: "reviewId" })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  async destroy(@Req() req: ApiRequest, @Param("reviewId") reviewId: string): Promise<void> {
    const ok = await this.remove.execute({ userId: principalOf(req).actor.id, reviewId: reviewId.toLowerCase() });
    if (!ok) throw Problems.notFound();
  }

  // ---- public: product reviews and Q&A ----

  @Get("products/:productId/reviews")
  @Public()
  @RateLimit([{ dimension: "ip", limit: 120, windowSeconds: 60 }])
  async productList(
    @Param(new ZodPipe(z.object({ productId: Id }).strict(), "/params")) p: { productId: string },
    @Query(new ZodPipe(ListQuery, "/query")) q: z.infer<typeof ListQuery>,
  ) {
    const r = await this.productReviews.execute(p.productId.toLowerCase(), q.cursor ?? null, q.limit);
    if (r.kind === "invalid_cursor") throw invalidCursor();
    return {
      summary: summaryWire(r.summary),
      items: r.items.map(publicReviewWire),
      page: { next_cursor: r.nextCursor, has_more: r.nextCursor !== null },
    };
  }

  @Get("products/:productId/questions")
  @Public()
  @RateLimit([{ dimension: "ip", limit: 120, windowSeconds: 60 }])
  async questionList(
    @Param(new ZodPipe(z.object({ productId: Id }).strict(), "/params")) p: { productId: string },
    @Query(new ZodPipe(ListQuery, "/query")) q: z.infer<typeof ListQuery>,
  ) {
    const r = await this.productQuestions.execute(p.productId.toLowerCase(), q.cursor ?? null, q.limit);
    if (r.kind === "invalid_cursor") throw invalidCursor();
    return { items: r.items.map(publicQuestionWire), page: { next_cursor: r.nextCursor, has_more: r.nextCursor !== null } };
  }

  @Post("products/:productId/questions")
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async askQuestion(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(z.object({ productId: Id }).strict(), "/params")) p: { productId: string },
    @Body(new ZodPipe(TextBody)) b: z.infer<typeof TextBody>,
  ) {
    const r = await this.ask.execute({
      userId: principalOf(req).actor.id,
      productId: p.productId.toLowerCase(),
      body: b.body,
    });
    switch (r.kind) {
      case "ok":
        return { id: r.id, moderation_status: r.status };
      case "invalid":
        throw fieldProblem(r.errors);
      case "not_found":
        throw Problems.notFound();
    }
  }

  // ---- reports ----

  @Post("ugc/reports")
  @HttpCode(202)
  @AuthenticatedSelf()
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 3600 }])
  async reportItem(@Req() req: ApiRequest, @Body(new ZodPipe(ReportBody)) b: z.infer<typeof ReportBody>) {
    const r = await this.report.execute({
      reporterId: principalOf(req).actor.id,
      targetType: b.target_type,
      targetId: b.target_id.toLowerCase(),
      reason: b.reason,
    });
    switch (r.kind) {
      case "accepted":
        return { accepted: true };
      case "not_found":
        throw Problems.notFound();
      case "own_content":
        throw unprocessable("own_content", "You cannot report your own content");
      case "rate_limited":
        throw Problems.rateLimited(3600);
    }
  }

  // ---- seller ----

  @Get("seller/reviews")
  @Authorize({
    audience: "seller_api",
    action: "read",
    resourceType: "store_product",
    resolver: REVIEW_STORE_LIST_RESOLVER,
    idParam: "none",
  })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async sellerReviewList(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) q: z.infer<typeof ListQuery>) {
    const r = await this.sellerReviews.execute(storeIdsOf(principalOf(req).actor), q.cursor ?? null, q.limit);
    if (r.kind === "invalid_cursor") throw invalidCursor();
    return { items: r.items.map(publicReviewWire), page: { next_cursor: r.nextCursor, has_more: r.nextCursor !== null } };
  }

  @Post("seller/reviews/:reviewId/reply")
  @HttpCode(200)
  @Authorize({
    audience: "seller_api",
    action: "update",
    resourceType: "store_product",
    resolver: REVIEW_STORE_RESOLVER,
    idParam: "reviewId",
  })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async sellerReply(
    @Req() req: ApiRequest,
    @Param("reviewId") reviewId: string,
    @Body(new ZodPipe(TextBody)) b: z.infer<typeof TextBody>,
  ) {
    const actor = principalOf(req).actor;
    const r = await this.reply.execute({
      reviewId: reviewId.toLowerCase(),
      actorUserId: actor.id,
      actorStoreIds: storeIdsOf(actor),
      body: b.body,
    });
    switch (r.kind) {
      case "ok":
        return { moderation_status: r.status };
      case "invalid":
        throw fieldProblem(r.errors);
      case "not_found":
        throw Problems.notFound();
    }
  }

  @Get("seller/questions")
  @Authorize({
    audience: "seller_api",
    action: "read",
    resourceType: "store_product",
    resolver: REVIEW_STORE_LIST_RESOLVER,
    idParam: "none",
  })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async sellerQuestionList(
    @Req() req: ApiRequest,
    @Query(new ZodPipe(SellerQuestionsQuery, "/query")) q: z.infer<typeof SellerQuestionsQuery>,
  ) {
    const r = await this.sellerQuestions.execute(
      storeIdsOf(principalOf(req).actor),
      q.unanswered === "true",
      q.cursor ?? null,
      q.limit,
    );
    if (r.kind === "invalid_cursor") throw invalidCursor();
    return { items: r.items.map(sellerQuestionWire), page: { next_cursor: r.nextCursor, has_more: r.nextCursor !== null } };
  }

  @Post("seller/questions/:questionId/answer")
  @HttpCode(200)
  @Authorize({
    audience: "seller_api",
    action: "update",
    resourceType: "store_product",
    resolver: REVIEW_QUESTION_STORE_RESOLVER,
    idParam: "questionId",
  })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async sellerAnswer(
    @Req() req: ApiRequest,
    @Param("questionId") questionId: string,
    @Body(new ZodPipe(TextBody)) b: z.infer<typeof TextBody>,
  ) {
    const actor = principalOf(req).actor;
    const r = await this.answer.execute({
      questionId: questionId.toLowerCase(),
      actorUserId: actor.id,
      actorStoreIds: storeIdsOf(actor),
      body: b.body,
    });
    switch (r.kind) {
      case "ok":
        return { moderation_status: r.status };
      case "invalid":
        throw fieldProblem(r.errors);
      case "not_found":
        throw Problems.notFound();
    }
  }

  // ---- admin moderation ----

  private requireModerator(req: ApiRequest): string {
    const actor = principalOf(req).actor;
    const ok = actor.grants.some((g) => g.kind === "admin" && (MODERATOR_ROLES as readonly string[]).includes(g.role));
    if (!ok) throw Problems.forbidden();
    return actor.id;
  }

  @Get("admin/moderation/queue")
  @Authorize({
    audience: "admin_api",
    action: "read",
    resourceType: "admin_console",
    resolver: REVIEW_MODERATION_RESOLVER,
    idParam: "none",
  })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async moderationQueue(@Req() req: ApiRequest, @Query(new ZodPipe(QueueQuery, "/query")) q: z.infer<typeof QueueQuery>) {
    this.requireModerator(req);
    const r = await this.queue.execute({ status: q.status, type: q.target_type ?? null }, q.cursor ?? null, q.limit);
    if (r.kind === "invalid_cursor") throw invalidCursor();
    return { items: r.items.map(moderationItemWire), page: { next_cursor: r.nextCursor, has_more: r.nextCursor !== null } };
  }

  @Post("admin/moderation/:targetType/:targetId/decision")
  @HttpCode(200)
  @Authorize({
    audience: "admin_api",
    action: "read",
    resourceType: "admin_console",
    resolver: REVIEW_MODERATION_RESOLVER,
    idParam: "none",
  })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async moderationDecision(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(DecisionParams, "/params")) p: z.infer<typeof DecisionParams>,
    @Body(new ZodPipe(DecisionBody)) b: z.infer<typeof DecisionBody>,
  ) {
    const moderatorId = this.requireModerator(req);
    const r = await this.decide.execute({
      type: p.targetType,
      id: p.targetId.toLowerCase(),
      moderatorId,
      decision: b.decision,
    });
    switch (r.kind) {
      case "ok":
        return { status: r.status };
      case "not_found":
        throw Problems.notFound();
      case "invalid_transition":
        throw new ProblemError(409, "invalid-transition", "This item cannot move to that state", {
          code: "invalid_transition",
        });
      case "conflict":
        throw new ProblemError(409, "conflict", "The item changed, reload and retry", { code: "conflict" });
    }
  }
}
