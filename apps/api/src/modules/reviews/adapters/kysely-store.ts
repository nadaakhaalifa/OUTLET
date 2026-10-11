import { sql, type Kysely } from "kysely";
import { z } from "zod";
import {
  FIT_VALUES,
  HOLD_REASONS,
  MODERATION_STATUSES,
  UGC_TARGET_TYPES,
  type Answer,
  type KeysetPosition,
  type ModerationStatus,
  type Question,
  type RatingCounts,
  type Review,
  type ReviewReply,
  type UgcTargetType,
} from "../domain/bridge";
import type {
  EditResult,
  IdPort,
  KeysetPage,
  ModerationLogEntry,
  Report,
  ReviewEvent,
  ReviewStore,
  TransitionInput,
  UgcItem,
} from "../domain/ports";

/** Raw SQL with Zod validated rows, as in the wishlists and referrals adapters. */
export type ReviewDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const Status = z.enum(MODERATION_STATUSES);
const Hold = z.enum(HOLD_REASONS).nullable();

const ReviewRow = z.object({
  id: z.string(),
  order_line_id: z.string(),
  user_id: z.string(),
  store_id: z.string(),
  product_id: z.string(),
  rating: z.number().int(),
  title: z.string().nullable(),
  body: z.string(),
  purchased_size: z.string().nullable(),
  fit: z.enum(FIT_VALUES).nullable(),
  fit_area: z.string().nullable(),
  photo_ids: z.array(z.string()),
  status: Status,
  hold_reason: Hold,
  reward_ms: Ms.nullable(),
  created_ms: Ms,
  updated_ms: Ms,
  published_ms: Ms.nullable(),
});

const ReplyRow = z.object({
  review_id: z.string(),
  store_id: z.string(),
  author_user_id: z.string(),
  body: z.string(),
  status: Status,
  hold_reason: Hold,
  created_ms: Ms,
  updated_ms: Ms,
});

const QuestionRow = z.object({
  id: z.string(),
  product_id: z.string(),
  store_id: z.string(),
  user_id: z.string(),
  body: z.string(),
  status: Status,
  hold_reason: Hold,
  created_ms: Ms,
  published_ms: Ms.nullable(),
  sla_due_ms: Ms.nullable(),
  answered_ms: Ms.nullable(),
  breached_ms: Ms.nullable(),
});

const AnswerRow = z.object({
  id: z.string(),
  question_id: z.string(),
  store_id: z.string(),
  author_user_id: z.string(),
  body: z.string(),
  status: Status,
  hold_reason: Hold,
  created_ms: Ms,
  updated_ms: Ms,
});

const LogRow = z.object({
  id: z.string(),
  target_type: z.enum(UGC_TARGET_TYPES),
  target_id: z.string(),
  from_status: Status,
  to_status: Status,
  actor_kind: z.enum(["system", "moderator", "author", "reports"]),
  actor_id: z.string().nullable(),
  reason: z.string().nullable(),
  at_ms: Ms,
});

const EPOCH_MS = (col: string) => sql.raw(`floor(extract(epoch from ${col}) * 1000)::text`);
const REVIEW_COLS = sql`id::text as id, order_line_id::text as order_line_id, user_id::text as user_id,
  store_id::text as store_id, product_id::text as product_id, rating::int as rating, title, body,
  purchased_size, fit, fit_area, photo_ids, status, hold_reason,
  ${EPOCH_MS("reward_intent_at")} as reward_ms, ${EPOCH_MS("created_at")} as created_ms,
  ${EPOCH_MS("updated_at")} as updated_ms, ${EPOCH_MS("published_at")} as published_ms`;
const REPLY_COLS = sql`review_id::text as review_id, store_id::text as store_id,
  author_user_id::text as author_user_id, body, status, hold_reason,
  ${EPOCH_MS("created_at")} as created_ms, ${EPOCH_MS("updated_at")} as updated_ms`;
const QUESTION_COLS = sql`id::text as id, product_id::text as product_id, store_id::text as store_id,
  user_id::text as user_id, body, status, hold_reason, ${EPOCH_MS("created_at")} as created_ms,
  ${EPOCH_MS("published_at")} as published_ms, ${EPOCH_MS("sla_due_at")} as sla_due_ms,
  ${EPOCH_MS("answered_at")} as answered_ms, ${EPOCH_MS("sla_breached_at")} as breached_ms`;
const ANSWER_COLS = sql`id::text as id, question_id::text as question_id, store_id::text as store_id,
  author_user_id::text as author_user_id, body, status, hold_reason,
  ${EPOCH_MS("created_at")} as created_ms, ${EPOCH_MS("updated_at")} as updated_ms`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (ms: number): string => new Date(ms).toISOString();
const NIL = "00000000-0000-0000-0000-000000000000";

const toReview = (raw: unknown): Review => {
  const r = ReviewRow.parse(raw);
  return {
    id: r.id,
    orderLineId: r.order_line_id,
    userId: r.user_id,
    storeId: r.store_id,
    productId: r.product_id,
    rating: r.rating,
    title: r.title,
    body: r.body,
    purchasedSize: r.purchased_size,
    fit: r.fit,
    fitArea: r.fit_area,
    photoIds: r.photo_ids,
    status: r.status,
    holdReason: r.hold_reason,
    rewardIntentAtMs: r.reward_ms,
    createdAtMs: r.created_ms,
    updatedAtMs: r.updated_ms,
    publishedAtMs: r.published_ms,
  };
};
const toReply = (raw: unknown): ReviewReply => {
  const r = ReplyRow.parse(raw);
  return {
    reviewId: r.review_id,
    storeId: r.store_id,
    authorUserId: r.author_user_id,
    body: r.body,
    status: r.status,
    holdReason: r.hold_reason,
    createdAtMs: r.created_ms,
    updatedAtMs: r.updated_ms,
  };
};
const toQuestion = (raw: unknown): Question => {
  const r = QuestionRow.parse(raw);
  return {
    id: r.id,
    productId: r.product_id,
    storeId: r.store_id,
    userId: r.user_id,
    body: r.body,
    status: r.status,
    holdReason: r.hold_reason,
    createdAtMs: r.created_ms,
    publishedAtMs: r.published_ms,
    slaDueAtMs: r.sla_due_ms,
    answeredAtMs: r.answered_ms,
    slaBreachedAtMs: r.breached_ms,
  };
};
const toAnswer = (raw: unknown): Answer => {
  const r = AnswerRow.parse(raw);
  return {
    id: r.id,
    questionId: r.question_id,
    storeId: r.store_id,
    authorUserId: r.author_user_id,
    body: r.body,
    status: r.status,
    holdReason: r.hold_reason,
    createdAtMs: r.created_ms,
    updatedAtMs: r.updated_ms,
  };
};

const aggregateOf = (e: ReviewEvent): { type: string; id: string } => {
  switch (e.type) {
    case "review.published":
    case "review.unpublished":
    case "review.fit_feedback_submitted":
    case "review.reward_intent":
      return { type: "review", id: e.reviewId };
    case "qa.question_published":
    case "qa.question_answered":
    case "qa.sla_breached":
      return { type: "question", id: e.questionId };
    case "ugc.reported":
    case "ugc.moderated":
      return { type: e.targetType, id: e.targetId };
  }
};

/** Outbox payload: ids, enums and counters only. No text, no names, no contact data. */
const payloadOf = (e: ReviewEvent): Record<string, string | number | boolean | null> => {
  switch (e.type) {
    case "review.published":
      return { review_id: e.reviewId, product_id: e.productId, store_id: e.storeId, rating: e.rating };
    case "review.unpublished":
      return { review_id: e.reviewId, product_id: e.productId, store_id: e.storeId };
    case "review.fit_feedback_submitted":
      return {
        review_id: e.reviewId,
        order_line_id: e.orderLineId,
        product_id: e.productId,
        fit: e.fit,
        fit_area: e.fitArea,
        size_label: e.sizeLabel,
      };
    case "review.reward_intent":
      return {
        review_id: e.reviewId,
        user_id: e.userId,
        order_line_id: e.intent.orderLineId,
        kind: e.intent.kind,
        has_photo: e.intent.hasPhoto,
        has_fit_info: e.intent.hasFitInfo,
        idempotency_key: e.idempotencyKey,
      };
    case "qa.question_published":
      return { question_id: e.questionId, product_id: e.productId, store_id: e.storeId, sla_due_at_ms: e.slaDueAtMs };
    case "qa.question_answered":
      return { question_id: e.questionId, store_id: e.storeId };
    case "qa.sla_breached":
      return { question_id: e.questionId, store_id: e.storeId, due_at_ms: e.dueAtMs };
    case "ugc.reported":
      return { target_type: e.targetType, target_id: e.targetId, reason: e.reason };
    case "ugc.moderated":
      return { target_type: e.targetType, target_id: e.targetId, to: e.to, reason: e.reason };
  }
};

const after = (p: KeysetPosition | null): { ts: string; id: string } | null =>
  p === null ? null : { ts: iso(p.ms), id: p.id };

/**
 * Postgres adapter. One transaction per method under the `system` role (authorization is the
 * policy guard; RLS stays on for every other role). Outbox rows are written in the same
 * transaction as the state change.
 */
export class KyselyReviewStore implements ReviewStore {
  constructor(
    private readonly db: ReviewDb,
    private readonly ids: IdPort,
  ) {}

  private async tx<T>(run: (trx: ReviewDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as ReviewDb);
    });
  }

  private async emit(trx: ReviewDb, events: readonly ReviewEvent[]): Promise<void> {
    for (const e of events) {
      const agg = aggregateOf(e);
      await sql`
        insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${this.ids.uuidV7()}::uuid, ${agg.type}, ${agg.id}::uuid, ${e.type},
                ${`${agg.type}:${agg.id}`}, ${JSON.stringify(payloadOf(e))}::jsonb)`.execute(trx);
    }
  }

  private async log(
    trx: ReviewDb,
    e: {
      id: string;
      type: UgcTargetType;
      targetId: string;
      from: ModerationStatus;
      to: ModerationStatus;
      actorKind: string;
      actorId: string | null;
      reason: string | null;
      atMs: number;
    },
  ): Promise<void> {
    await sql`
      insert into moderation_log (id, target_type, target_id, from_status, to_status, actor_kind, actor_id, reason, created_at)
      values (${e.id}::uuid, ${e.type}, ${e.targetId}::uuid, ${e.from}, ${e.to}, ${e.actorKind},
              ${e.actorId}::uuid, ${e.reason}, ${iso(e.atMs)}::timestamptz)`.execute(trx);
  }

  // ---- reviews ----

  async insertReview(r: Review, events: readonly ReviewEvent[]): Promise<"inserted" | "exists"> {
    return this.tx(async (trx) => {
      const res = await sql<{ id: string }>`
        insert into reviews (id, order_line_id, user_id, store_id, product_id, rating, title, body,
          purchased_size, fit, fit_area, photo_ids, status, hold_reason, reward_intent_at,
          created_at, updated_at, published_at)
        values (${r.id}::uuid, ${r.orderLineId}::uuid, ${r.userId}::uuid, ${r.storeId}::uuid,
          ${r.productId}::uuid, ${r.rating}, ${r.title}, ${r.body}, ${r.purchasedSize}, ${r.fit},
          ${r.fitArea}, ${JSON.stringify(r.photoIds)}::jsonb, ${r.status}, ${r.holdReason},
          ${r.rewardIntentAtMs === null ? null : iso(r.rewardIntentAtMs)}::timestamptz,
          ${iso(r.createdAtMs)}::timestamptz, ${iso(r.updatedAtMs)}::timestamptz,
          ${r.publishedAtMs === null ? null : iso(r.publishedAtMs)}::timestamptz)
        on conflict (order_line_id) do nothing
        returning id::text as id`.execute(trx);
      if (res.rows[0] === undefined) return "exists";
      await this.emit(trx, events);
      return "inserted";
    });
  }

  async getReview(id: string): Promise<Review | null> {
    if (!UUID.test(id)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${REVIEW_COLS} from reviews where id = ${id}::uuid`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toReview(row);
    });
  }

  async getReviewByOrderLine(orderLineId: string): Promise<Review | null> {
    if (!UUID.test(orderLineId)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${REVIEW_COLS} from reviews where order_line_id = ${orderLineId}::uuid`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toReview(row);
    });
  }

  async editReview(input: Parameters<ReviewStore["editReview"]>[0]): Promise<EditResult> {
    if (!UUID.test(input.id) || !UUID.test(input.userId)) return { kind: "not_found" };
    return this.tx(async (trx): Promise<EditResult> => {
      const cur = await sql<{ status: ModerationStatus }>`
        select status from reviews where id = ${input.id}::uuid and user_id = ${input.userId}::uuid for update`.execute(trx);
      const was = cur.rows[0]?.status;
      if (was === undefined) return { kind: "not_found" };
      if (was === "SUBMITTED" || was === "AUTO_CHECKED") return { kind: "busy" };
      const d = input.draft;
      const upd = await sql<unknown>`
        update reviews set rating = ${d.rating}, title = ${d.title}, body = ${d.body}, fit = ${d.fit},
          fit_area = ${d.fitArea}, photo_ids = ${JSON.stringify(d.photoIds)}::jsonb,
          status = 'SUBMITTED', hold_reason = null, updated_at = ${iso(input.nowMs)}::timestamptz
        where id = ${input.id}::uuid
        returning ${REVIEW_COLS}`.execute(trx);
      const row = upd.rows[0];
      if (row === undefined) return { kind: "not_found" };
      await this.log(trx, {
        id: input.logId,
        type: "review",
        targetId: input.id,
        from: was,
        to: "SUBMITTED",
        actorKind: "author",
        actorId: input.userId,
        reason: null,
        atMs: input.nowMs,
      });
      await this.emit(trx, input.events);
      return { kind: "ok", review: toReview(row), wasPublished: was === "PUBLISHED" };
    });
  }

  async deleteReview(id: string, userId: string, events: readonly ReviewEvent[]): Promise<boolean> {
    if (!UUID.test(id) || !UUID.test(userId)) return false;
    return this.tx(async (trx) => {
      const r = await sql<{ id: string }>`
        delete from reviews where id = ${id}::uuid and user_id = ${userId}::uuid returning id::text as id`.execute(trx);
      if (r.rows[0] === undefined) return false;
      await this.emit(trx, events);
      return true;
    });
  }

  async listPublishedReviews(productId: string, page: KeysetPage): Promise<readonly Review[]> {
    if (!UUID.test(productId)) return [];
    const a = after(page.after);
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${REVIEW_COLS} from reviews
        where product_id = ${productId}::uuid and status = 'PUBLISHED'
          and (${a === null}::boolean or (published_at, id) < (${a?.ts ?? iso(0)}::timestamptz, ${a?.id ?? NIL}::uuid))
        order by published_at desc, id desc limit ${page.limit}`.execute(trx);
      return r.rows.map(toReview);
    });
  }

  async listReviewsByUser(userId: string, page: KeysetPage): Promise<readonly Review[]> {
    if (!UUID.test(userId)) return [];
    const a = after(page.after);
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${REVIEW_COLS} from reviews
        where user_id = ${userId}::uuid
          and (${a === null}::boolean or (created_at, id) < (${a?.ts ?? iso(0)}::timestamptz, ${a?.id ?? NIL}::uuid))
        order by created_at desc, id desc limit ${page.limit}`.execute(trx);
      return r.rows.map(toReview);
    });
  }

  async listReviewsByStores(storeIds: readonly string[], page: KeysetPage): Promise<readonly Review[]> {
    const stores = storeIds.filter((s) => UUID.test(s));
    if (stores.length === 0) return [];
    const a = after(page.after);
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${REVIEW_COLS} from reviews
        where store_id = any(${stores}::uuid[]) and status = 'PUBLISHED'
          and (${a === null}::boolean or (published_at, id) < (${a?.ts ?? iso(0)}::timestamptz, ${a?.id ?? NIL}::uuid))
        order by published_at desc, id desc limit ${page.limit}`.execute(trx);
      return r.rows.map(toReview);
    });
  }

  async ratingCounts(productId: string): Promise<RatingCounts> {
    const by: [number, number, number, number, number] = [0, 0, 0, 0, 0];
    if (!UUID.test(productId)) return { byStar: by };
    return this.tx(async (trx) => {
      const r = await sql<{ rating: number; n: string }>`
        select rating::int as rating, count(*)::text as n from reviews
        where product_id = ${productId}::uuid and status = 'PUBLISHED' group by rating`.execute(trx);
      for (const row of r.rows) {
        if (row.rating >= 1 && row.rating <= 5) by[row.rating - 1] = Number(row.n);
      }
      return { byStar: by };
    });
  }

  // ---- replies ----

  async upsertReply(reply: ReviewReply, logId: string): Promise<void> {
    await this.tx(async (trx) => {
      const prev = await sql<{ status: ModerationStatus }>`
        select status from review_replies where review_id = ${reply.reviewId}::uuid for update`.execute(trx);
      const was = prev.rows[0]?.status;
      await sql`
        insert into review_replies (review_id, store_id, author_user_id, body, status, hold_reason, created_at, updated_at)
        values (${reply.reviewId}::uuid, ${reply.storeId}::uuid, ${reply.authorUserId}::uuid, ${reply.body},
          ${reply.status}, ${reply.holdReason}, ${iso(reply.createdAtMs)}::timestamptz, ${iso(reply.updatedAtMs)}::timestamptz)
        on conflict (review_id) do update set body = excluded.body, author_user_id = excluded.author_user_id,
          status = excluded.status, hold_reason = null, updated_at = excluded.updated_at`.execute(trx);
      if (was !== undefined) {
        await this.log(trx, {
          id: logId,
          type: "review_reply",
          targetId: reply.reviewId,
          from: was,
          to: reply.status,
          actorKind: "author",
          actorId: reply.authorUserId,
          reason: null,
          atMs: reply.updatedAtMs,
        });
      }
    });
  }

  async getReply(reviewId: string): Promise<ReviewReply | null> {
    if (!UUID.test(reviewId)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${REPLY_COLS} from review_replies where review_id = ${reviewId}::uuid`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toReply(row);
    });
  }

  async publishedReplies(reviewIds: readonly string[]): Promise<ReadonlyMap<string, ReviewReply>> {
    const ids = reviewIds.filter((i) => UUID.test(i));
    const out = new Map<string, ReviewReply>();
    if (ids.length === 0) return out;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${REPLY_COLS} from review_replies where review_id = any(${ids}::uuid[]) and status = 'PUBLISHED'`.execute(trx);
      for (const row of r.rows) {
        const rep = toReply(row);
        out.set(rep.reviewId, rep);
      }
      return out;
    });
  }

  // ---- questions and answers ----

  async insertQuestion(q: Question): Promise<void> {
    const ts = (ms: number | null): string | null => (ms === null ? null : iso(ms));
    await this.tx(async (trx) => {
      await sql`
        insert into questions (id, product_id, store_id, user_id, body, status, hold_reason, created_at,
          published_at, sla_due_at, answered_at, sla_breached_at)
        values (${q.id}::uuid, ${q.productId}::uuid, ${q.storeId}::uuid, ${q.userId}::uuid, ${q.body},
          ${q.status}, ${q.holdReason}, ${iso(q.createdAtMs)}::timestamptz,
          ${ts(q.publishedAtMs)}::timestamptz, ${ts(q.slaDueAtMs)}::timestamptz,
          ${ts(q.answeredAtMs)}::timestamptz, ${ts(q.slaBreachedAtMs)}::timestamptz)`.execute(trx);
    });
  }

  async getQuestion(id: string): Promise<Question | null> {
    if (!UUID.test(id)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${QUESTION_COLS} from questions where id = ${id}::uuid`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toQuestion(row);
    });
  }

  async listPublishedQuestions(productId: string, page: KeysetPage): Promise<readonly Question[]> {
    if (!UUID.test(productId)) return [];
    const a = after(page.after);
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${QUESTION_COLS} from questions
        where product_id = ${productId}::uuid and status = 'PUBLISHED'
          and (${a === null}::boolean or (published_at, id) < (${a?.ts ?? iso(0)}::timestamptz, ${a?.id ?? NIL}::uuid))
        order by published_at desc, id desc limit ${page.limit}`.execute(trx);
      return r.rows.map(toQuestion);
    });
  }

  async listQuestionsByStores(
    storeIds: readonly string[],
    filter: { readonly unansweredOnly: boolean },
    page: KeysetPage,
  ): Promise<readonly Question[]> {
    const stores = storeIds.filter((s) => UUID.test(s));
    if (stores.length === 0) return [];
    const a = after(page.after);
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${QUESTION_COLS} from questions
        where store_id = any(${stores}::uuid[]) and status = 'PUBLISHED'
          and (not ${filter.unansweredOnly}::boolean or answered_at is null)
          and (${a === null}::boolean or (published_at, id) < (${a?.ts ?? iso(0)}::timestamptz, ${a?.id ?? NIL}::uuid))
        order by published_at desc, id desc limit ${page.limit}`.execute(trx);
      return r.rows.map(toQuestion);
    });
  }

  async upsertAnswer(a: Answer, logId: string): Promise<void> {
    await this.tx(async (trx) => {
      const prev = await sql<{ id: string; status: ModerationStatus }>`
        select id::text as id, status from answers
        where question_id = ${a.questionId}::uuid and store_id = ${a.storeId}::uuid for update`.execute(trx);
      const was = prev.rows[0];
      if (was === undefined) {
        await sql`
          insert into answers (id, question_id, store_id, author_user_id, body, status, hold_reason, created_at, updated_at)
          values (${a.id}::uuid, ${a.questionId}::uuid, ${a.storeId}::uuid, ${a.authorUserId}::uuid, ${a.body},
            ${a.status}, ${a.holdReason}, ${iso(a.createdAtMs)}::timestamptz, ${iso(a.updatedAtMs)}::timestamptz)`.execute(trx);
        return;
      }
      await sql`
        update answers set body = ${a.body}, author_user_id = ${a.authorUserId}::uuid, status = ${a.status},
          hold_reason = null, updated_at = ${iso(a.updatedAtMs)}::timestamptz where id = ${was.id}::uuid`.execute(trx);
      await this.log(trx, {
        id: logId,
        type: "answer",
        targetId: was.id,
        from: was.status,
        to: a.status,
        actorKind: "author",
        actorId: a.authorUserId,
        reason: null,
        atMs: a.updatedAtMs,
      });
    });
  }

  async getAnswer(id: string): Promise<Answer | null> {
    if (!UUID.test(id)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${ANSWER_COLS} from answers where id = ${id}::uuid`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toAnswer(row);
    });
  }

  async getAnswerByQuestionStore(questionId: string, storeId: string): Promise<Answer | null> {
    if (!UUID.test(questionId) || !UUID.test(storeId)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${ANSWER_COLS} from answers where question_id = ${questionId}::uuid and store_id = ${storeId}::uuid`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toAnswer(row);
    });
  }

  async publishedAnswers(questionIds: readonly string[]): Promise<ReadonlyMap<string, readonly Answer[]>> {
    const ids = questionIds.filter((i) => UUID.test(i));
    const out = new Map<string, Answer[]>();
    if (ids.length === 0) return out;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${ANSWER_COLS} from answers where question_id = any(${ids}::uuid[]) and status = 'PUBLISHED'
        order by created_at, id`.execute(trx);
      for (const row of r.rows) {
        const a = toAnswer(row);
        const list = out.get(a.questionId) ?? [];
        list.push(a);
        out.set(a.questionId, list);
      }
      return out;
    });
  }

  async listOverdueQuestions(nowMs: number, limit: number): Promise<readonly Question[]> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${QUESTION_COLS} from questions
        where status = 'PUBLISHED' and answered_at is null and sla_breached_at is null
          and sla_due_at <= ${iso(nowMs)}::timestamptz
        order by sla_due_at, id limit ${limit}`.execute(trx);
      return r.rows.map(toQuestion);
    });
  }

  async markSlaBreached(id: string, nowMs: number, events: readonly ReviewEvent[]): Promise<boolean> {
    if (!UUID.test(id)) return false;
    return this.tx(async (trx) => {
      const r = await sql<{ id: string }>`
        update questions set sla_breached_at = ${iso(nowMs)}::timestamptz
        where id = ${id}::uuid and sla_breached_at is null and answered_at is null
        returning id::text as id`.execute(trx);
      if (r.rows[0] === undefined) return false;
      await this.emit(trx, events);
      return true;
    });
  }

  // ---- moderation ----

  async getUgc(type: UgcTargetType, id: string): Promise<UgcItem | null> {
    if (!UUID.test(id)) return null;
    return this.tx(async (trx) => this.ugcOf(trx, type, id));
  }

  private async ugcOf(trx: ReviewDb, type: UgcTargetType, id: string): Promise<UgcItem | null> {
    switch (type) {
      case "review": {
        const r = await sql<unknown>`select ${REVIEW_COLS} from reviews where id = ${id}::uuid`.execute(trx);
        const row = r.rows[0];
        if (row === undefined) return null;
        const v = toReview(row);
        return {
          type,
          id,
          status: v.status,
          holdReason: v.holdReason,
          authorUserId: v.userId,
          storeId: v.storeId,
          productId: v.productId,
          text: v.title === null ? v.body : `${v.title}\n${v.body}`,
          photoIds: v.photoIds,
          createdAtMs: v.createdAtMs,
        };
      }
      case "review_reply": {
        const r = await sql<unknown>`
          select ${REPLY_COLS}, (select product_id::text from reviews rv where rv.id = review_id) as product_id
          from review_replies where review_id = ${id}::uuid`.execute(trx);
        const row = r.rows[0] as { product_id?: string } | undefined;
        if (row === undefined || row.product_id === undefined) return null;
        const v = toReply(row);
        return {
          type,
          id,
          status: v.status,
          holdReason: v.holdReason,
          authorUserId: v.authorUserId,
          storeId: v.storeId,
          productId: row.product_id,
          text: v.body,
          photoIds: [],
          createdAtMs: v.createdAtMs,
        };
      }
      case "question": {
        const r = await sql<unknown>`select ${QUESTION_COLS} from questions where id = ${id}::uuid`.execute(trx);
        const row = r.rows[0];
        if (row === undefined) return null;
        const v = toQuestion(row);
        return {
          type,
          id,
          status: v.status,
          holdReason: v.holdReason,
          authorUserId: v.userId,
          storeId: v.storeId,
          productId: v.productId,
          text: v.body,
          photoIds: [],
          createdAtMs: v.createdAtMs,
        };
      }
      case "answer": {
        const r = await sql<unknown>`
          select ${ANSWER_COLS}, (select product_id::text from questions q where q.id = question_id) as product_id
          from answers where id = ${id}::uuid`.execute(trx);
        const row = r.rows[0] as { product_id?: string } | undefined;
        if (row === undefined || row.product_id === undefined) return null;
        const v = toAnswer(row);
        return {
          type,
          id,
          status: v.status,
          holdReason: v.holdReason,
          authorUserId: v.authorUserId,
          storeId: v.storeId,
          productId: row.product_id,
          text: v.body,
          photoIds: [],
          createdAtMs: v.createdAtMs,
        };
      }
    }
  }

  async transition(t: TransitionInput): Promise<"ok" | "stale"> {
    if (!UUID.test(t.id)) return "stale";
    return this.tx(async (trx) => {
      const hold = t.to === "HELD" || t.to === "REJECTED" ? t.reason : null;
      const now = iso(t.nowMs);
      let hit = false;
      switch (t.type) {
        case "review": {
          const r = await sql<{ id: string }>`
            update reviews set status = ${t.to}, hold_reason = ${hold}, updated_at = ${now}::timestamptz,
              published_at = case when ${t.to} = 'PUBLISHED' then coalesce(published_at, ${now}::timestamptz) else published_at end,
              reward_intent_at = case when ${t.markRewardIntent}::boolean then coalesce(reward_intent_at, ${now}::timestamptz) else reward_intent_at end
            where id = ${t.id}::uuid and status = ${t.from} returning id::text as id`.execute(trx);
          hit = r.rows[0] !== undefined;
          break;
        }
        case "review_reply": {
          const r = await sql<{ id: string }>`
            update review_replies set status = ${t.to}, hold_reason = ${hold}, updated_at = ${now}::timestamptz
            where review_id = ${t.id}::uuid and status = ${t.from} returning review_id::text as id`.execute(trx);
          hit = r.rows[0] !== undefined;
          break;
        }
        case "question": {
          const r = await sql<{ id: string }>`
            update questions set status = ${t.to}, hold_reason = ${hold},
              published_at = case when ${t.to} = 'PUBLISHED' then coalesce(published_at, ${now}::timestamptz) else published_at end,
              sla_due_at = case when ${t.to} = 'PUBLISHED' and published_at is null
                                then ${iso(t.nowMs + t.slaMs)}::timestamptz else sla_due_at end
            where id = ${t.id}::uuid and status = ${t.from} returning id::text as id`.execute(trx);
          hit = r.rows[0] !== undefined;
          break;
        }
        case "answer": {
          const r = await sql<{ question_id: string }>`
            update answers set status = ${t.to}, hold_reason = ${hold}, updated_at = ${now}::timestamptz
            where id = ${t.id}::uuid and status = ${t.from} returning question_id::text as question_id`.execute(trx);
          const row = r.rows[0];
          hit = row !== undefined;
          if (row !== undefined && t.to === "PUBLISHED") {
            await sql`
              update questions set answered_at = coalesce(answered_at, ${now}::timestamptz)
              where id = ${row.question_id}::uuid`.execute(trx);
          }
          break;
        }
      }
      if (!hit) return "stale";
      await this.log(trx, {
        id: t.logId,
        type: t.type,
        targetId: t.id,
        from: t.from,
        to: t.to,
        actorKind: t.actorKind,
        actorId: t.actorId,
        reason: t.reason,
        atMs: t.nowMs,
      });
      await this.emit(trx, t.events);
      return "ok";
    });
  }

  async listModeration(
    filter: { readonly statuses: readonly ModerationStatus[]; readonly type: UgcTargetType | null },
    page: KeysetPage,
  ): Promise<readonly UgcItem[]> {
    const a = after(page.after);
    const types: readonly UgcTargetType[] = filter.type === null ? UGC_TARGET_TYPES : [filter.type];
    return this.tx(async (trx) => {
      const rows: { type: UgcTargetType; id: string; ms: number }[] = [];
      for (const type of types) {
        const table = { review: "reviews", review_reply: "review_replies", question: "questions", answer: "answers" }[type];
        const idCol = type === "review_reply" ? "review_id" : "id";
        const r = await sql<{ id: string; ms: string; ts: string }>`
          select ${sql.raw(idCol)}::text as id, ${EPOCH_MS("created_at")} as ms, created_at::text as ts
          from ${sql.table(table)}
          where status = any(${[...filter.statuses]}::text[])
            and (${a === null}::boolean or (created_at, ${sql.raw(idCol)}) > (${a?.ts ?? iso(0)}::timestamptz, ${a?.id ?? NIL}::uuid))
          order by created_at, ${sql.raw(idCol)} limit ${page.limit}`.execute(trx);
        for (const row of r.rows) rows.push({ type, id: row.id, ms: Number(row.ms) });
      }
      rows.sort((x, y) => x.ms - y.ms || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
      const out: UgcItem[] = [];
      for (const row of rows.slice(0, page.limit)) {
        const item = await this.ugcOf(trx, row.type, row.id);
        if (item !== null) out.push(item);
      }
      return out;
    });
  }

  async moderationLog(type: UgcTargetType, id: string): Promise<readonly ModerationLogEntry[]> {
    if (!UUID.test(id)) return [];
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select id::text as id, target_type, target_id::text as target_id, from_status, to_status, actor_kind,
          actor_id::text as actor_id, reason, ${EPOCH_MS("created_at")} as at_ms
        from moderation_log where target_type = ${type} and target_id = ${id}::uuid order by created_at, id`.execute(trx);
      return r.rows.map((raw) => {
        const l = LogRow.parse(raw);
        return {
          id: l.id,
          targetType: l.target_type,
          targetId: l.target_id,
          from: l.from_status,
          to: l.to_status,
          actorKind: l.actor_kind,
          actorId: l.actor_id,
          reason: l.reason,
          atMs: l.at_ms,
        };
      });
    });
  }

  // ---- reports ----

  async addReport(rep: Report, events: readonly ReviewEvent[]): Promise<"added" | "duplicate"> {
    return this.tx(async (trx) => {
      const r = await sql<{ id: string }>`
        insert into ugc_reports (id, target_type, target_id, reporter_id, reason, created_at)
        values (${rep.id}::uuid, ${rep.targetType}, ${rep.targetId}::uuid, ${rep.reporterId}::uuid, ${rep.reason},
          ${iso(rep.createdAtMs)}::timestamptz)
        on conflict (target_type, target_id, reporter_id) do nothing returning id::text as id`.execute(trx);
      if (r.rows[0] === undefined) return "duplicate";
      await this.emit(trx, events);
      return "added";
    });
  }

  async countReportsBy(reporterId: string, sinceMs: number): Promise<number> {
    if (!UUID.test(reporterId)) return 0;
    return this.tx(async (trx) => {
      const r = await sql<{ n: string }>`
        select count(*)::text as n from ugc_reports
        where reporter_id = ${reporterId}::uuid and created_at >= ${iso(sinceMs)}::timestamptz`.execute(trx);
      return Number(r.rows[0]?.n ?? 0);
    });
  }

  async countDistinctReporters(type: UgcTargetType, id: string): Promise<number> {
    if (!UUID.test(id)) return 0;
    return this.tx(async (trx) => {
      const r = await sql<{ n: string }>`
        select count(distinct reporter_id)::text as n from ugc_reports
        where target_type = ${type} and target_id = ${id}::uuid`.execute(trx);
      return Number(r.rows[0]?.n ?? 0);
    });
  }
}
