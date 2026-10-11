import { beforeEach, describe, expect, it } from "vitest";
import type { Answer, Question, Review, ReviewReply } from "../domain/bridge";
import type { Report, ReviewEvent, ReviewStore, TransitionInput } from "../domain/ports";

export interface ReviewStoreContext {
  readonly store: ReviewStore;
  /** Makes the user exist where the store enforces the FK (Postgres); no-op in memory. */
  ensureUser(userId: string): Promise<void>;
  /** Event types in the order they were written (outbox). */
  eventTypes(): Promise<string[]>;
}

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const STORE_A = U(9001);
const STORE_B = U(9002);
const PROD_1 = U(7001);
const PROD_2 = U(7002);
let seq = 0;
const lid = (): string => `00000000-0000-7000-8000-${String(++seq + 500_000).padStart(12, "0")}`;

export const review = (n: number, userId: string, over: Partial<Review> = {}): Review => ({
  id: U(100 + n),
  orderLineId: U(200 + n),
  userId,
  storeId: STORE_A,
  productId: PROD_1,
  rating: 4,
  title: null,
  body: `Review body number ${n} is long enough`,
  purchasedSize: "M",
  fit: null,
  fitArea: null,
  photoIds: [],
  status: "SUBMITTED",
  holdReason: null,
  rewardIntentAtMs: null,
  createdAtMs: T0 + n * 1000,
  updatedAtMs: T0 + n * 1000,
  publishedAtMs: null,
  ...over,
});

const question = (n: number, userId: string, over: Partial<Question> = {}): Question => ({
  id: U(300 + n),
  productId: PROD_1,
  storeId: STORE_A,
  userId,
  body: `Question number ${n}?`,
  status: "SUBMITTED",
  holdReason: null,
  createdAtMs: T0 + n * 1000,
  publishedAtMs: null,
  slaDueAtMs: null,
  answeredAtMs: null,
  slaBreachedAtMs: null,
  ...over,
});

const answer = (n: number, questionId: string, authorId: string, over: Partial<Answer> = {}): Answer => ({
  id: U(400 + n),
  questionId,
  storeId: STORE_A,
  authorUserId: authorId,
  body: `Answer number ${n}`,
  status: "SUBMITTED",
  holdReason: null,
  createdAtMs: T0 + n * 1000,
  updatedAtMs: T0 + n * 1000,
  ...over,
});

const step = (over: Partial<TransitionInput> & Pick<TransitionInput, "type" | "id" | "from" | "to">): TransitionInput => ({
  actorKind: "system",
  actorId: null,
  reason: null,
  nowMs: T0 + DAY,
  logId: lid(),
  slaMs: 48 * 3_600_000,
  markRewardIntent: false,
  events: [],
  ...over,
});

const published = (n: number, userId: string, over: Partial<Review> = {}): Review =>
  review(n, userId, { status: "PUBLISHED", publishedAtMs: T0 + n * 1000, ...over });

/** Behaviour every ReviewStore must have. Run against in-memory and Kysely/PGlite. */
export function describeReviewStoreContract(name: string, make: () => Promise<ReviewStoreContext>): void {
  describe(`ReviewStore contract: ${name}`, () => {
    let c: ReviewStoreContext;
    beforeEach(async () => {
      c = await make();
      for (const n of [1, 2, 3, 4]) await c.ensureUser(U(n));
    });

    it("round-trips a review and enforces one review per order line", async () => {
      const r = review(1, U(1), { title: "Nice", fit: "ok", fitArea: "waist", photoIds: [U(900), U(901)] });
      expect(await c.store.insertReview(r, [])).toBe("inserted");
      expect(await c.store.getReview(r.id)).toEqual(r);
      expect(await c.store.getReviewByOrderLine(r.orderLineId)).toEqual(r);
      expect(await c.store.getReview(U(999))).toBeNull();
      // same order line, different review id and even different user: refused
      expect(await c.store.insertReview(review(2, U(2), { orderLineId: r.orderLineId }), [])).toBe("exists");
      expect(await c.store.getReview(U(102))).toBeNull();
    });

    it("writes events in the same write as the insert, and none when the insert is refused", async () => {
      const ev: ReviewEvent = { type: "ugc.reported", targetType: "review", targetId: U(101), reason: "spam" };
      const r = review(1, U(1));
      await c.store.insertReview(r, [ev]);
      await c.store.insertReview(review(2, U(2), { orderLineId: r.orderLineId }), [ev]);
      expect(await c.eventTypes()).toEqual(["ugc.reported"]);
    });

    it("lets only the author edit, returns the review to SUBMITTED and logs it", async () => {
      const r = published(1, U(1), { rating: 5 });
      await c.store.insertReview(r, []);
      const draft = { rating: 2, title: null, body: "Changed my mind about this", fit: null, fitArea: null, photoIds: [] };
      const other = await c.store.editReview({ id: r.id, userId: U(2), draft, nowMs: T0 + 5, logId: lid(), events: [] });
      expect(other.kind).toBe("not_found");
      const mine = await c.store.editReview({ id: r.id, userId: U(1), draft, nowMs: T0 + 5, logId: lid(), events: [] });
      expect(mine.kind).toBe("ok");
      if (mine.kind === "ok") {
        expect(mine.wasPublished).toBe(true);
        expect(mine.review).toMatchObject({ status: "SUBMITTED", rating: 2, body: draft.body, holdReason: null });
      }
      // a review mid-pipeline is busy
      expect((await c.store.editReview({ id: r.id, userId: U(1), draft, nowMs: T0 + 6, logId: lid(), events: [] })).kind).toBe("busy");
      const log = await c.store.moderationLog("review", r.id);
      expect(log.map((l) => [l.from, l.to, l.actorKind])).toEqual([["PUBLISHED", "SUBMITTED", "author"]]);
    });

    it("transitions are guarded by the expected state", async () => {
      const r = review(1, U(1));
      await c.store.insertReview(r, []);
      expect(await c.store.transition(step({ type: "review", id: r.id, from: "AUTO_CHECKED", to: "PUBLISHED" }))).toBe("stale");
      expect(await c.store.transition(step({ type: "review", id: r.id, from: "SUBMITTED", to: "AUTO_CHECKED" }))).toBe("ok");
      expect(await c.store.transition(step({ type: "review", id: r.id, from: "SUBMITTED", to: "AUTO_CHECKED" }))).toBe("stale");
      expect((await c.store.getReview(r.id))?.status).toBe("AUTO_CHECKED");
      expect(await c.store.transition(step({ type: "review", id: U(999), from: "SUBMITTED", to: "AUTO_CHECKED" }))).toBe("stale");
    });

    it("publishing sets published_at once and the reward flag once; hold keeps a reason", async () => {
      const r = review(1, U(1), { status: "AUTO_CHECKED" });
      await c.store.insertReview(r, []);
      const ev: ReviewEvent = { type: "review.published", reviewId: r.id, productId: r.productId, storeId: r.storeId, rating: 4 };
      expect(
        await c.store.transition(
          step({ type: "review", id: r.id, from: "AUTO_CHECKED", to: "PUBLISHED", nowMs: T0 + 10, markRewardIntent: true, events: [ev] }),
        ),
      ).toBe("ok");
      const p = await c.store.getReview(r.id);
      expect(p).toMatchObject({ status: "PUBLISHED", publishedAtMs: T0 + 10, rewardIntentAtMs: T0 + 10, holdReason: null });
      await c.store.transition(
        step({ type: "review", id: r.id, from: "PUBLISHED", to: "HELD", reason: "reported", nowMs: T0 + 20, actorKind: "reports" }),
      );
      expect(await c.store.getReview(r.id)).toMatchObject({ status: "HELD", holdReason: "reported", publishedAtMs: T0 + 10 });
      await c.store.transition(
        step({ type: "review", id: r.id, from: "HELD", to: "PUBLISHED", nowMs: T0 + 30, markRewardIntent: true, actorKind: "moderator", actorId: U(3) }),
      );
      expect(await c.store.getReview(r.id)).toMatchObject({ publishedAtMs: T0 + 10, rewardIntentAtMs: T0 + 10, holdReason: null });
      expect(await c.eventTypes()).toEqual(["review.published"]);
      const log = await c.store.moderationLog("review", r.id);
      expect(log.map((l) => `${l.from}>${l.to}:${l.actorKind}`)).toEqual([
        "AUTO_CHECKED>PUBLISHED:system",
        "PUBLISHED>HELD:reports",
        "HELD>PUBLISHED:moderator",
      ]);
    });

    it("pages published reviews newest first with keyset cursors, excluding unpublished", async () => {
      for (const n of [1, 2, 3, 4, 5]) await c.store.insertReview(published(n, U(1), { orderLineId: U(200 + n) }), []);
      await c.store.insertReview(review(6, U(2)), []);
      await c.store.insertReview(published(7, U(2), { productId: PROD_2 }), []);
      // a tie on published_at must not drop or repeat rows
      await c.store.insertReview(published(8, U(3), { publishedAtMs: T0 + 3000 }), []);
      const seen: string[] = [];
      let after: { ms: number; id: string } | null = null;
      for (let i = 0; i < 10; i += 1) {
        const page = await c.store.listPublishedReviews(PROD_1, { after, limit: 2 });
        if (page.length === 0) break;
        for (const r of page) seen.push(r.id);
        const last = page[page.length - 1];
        if (last === undefined || last.publishedAtMs === null) break;
        after = { ms: last.publishedAtMs, id: last.id };
      }
      expect(seen).toEqual([U(105), U(104), U(108), U(103), U(102), U(101)]);
    });

    it("counts only published ratings for the aggregate", async () => {
      await c.store.insertReview(published(1, U(1), { rating: 5 }), []);
      await c.store.insertReview(published(2, U(2), { rating: 5 }), []);
      await c.store.insertReview(published(3, U(3), { rating: 1 }), []);
      await c.store.insertReview(review(4, U(4), { rating: 1 }), []);
      await c.store.insertReview(published(5, U(1), { rating: 3, status: "HELD", holdReason: "toxicity", publishedAtMs: null }), []);
      expect(await c.store.ratingCounts(PROD_1)).toEqual({ byStar: [1, 0, 0, 0, 2] });
      expect(await c.store.ratingCounts(PROD_2)).toEqual({ byStar: [0, 0, 0, 0, 0] });
    });

    it("lists a user's own reviews and a store's published reviews only", async () => {
      await c.store.insertReview(published(1, U(1)), []);
      await c.store.insertReview(review(2, U(1)), []);
      await c.store.insertReview(published(3, U(2), { storeId: STORE_B }), []);
      expect((await c.store.listReviewsByUser(U(1), { after: null, limit: 10 })).map((r) => r.id)).toEqual([U(102), U(101)]);
      expect((await c.store.listReviewsByStores([STORE_A], { after: null, limit: 10 })).map((r) => r.id)).toEqual([U(101)]);
      expect(await c.store.listReviewsByStores([], { after: null, limit: 10 })).toEqual([]);
    });

    it("keeps one reply per review, shows only published ones, and cascades on delete", async () => {
      const r = published(1, U(1));
      await c.store.insertReview(r, []);
      const rep: ReviewReply = {
        reviewId: r.id,
        storeId: STORE_A,
        authorUserId: U(3),
        body: "Thank you!",
        status: "SUBMITTED",
        holdReason: null,
        createdAtMs: T0 + 5,
        updatedAtMs: T0 + 5,
      };
      await c.store.upsertReply(rep, lid());
      expect((await c.store.publishedReplies([r.id])).size).toBe(0);
      await c.store.transition(step({ type: "review_reply", id: r.id, from: "SUBMITTED", to: "AUTO_CHECKED" }));
      await c.store.transition(step({ type: "review_reply", id: r.id, from: "AUTO_CHECKED", to: "PUBLISHED" }));
      expect((await c.store.publishedReplies([r.id])).get(r.id)?.body).toBe("Thank you!");
      await c.store.upsertReply({ ...rep, body: "Edited thanks", updatedAtMs: T0 + 50 }, lid());
      expect(await c.store.getReply(r.id)).toMatchObject({ body: "Edited thanks", status: "SUBMITTED", createdAtMs: T0 + 5 });
      expect((await c.store.publishedReplies([r.id])).size).toBe(0);
      expect(await c.store.deleteReview(r.id, U(2), [])).toBe(false);
      expect(await c.store.deleteReview(r.id, U(1), [])).toBe(true);
      expect(await c.store.getReply(r.id)).toBeNull();
    });

    it("starts the question SLA at publication and records the answer", async () => {
      const q = question(1, U(1));
      await c.store.insertQuestion(q);
      expect(await c.store.getQuestion(q.id)).toEqual(q);
      await c.store.transition(step({ type: "question", id: q.id, from: "SUBMITTED", to: "AUTO_CHECKED" }));
      await c.store.transition(step({ type: "question", id: q.id, from: "AUTO_CHECKED", to: "PUBLISHED", nowMs: T0 + 100 }));
      const pub = await c.store.getQuestion(q.id);
      expect(pub).toMatchObject({ status: "PUBLISHED", publishedAtMs: T0 + 100, slaDueAtMs: T0 + 100 + 48 * 3_600_000, answeredAtMs: null });
      expect((await c.store.listPublishedQuestions(PROD_1, { after: null, limit: 10 })).map((x) => x.id)).toEqual([q.id]);

      const a = answer(1, q.id, U(3));
      await c.store.upsertAnswer(a, lid());
      expect((await c.store.publishedAnswers([q.id])).size).toBe(0);
      await c.store.transition(step({ type: "answer", id: a.id, from: "SUBMITTED", to: "AUTO_CHECKED" }));
      await c.store.transition(step({ type: "answer", id: a.id, from: "AUTO_CHECKED", to: "PUBLISHED", nowMs: T0 + 200 }));
      expect((await c.store.getQuestion(q.id))?.answeredAtMs).toBe(T0 + 200);
      expect((await c.store.publishedAnswers([q.id])).get(q.id)?.map((x) => x.id)).toEqual([a.id]);
      expect((await c.store.getAnswerByQuestionStore(q.id, STORE_A))?.id).toBe(a.id);
      expect((await c.store.listQuestionsByStores([STORE_A], { unansweredOnly: true }, { after: null, limit: 10 })).length).toBe(0);
      expect((await c.store.listQuestionsByStores([STORE_A], { unansweredOnly: false }, { after: null, limit: 10 })).length).toBe(1);
    });

    it("finds overdue unanswered questions and flags each only once", async () => {
      const q = question(1, U(1), { status: "PUBLISHED", publishedAtMs: T0, slaDueAtMs: T0 + 1000 });
      await c.store.insertQuestion(q);
      expect(await c.store.listOverdueQuestions(T0 + 999, 10)).toEqual([]);
      expect((await c.store.listOverdueQuestions(T0 + 1000, 10)).map((x) => x.id)).toEqual([q.id]);
      const ev: ReviewEvent = { type: "qa.sla_breached", questionId: q.id, storeId: STORE_A, dueAtMs: T0 + 1000 };
      expect(await c.store.markSlaBreached(q.id, T0 + 1500, [ev])).toBe(true);
      expect(await c.store.markSlaBreached(q.id, T0 + 1600, [ev])).toBe(false);
      expect(await c.store.listOverdueQuestions(T0 + 5000, 10)).toEqual([]);
      expect(await c.eventTypes()).toEqual(["qa.sla_breached"]);
    });

    it("answers one per store and question (upsert)", async () => {
      const q = question(1, U(1), { status: "PUBLISHED", publishedAtMs: T0, slaDueAtMs: T0 + 1 });
      await c.store.insertQuestion(q);
      await c.store.upsertAnswer(answer(1, q.id, U(3)), lid());
      await c.store.upsertAnswer(answer(2, q.id, U(3), { body: "Second try" }), lid());
      const a = await c.store.getAnswerByQuestionStore(q.id, STORE_A);
      expect(a).toMatchObject({ id: U(401), body: "Second try", status: "SUBMITTED" });
    });

    it("loads moderation items across types oldest first with keyset paging", async () => {
      await c.store.insertReview(review(1, U(1), { status: "HELD", holdReason: "toxicity" }), []);
      await c.store.insertQuestion(question(2, U(2), { status: "HELD", holdReason: "contact_info" }));
      await c.store.insertReview(review(3, U(3), { status: "HELD", holdReason: "reported", orderLineId: U(203) }), []);
      await c.store.insertReview(published(4, U(4)), []);
      const first = await c.store.listModeration({ statuses: ["HELD"], type: null }, { after: null, limit: 2 });
      expect(first.map((i) => i.id)).toEqual([U(101), U(302)]);
      const last = first[first.length - 1];
      const second = await c.store.listModeration(
        { statuses: ["HELD"], type: null },
        { after: last === undefined ? null : { ms: last.createdAtMs, id: last.id }, limit: 2 },
      );
      expect(second.map((i) => i.id)).toEqual([U(103)]);
      expect((await c.store.listModeration({ statuses: ["HELD"], type: "question" }, { after: null, limit: 5 })).map((i) => i.type)).toEqual(["question"]);
      expect(first[0]).toMatchObject({ type: "review", authorUserId: U(1), storeId: STORE_A, productId: PROD_1 });
    });

    it("stores a report once per reporter and counts distinct reporters and daily volume", async () => {
      const r = published(1, U(1));
      await c.store.insertReview(r, []);
      const rep = (n: number, by: string, at: number): Report => ({
        id: U(600 + n),
        targetType: "review",
        targetId: r.id,
        reporterId: by,
        reason: "spam",
        createdAtMs: at,
      });
      expect(await c.store.addReport(rep(1, U(2), T0), [])).toBe("added");
      expect(await c.store.addReport(rep(2, U(2), T0 + 5), [])).toBe("duplicate");
      expect(await c.store.addReport(rep(3, U(3), T0 + DAY + 10), [])).toBe("added");
      expect(await c.store.countDistinctReporters("review", r.id)).toBe(2);
      expect(await c.store.countReportsBy(U(2), T0 - 1)).toBe(1);
      expect(await c.store.countReportsBy(U(2), T0 + 1)).toBe(0);
    });

    it("resolves ugc items for every type, with product and store for replies and answers", async () => {
      const r = published(1, U(1));
      await c.store.insertReview(r, []);
      await c.store.upsertReply(
        { reviewId: r.id, storeId: STORE_A, authorUserId: U(3), body: "Reply", status: "PUBLISHED", holdReason: null, createdAtMs: T0, updatedAtMs: T0 },
        lid(),
      );
      const q = question(1, U(2), { status: "PUBLISHED", publishedAtMs: T0, slaDueAtMs: T0 + 1 });
      await c.store.insertQuestion(q);
      await c.store.upsertAnswer(answer(1, q.id, U(3)), lid());
      expect(await c.store.getUgc("review_reply", r.id)).toMatchObject({ authorUserId: U(3), productId: PROD_1, text: "Reply" });
      expect(await c.store.getUgc("answer", U(401))).toMatchObject({ authorUserId: U(3), productId: PROD_1, storeId: STORE_A });
      expect(await c.store.getUgc("question", q.id)).toMatchObject({ authorUserId: U(2), status: "PUBLISHED" });
      expect(await c.store.getUgc("review", U(999))).toBeNull();
    });
  });
}
