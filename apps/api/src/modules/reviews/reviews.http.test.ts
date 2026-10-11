import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HOUR,
  IDEM,
  PRODUCT_1,
  PRODUCT_2,
  STORE_A,
  TOKENS,
  U,
  USERS,
  bearer,
  createReviewsHarness,
  type ReviewsHarness,
} from "./test/harness";

let h: ReviewsHarness;
let seq = 0;
const idem = (): Record<string, string> => ({ "Idempotency-Key": IDEM(++seq) });
const BODY = "Good fabric, true to size, would buy again.";

beforeAll(async () => {
  h = await createReviewsHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
});

/** Fresh rate-limit window for each call site. */
const tick = (): void => h.clock.advance(61_000);

const post = (path: string, token: string | null, body: unknown, extra: Record<string, string> = idem()) => {
  tick();
  const r = h.http().post(path).set(extra);
  return (token === null ? r : r.set(bearer(token))).send(body as object);
};
const get = (path: string, token: string | null = null) => {
  tick();
  const r = h.http().get(path);
  return token === null ? r : r.set(bearer(token));
};
const review = (n: number, userId: string, token: string, over: Record<string, unknown> = {}, line = {}) => {
  const l = h.deliver(n, userId, line);
  return post(`/v1/orders/lines/${l.orderLineId}/review`, token, { rating: 4, body: BODY, ...over });
};

describe("POST /v1/orders/lines/:id/review", () => {
  it("publishes a verified review and shows it publicly with an initial only", async () => {
    const r = await review(1, USERS.s1, TOKENS.s1, { rating: 5, title: "Great", fit: "ok", fit_area: "waist" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ rating: 5, moderation_status: "PUBLISHED", purchased_size: "M", fit: "ok" });
    const list = await get(`/v1/products/${PRODUCT_1}/reviews`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ reviewer_initial: "S", verified_purchase: true, seller_reply: null });
    const text = JSON.stringify(list.body);
    expect(text).not.toContain(USERS.s1);
    expect(text).not.toContain("Sara");
    expect(text).not.toContain(U(501));
    expect(list.body.items[0]).not.toHaveProperty("user_id");
    expect(list.body.items[0]).not.toHaveProperty("order_line_id");
  });

  it("shows no aggregate below the minimum count, then the real one", async () => {
    const before = await get(`/v1/products/${PRODUCT_1}/reviews`);
    expect(before.body.summary).toBeNull();
    for (const n of [2, 3, 4, 5]) {
      const u = USERS[`s${n}` as keyof typeof USERS];
      const t = TOKENS[`s${n}` as keyof typeof TOKENS];
      expect((await review(n, u, t, { rating: n === 5 ? 1 : 5 })).status).toBe(201);
    }
    const after = await get(`/v1/products/${PRODUCT_1}/reviews`);
    // ratings: 5 (s1), 5, 5, 5, 1
    expect(after.body.summary).toEqual({ count: 5, average: 4.2, distribution: { "1": 1, "2": 0, "3": 0, "4": 0, "5": 4 } });
  });

  it("refuses an undelivered or foreign line with 404, identical to a missing one", async () => {
    const foreign = h.deliver(20, USERS.s2);
    const a = await post(`/v1/orders/lines/${foreign.orderLineId}/review`, TOKENS.s3, { rating: 4, body: BODY });
    const b = await post(`/v1/orders/lines/${U(999_999)}/review`, TOKENS.s3, { rating: 4, body: BODY });
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(a.body).toEqual({ ...b.body, request_id: a.body.request_id });
  });

  it("refuses a seller reviewing its own products", async () => {
    const r = await review(30, USERS.sellerShopper, TOKENS.sellerShopper, {}, { storeId: STORE_A });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("self_review_forbidden");
  });

  it("allows one review per order line", async () => {
    const l = h.deliver(31, USERS.s6);
    const first = await post(`/v1/orders/lines/${l.orderLineId}/review`, TOKENS.s6, { rating: 4, body: BODY });
    const second = await post(`/v1/orders/lines/${l.orderLineId}/review`, TOKENS.s6, { rating: 2, body: BODY + " again" });
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("already_reviewed");
  });

  it("enforces the review window from delivery", async () => {
    const r = await review(32, USERS.s7, TOKENS.s7, {}, { deliveredAtMs: h.clock.nowMs() - 200 * 24 * HOUR });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("review_window_elapsed");
  });

  it("validates input at the boundary", async () => {
    const l = h.deliver(33, USERS.s8);
    const path = `/v1/orders/lines/${l.orderLineId}/review`;
    expect((await post(path, TOKENS.s8, { rating: 6, body: BODY })).status).toBe(400);
    expect((await post(path, TOKENS.s8, { rating: 4, body: "tiny" })).status).toBe(400);
    expect((await post(path, TOKENS.s8, { rating: 4, body: BODY, user_id: USERS.s1 })).status).toBe(400);
    expect((await post(path, TOKENS.s8, { rating: 4, body: BODY, photo_ids: [U(800)] })).status).toBe(400);
    expect((await post(path, TOKENS.s8, { rating: 4, body: BODY }, {})).status).toBe(400);
  });

  it("requires a bearer token", async () => {
    const l = h.deliver(34, USERS.s8);
    expect((await post(`/v1/orders/lines/${l.orderLineId}/review`, null, { rating: 4, body: BODY })).status).toBe(401);
    expect((await post(`/v1/orders/lines/${l.orderLineId}/review`, TOKENS.sellerOnBuyerAud, { rating: 4, body: BODY })).status).toBe(403);
  });
});

describe("review moderation pipeline", () => {
  it("rejects toxic text, holds borderline text and classifier outages, and hides all three", async () => {
    const bad = await review(40, USERS.s9, TOKENS.s9, { body: "This is [[toxic]] garbage text for sure" });
    expect(bad.body.moderation_status).toBe("REJECTED");
    const border = await review(41, USERS.s9, TOKENS.s9, { body: "This is [[borderline]] kind of rude text" });
    expect(border.body.moderation_status).toBe("HELD");
    const down = await review(42, USERS.s9, TOKENS.s9, { body: "Classifier is [[down]] right now sorry" });
    expect(down.body.moderation_status).toBe("HELD");
    const contact = await review(43, USERS.s9, TOKENS.s9, { body: "Call me on 01001234567 for a discount" });
    expect(contact.body.moderation_status).toBe("HELD");
    const list = await get(`/v1/products/${PRODUCT_1}/reviews?limit=50`);
    const ids = list.body.items.map((i: { id: string }) => i.id);
    for (const r of [bad, border, down, contact]) expect(ids).not.toContain(r.body.id);
  });

  it("holds a review with a flagged photo and fails closed when the image classifier is down", async () => {
    const u = USERS.s9;
    const p1 = U(810);
    const p2 = U(811);
    h.photos.add(u, p1);
    h.photos.add(u, p2);
    h.images.flag(p1, { nsfw: 99, violence: 0 });
    h.images.flag(p2, "down");
    const a = await review(44, u, TOKENS.s9, { photo_ids: [p1] });
    expect(a.body.moderation_status).toBe("REJECTED");
    const b = await review(45, u, TOKENS.s9, { photo_ids: [p2] });
    expect(b.body.moderation_status).toBe("HELD");
    // another user's upload id is refused
    const c = await review(46, u, TOKENS.s9, { photo_ids: [U(812)] });
    expect(c.status).toBe(400);
  });

  it("forwards fit feedback and an identical reward intent for 1 and 5 stars", async () => {
    const before = h.store.events.length;
    h.photos.add(USERS.s4, U(820));
    h.photos.add(USERS.s5, U(821));
    await review(50, USERS.s4, TOKENS.s4, { rating: 1, fit: "too_small", fit_area: "chest", photo_ids: [U(820)] });
    await review(51, USERS.s5, TOKENS.s5, { rating: 5, fit: "too_small", fit_area: "chest", photo_ids: [U(821)] });
    const fresh = h.store.events.slice(before);
    const intents = fresh.flatMap((e) => (e.type === "review.reward_intent" ? [e] : []));
    expect(intents).toHaveLength(2);
    const strip = (e: (typeof intents)[number]) => ({ ...e.intent, orderLineId: "x" });
    expect(strip(intents[0] as (typeof intents)[number])).toEqual(strip(intents[1] as (typeof intents)[number]));
    expect(JSON.stringify(intents)).not.toMatch(/rating/);
    const fits = fresh.flatMap((e) => (e.type === "review.fit_feedback_submitted" ? [e] : []));
    expect(fits).toHaveLength(2);
    expect(fits[0]).toMatchObject({ fit: "too_small", fitArea: "chest", sizeLabel: "M", productId: PRODUCT_1 });
  });

  it("emits the reward intent once even after edits", async () => {
    const l = h.deliver(52, USERS.s2);
    const created = await post(`/v1/orders/lines/${l.orderLineId}/review`, TOKENS.s2, { rating: 3, body: BODY });
    const rewards = () => h.store.events.filter((e) => e.type === "review.reward_intent" && e.reviewId === created.body.id).length;
    expect(rewards()).toBe(1);
    const edited = await h
      .http()
      .patch(`/v1/me/reviews/${created.body.id as string}`)
      .set(bearer(TOKENS.s2))
      .send({ rating: 5, body: BODY + " Edited after wearing it." });
    expect(edited.status).toBe(200);
    expect(edited.body.moderation_status).toBe("PUBLISHED");
    expect(rewards()).toBe(1);
    expect(h.store.events.some((e) => e.type === "review.unpublished" && e.reviewId === created.body.id)).toBe(true);
  });
});

describe("author actions", () => {
  it("another user's edit or delete is 404 and changes nothing", async () => {
    const l = h.deliver(60, USERS.s3);
    const created = await post(`/v1/orders/lines/${l.orderLineId}/review`, TOKENS.s3, { rating: 4, body: BODY });
    const id = created.body.id as string;
    tick();
    const patch = await h.http().patch(`/v1/me/reviews/${id}`).set(bearer(TOKENS.s4)).send({ rating: 1, body: "Vandalised by someone else" });
    expect(patch.status).toBe(404);
    tick();
    const del = await h.http().delete(`/v1/me/reviews/${id}`).set(bearer(TOKENS.s4));
    expect(del.status).toBe(404);
    const missing = await h.http().patch(`/v1/me/reviews/${U(424_242)}`).set(bearer(TOKENS.s4)).send({ rating: 1, body: "Vandalised by someone else" });
    expect(missing.status).toBe(404);
    expect((await h.store.getReview(id))?.rating).toBe(4);
  });

  it("lists own reviews with status and lets the author delete", async () => {
    const list = await get("/v1/me/reviews", TOKENS.s9);
    expect(list.status).toBe(200);
    const statuses = list.body.items.map((i: { moderation_status: string }) => i.moderation_status);
    expect(statuses).toContain("HELD");
    expect(statuses).toContain("REJECTED");
    const mine = list.body.items[0] as { id: string };
    tick();
    expect((await h.http().delete(`/v1/me/reviews/${mine.id}`).set(bearer(TOKENS.s9))).status).toBe(204);
    expect((await get("/v1/me/reviews?cursor=garbage", TOKENS.s9)).status).toBe(400);
  });

  it("pages with keyset cursors without gaps or repeats", async () => {
    const first = await get(`/v1/products/${PRODUCT_1}/reviews?limit=2`);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.page.has_more).toBe(true);
    const seen = new Set<string>(first.body.items.map((i: { id: string }) => i.id));
    let cursor = first.body.page.next_cursor as string | null;
    while (cursor !== null) {
      const next = await get(`/v1/products/${PRODUCT_1}/reviews?limit=2&cursor=${encodeURIComponent(cursor)}`);
      for (const i of next.body.items as { id: string }[]) {
        expect(seen.has(i.id)).toBe(false);
        seen.add(i.id);
      }
      cursor = next.body.page.next_cursor as string | null;
    }
    expect(seen.size).toBeGreaterThanOrEqual(6);
  });
});

describe("seller reply", () => {
  let reviewId: string;
  beforeAll(async () => {
    const l = h.deliver(70, USERS.s7);
    const r = await post(`/v1/orders/lines/${l.orderLineId}/review`, TOKENS.s7, { rating: 2, body: "Stitching came loose after a week." });
    reviewId = r.body.id as string;
  });

  it("another store's seller gets 404; the owning store's support role gets 403", async () => {
    expect((await post(`/v1/seller/reviews/${reviewId}/reply`, TOKENS.ownerB, { body: "Hello" })).status).toBe(404);
    expect((await post(`/v1/seller/reviews/${reviewId}/reply`, TOKENS.supportA, { body: "Hello" })).status).toBe(403);
    expect((await post(`/v1/seller/reviews/${reviewId}/reply`, TOKENS.s1, { body: "Hello" })).status).toBe(401);
    expect((await post(`/v1/seller/reviews/${reviewId}/reply`, TOKENS.shopperOnSellerAud, { body: "Hello" })).status).toBe(403);
    expect((await post(`/v1/seller/reviews/${U(424_242)}/reply`, TOKENS.ownerA, { body: "Hello" })).status).toBe(404);
  });

  it("publishes the owning store's reply after moderation and hides toxic ones", async () => {
    const ok = await post(`/v1/seller/reviews/${reviewId}/reply`, TOKENS.catalogA, { body: "Sorry about that, we will replace it." });
    expect(ok.status).toBe(200);
    expect(ok.body.moderation_status).toBe("PUBLISHED");
    const pub = await get(`/v1/products/${PRODUCT_1}/reviews?limit=50`);
    const item = pub.body.items.find((i: { id: string }) => i.id === reviewId);
    expect(item.seller_reply).toMatchObject({ body: "Sorry about that, we will replace it." });
    const bad = await post(`/v1/seller/reviews/${reviewId}/reply`, TOKENS.ownerA, { body: "You are [[toxic]] liar" });
    expect(bad.body.moderation_status).toBe("REJECTED");
    const after = await get(`/v1/products/${PRODUCT_1}/reviews?limit=50`);
    expect(after.body.items.find((i: { id: string }) => i.id === reviewId).seller_reply).toBeNull();
  });

  it("lists only the caller's store reviews", async () => {
    const mine = await get("/v1/seller/reviews?limit=50", TOKENS.ownerA);
    expect(mine.status).toBe(200);
    expect(mine.body.items.length).toBeGreaterThan(0);
    const other = await get("/v1/seller/reviews", TOKENS.ownerB);
    expect(other.body.items).toEqual([]);
    expect(JSON.stringify(mine.body)).not.toContain(USERS.s7);
  });
});

describe("Q&A with the 48h seller SLA", () => {
  it("publishes a question, tracks the SLA, flags a breach once, and stops when answered", async () => {
    const asked = await post(`/v1/products/${PRODUCT_1}/questions`, TOKENS.s1, { body: "Does this run small in the shoulders?" });
    expect(asked.status).toBe(201);
    expect(asked.body.moderation_status).toBe("PUBLISHED");
    const qid = asked.body.id as string;

    const pub = await get(`/v1/products/${PRODUCT_1}/questions`);
    expect(pub.body.items[0]).toMatchObject({ id: qid, asker_initial: "S", answers: [] });
    expect(JSON.stringify(pub.body)).not.toContain(USERS.s1);

    const open = await get("/v1/seller/questions?unanswered=true", TOKENS.ownerA);
    expect(open.body.items[0]).toMatchObject({ id: qid, answered: false, sla_overdue: false });
    const stored = await h.store.getQuestion(qid);
    expect(stored?.publishedAtMs).not.toBeNull();
    expect(Date.parse(open.body.items[0].sla_due_at as string)).toBe((stored?.publishedAtMs ?? 0) + 48 * HOUR);

    expect(await h.sweepSla.execute()).toBe(0);
    h.clock.advance(48 * HOUR);
    expect(await h.sweepSla.execute()).toBe(1);
    expect(await h.sweepSla.execute()).toBe(0);
    expect(h.store.events.filter((e) => e.type === "qa.sla_breached" && e.questionId === qid)).toHaveLength(1);
    const late = await get("/v1/seller/questions?unanswered=true", TOKENS.ownerA);
    expect(late.body.items[0]).toMatchObject({ id: qid, sla_overdue: true });

    // another store's seller cannot answer (404), the owner can
    expect((await post(`/v1/seller/questions/${qid}/answer`, TOKENS.ownerB, { body: "Runs true to size." })).status).toBe(404);
    const ans = await post(`/v1/seller/questions/${qid}/answer`, TOKENS.ownerA, { body: "Runs true to size." });
    expect(ans.body.moderation_status).toBe("PUBLISHED");
    const done = await get(`/v1/products/${PRODUCT_1}/questions`);
    expect(done.body.items[0].answers[0]).toMatchObject({ body: "Runs true to size.", by: "seller" });
    expect((await get("/v1/seller/questions?unanswered=true", TOKENS.ownerA)).body.items).toEqual([]);
  });

  it("returns 404 for an unknown product and validates the question", async () => {
    expect((await post(`/v1/products/${U(424_242)}/questions`, TOKENS.s1, { body: "Does this exist at all?" })).status).toBe(404);
    expect((await post(`/v1/products/${PRODUCT_2}/questions`, TOKENS.s1, { body: "hi" })).status).toBe(400);
    expect((await post(`/v1/products/${PRODUCT_2}/questions`, null, { body: "Does this exist at all?" })).status).toBe(401);
  });
});

describe("reports", () => {
  let target: string;
  beforeAll(async () => {
    const l = h.deliver(80, USERS.s8);
    const r = await post(`/v1/orders/lines/${l.orderLineId}/review`, TOKENS.s8, { rating: 3, body: "Average quality for the price." });
    target = r.body.id as string;
  });
  const report = (token: string, id: string, reason = "spam") =>
    post("/v1/ugc/reports", token, { target_type: "review", target_id: id, reason });

  it("accepts a report, counts a duplicate once, and rejects own content and unknown targets", async () => {
    expect((await report(TOKENS.s1, target)).status).toBe(202);
    expect((await report(TOKENS.s1, target)).status).toBe(202);
    expect(await h.store.countDistinctReporters("review", target)).toBe(1);
    const own = await report(TOKENS.s8, target);
    expect(own.status).toBe(422);
    expect(own.body.code).toBe("own_content");
    expect((await report(TOKENS.s1, U(424_242))).status).toBe(404);
    expect((await report(TOKENS.s1, target, "bogus")).status).toBe(400);
    expect((await post("/v1/ugc/reports", null, { target_type: "review", target_id: target, reason: "spam" })).status).toBe(401);
  });

  it("holds the item after enough distinct reporters, and the moderation console can reinstate it", async () => {
    expect((await report(TOKENS.s2, target)).status).toBe(202);
    expect((await h.store.getReview(target))?.status).toBe("PUBLISHED");
    expect((await report(TOKENS.s3, target)).status).toBe(202);
    expect((await h.store.getReview(target))?.status).toBe("HELD");
    expect((await h.store.getReview(target))?.holdReason).toBe("reported");
    // no longer visible and no longer reportable
    expect((await report(TOKENS.s4, target)).status).toBe(404);

    const queue = await get("/v1/admin/moderation/queue?status=HELD", TOKENS.moderator);
    expect(queue.status).toBe(200);
    expect(queue.body.items.map((i: { target_id: string }) => i.target_id)).toContain(target);
    const decision = await post(`/v1/admin/moderation/review/${target}/decision`, TOKENS.moderator, { decision: "publish" });
    expect(decision.status).toBe(200);
    expect(decision.body.status).toBe("PUBLISHED");
    const again = await post(`/v1/admin/moderation/review/${target}/decision`, TOKENS.moderator, { decision: "publish" });
    expect(again.status).toBe(409);
    const log = await h.store.moderationLog("review", target);
    expect(log.map((l) => l.actorKind)).toEqual(expect.arrayContaining(["system", "reports", "moderator"]));
  });
});

describe("moderation routes authorization", () => {
  const routes = [
    (t: string | null) => get("/v1/admin/moderation/queue", t),
    (t: string | null) => post(`/v1/admin/moderation/review/${U(101)}/decision`, t, { decision: "reject" }),
  ];

  it("401 without a token or with the wrong audience", async () => {
    for (const send of routes) {
      expect((await send(null)).status).toBe(401);
      expect((await send(TOKENS.s1)).status).toBe(401);
    }
  });

  it("403 for a shopper identity on the admin audience and for a non-moderator admin", async () => {
    for (const send of routes) {
      expect((await send(TOKENS.shopperOnAdminAud)).status).toBe(403);
      expect((await send(TOKENS.adminSupport)).status).toBe(403);
    }
  });

  it("404 for an unknown item and 409 for an invalid transition when a moderator decides", async () => {
    expect((await post(`/v1/admin/moderation/review/${U(424_242)}/decision`, TOKENS.moderator, { decision: "reject" })).status).toBe(404);
    const rejected = (await h.store.listModeration({ statuses: ["REJECTED"], type: "review" }, { after: null, limit: 1 }))[0];
    expect(rejected).toBeDefined();
    const r = await post(`/v1/admin/moderation/review/${rejected?.id}/decision`, TOKENS.moderator, { decision: "publish" });
    expect(r.status).toBe(409);
  });
});

describe("seller routes authorization", () => {
  it("401 and 403 matrix", async () => {
    const routes = [
      (t: string | null) => get("/v1/seller/reviews", t),
      (t: string | null) => get("/v1/seller/questions", t),
    ];
    for (const send of routes) {
      expect((await send(null)).status).toBe(401);
      expect((await send(TOKENS.sellerOnBuyerAud)).status).toBe(401);
      expect((await send(TOKENS.shopperOnSellerAud)).status).toBe(403);
    }
  });
});
