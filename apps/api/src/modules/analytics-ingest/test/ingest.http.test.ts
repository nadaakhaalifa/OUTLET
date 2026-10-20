import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ATTEST, EV, PRODUCT, SHOPPER, STORE, T0, TOKENS, batch, createIngestHarness, idemKey, iso, viewEvent,
  type IngestHarness,
} from "./harness";

let h: IngestHarness;
beforeEach(async () => {
  h = await createIngestHarness();
});
afterEach(async () => {
  await h.close();
});

const ok = (n = 1) => batch(T0, Array.from({ length: n }, (_, i) => viewEvent(i + 1, T0 - 1000)));

describe("POST /v1/analytics/events: switch, authn, attestation", () => {
  it("is blocked by default: 503 analytics_ingest_disabled and nothing is stored", async () => {
    h.gate.set(false);
    const r = await h.post(TOKENS.shopperS1, ok());
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("analytics_ingest_disabled");
    expect(h.outbox.rows).toHaveLength(0);
  });

  it("rejects no token, seller and admin tokens", async () => {
    expect((await h.post(null, ok())).status).toBe(401);
    expect((await h.post(TOKENS.seller, ok())).status).toBe(401);
    expect((await h.post(TOKENS.admin, ok())).status).toBe(401);
    expect(h.outbox.rows).toHaveLength(0);
  });

  it("missing or invalid attestation is 401 attestation_required and counted", async () => {
    const none = await h.post(TOKENS.shopperS1, ok(), { headers: {} });
    expect(none.status).toBe(401);
    expect(none.body.code).toBe("attestation_required");
    const bad = await h.post(TOKENS.shopperS1, ok(), { headers: { "X-App-Attest": "garbage", "X-Client-Platform": "ios" } });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe("attestation_required");
    const badPlatform = await h.post(TOKENS.shopperS1, ok(), { headers: { "X-App-Attest": "ok:x", "X-Client-Platform": "web" } });
    expect(badPlatform.status).toBe(401);
    expect(h.counters.get("attestation_required")).toBe(3);
    expect(h.outbox.rows).toHaveLength(0);
  });

  it("answers 202 with accepted, duplicates and rejected, and stores one outbox row without any user id", async () => {
    const r = await h.post(TOKENS.shopperS1, ok(2));
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ accepted: 2, duplicates: 0, rejected: 0 });
    expect(h.outbox.rows).toHaveLength(1);
    const row = h.outbox.rows[0];
    expect(row?.type).toBe("analytics.client_batch");
    expect(row?.aggregateType).toBe("analytics_batch");
    const json = JSON.stringify(row);
    expect(json).not.toContain(SHOPPER);
    expect(json).toMatch(/"shopper_key":"[0-9a-f]{64}"/);
  });

  it("a replay with the same Idempotency-Key returns the stored response and writes no second row", async () => {
    const key = idemKey();
    const a = await h.post(TOKENS.shopperS1, ok(), { key });
    const b = await h.post(TOKENS.shopperS1, ok(), { key });
    expect(b.status).toBe(a.status);
    expect(b.body).toEqual(a.body);
    expect(h.outbox.rows).toHaveLength(1);
  });

  it("requires an Idempotency-Key", async () => {
    const r = await h.app.getHttpServer();
    const res = await (await import("supertest")).default(r).post("/v1/analytics/events").set("Authorization", `Bearer ${TOKENS.shopperS1}`).set(ATTEST).send(ok());
    expect(res.status).toBe(400);
  });
});

describe("strict schema and forbidden keys", () => {
  for (const key of ["user_id", "measurements", "budget_remaining", "phone", "email", "address", "dob"]) {
    it(`rejects the whole batch with 400 forbidden_property when ${key} appears (nothing stored)`, async () => {
      const ev = { ...viewEvent(1, T0 - 1000), properties: { store_id: STORE, product_id: PRODUCT(1), source: "feed", [key]: "x" } };
      const r = await h.post(TOKENS.shopperS1, batch(T0, [ev, viewEvent(2, T0 - 1000)]));
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("forbidden_property");
      expect(h.outbox.rows).toHaveLength(0);
    });
  }

  it("rejects a forbidden key at the envelope level too", async () => {
    const r = await h.post(TOKENS.shopperS1, { ...ok(), user_id: SHOPPER });
    expect(r.status).toBe(400);
    expect(h.outbox.rows).toHaveLength(0);
  });

  it("an unknown key or enum value fails that event only", async () => {
    const unknown = { ...viewEvent(1, T0 - 1000), properties: { store_id: STORE, product_id: PRODUCT(1), source: "feed", extra: 1 } };
    const badEnum = viewEvent(2, T0 - 1000, "tiktok");
    const r = await h.post(TOKENS.shopperS1, batch(T0, [unknown, badEnum, viewEvent(3, T0 - 1000)]));
    expect(r.body).toEqual({ accepted: 1, duplicates: 0, rejected: 2 });
    expect(h.counters.get("invalid_event")).toBe(2);
  });

  it("51 events is 400 and 0 events is 400", async () => {
    expect((await h.post(TOKENS.shopperS1, ok(51))).status).toBe(400);
    expect((await h.post(TOKENS.shopperS1, batch(T0, []))).status).toBe(400);
    expect(h.outbox.rows).toHaveLength(0);
  });

  it("a body above 64 KB is 413", async () => {
    const big = batch(T0, [{ ...viewEvent(1, T0 - 1000), pad: "x".repeat(70_000) }]);
    const r = await h.post(TOKENS.shopperS1, big);
    expect(r.status).toBe(413);
    expect(h.outbox.rows).toHaveLength(0);
  });
});

describe("consent (M4): re-checked on every batch, uncached", () => {
  it("a user without consent gets 202 accepted 0 and no outbox row", async () => {
    h.consent.set(SHOPPER, false);
    const r = await h.post(TOKENS.shopperS1, ok());
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ accepted: 0, duplicates: 0, rejected: 0 });
    expect(h.outbox.rows).toHaveLength(0);
    expect(h.counters.get("no_consent")).toBe(1);
  });

  it("withdraw consent, then a batch within 1 s: accepted 0 and no new outbox row", async () => {
    const first = await h.post(TOKENS.shopperS1, ok());
    expect(first.body.accepted).toBe(1);
    expect(h.outbox.rows).toHaveLength(1);
    h.consent.set(SHOPPER, false);
    h.clock.advance(500);
    const second = await h.post(TOKENS.shopperS1, batch(h.clock.nowMs(), [viewEvent(9, h.clock.nowMs() - 100)]));
    expect(second.status).toBe(202);
    expect(second.body.accepted).toBe(0);
    expect(h.outbox.rows).toHaveLength(1);
  });
});

describe("plausibility", () => {
  it("rejects sent_at more than 5 minutes ahead", async () => {
    const r = await h.post(TOKENS.shopperS1, batch(T0 + 6 * 60_000, [viewEvent(1, T0)]));
    expect(r.body).toEqual({ accepted: 0, duplicates: 0, rejected: 1 });
    expect(h.counters.get("sent_at_future")).toBe(1);
    expect(h.outbox.rows).toHaveLength(0);
  });

  it("rejects occurred_at after sent_at + 5 s, and outside 7 days back / 5 minutes ahead", async () => {
    const after = viewEvent(1, T0 + 6_000);
    const tooOld = viewEvent(2, T0 - 8 * 86_400_000);
    const justOk = viewEvent(3, T0 + 4_000);
    const r = await h.post(TOKENS.shopperS1, batch(T0, [after, tooOld, justOk]));
    expect(r.body).toEqual({ accepted: 1, duplicates: 0, rejected: 2 });
    expect(h.counters.get("occurred_after_sent_at")).toBe(1);
    expect(h.counters.get("occurred_out_of_range")).toBe(1);
  });

  const impressions = (n: number, count: number, surface = "feed", firstProduct = n * 100) => ({
    event_id: EV(n),
    name: "product_impressions",
    occurred_at: iso(T0 - 1000),
    properties: {
      surface,
      items: Array.from({ length: count }, (_, i) => ({ product_id: PRODUCT(firstProduct + i), store_id: STORE, position: i })),
    },
  });

  it("rejects the 31st impression on a surface within a minute, and allows another surface", async () => {
    const a = await h.post(TOKENS.shopperS1, batch(T0, [impressions(1, 30)]));
    expect(a.body.accepted).toBe(1);
    const b = await h.post(TOKENS.shopperS1, batch(T0, [impressions(2, 1, "feed", 9000)]));
    expect(b.body).toEqual({ accepted: 0, duplicates: 0, rejected: 1 });
    expect(h.counters.get("impression_cap")).toBe(1);
    const c = await h.post(TOKENS.shopperS1, batch(T0, [impressions(3, 5, "search", 9100)]));
    expect(c.body.accepted).toBe(1);
  });

  it("the cap resets after the window", async () => {
    await h.post(TOKENS.shopperS1, batch(T0, [impressions(1, 30)]));
    h.clock.advance(61_000);
    const r = await h.post(TOKENS.shopperS1, batch(h.clock.nowMs(), [{ ...impressions(2, 1, "feed", 9000), occurred_at: iso(h.clock.nowMs() - 1000) }]));
    expect(r.body.accepted).toBe(1);
  });

  it("counts the same (product, surface) twice within 15 minutes once, and again after 15 minutes", async () => {
    const a = await h.post(TOKENS.shopperS1, batch(T0, [impressions(1, 1, "feed", 500)]));
    const b = await h.post(TOKENS.shopperS1, batch(T0, [impressions(2, 1, "feed", 500)]));
    expect(a.body.accepted).toBe(1);
    expect(b.body).toEqual({ accepted: 0, duplicates: 1, rejected: 0 });
    h.clock.advance(16 * 60_000);
    const now = h.clock.nowMs();
    const c = await h.post(TOKENS.shopperS1, batch(now, [{ ...impressions(3, 1, "feed", 500), occurred_at: iso(now - 1000) }]));
    expect(c.body.accepted).toBe(1);
  });

  it("dedupes repeated product views per (product, source) and a re-sent event_id", async () => {
    await h.post(TOKENS.shopperS1, batch(T0, [viewEvent(1, T0 - 1000)]));
    const sameProduct = await h.post(TOKENS.shopperS1, batch(T0, [viewEvent(2, T0 - 900, "feed", PRODUCT(1))]));
    expect(sameProduct.body.duplicates).toBe(1);
    const resentId = await h.post(TOKENS.shopperS1, batch(T0, [viewEvent(1, T0 - 1000, "search", PRODUCT(77))]));
    expect(resentId.body).toEqual({ accepted: 0, duplicates: 1, rejected: 0 });
    expect(h.outbox.rows).toHaveLength(1);
  });

  it("rejects duplicate positions inside one impressions event", async () => {
    const ev = impressions(1, 2);
    ev.properties.items[1]!.position = 0;
    const r = await h.post(TOKENS.shopperS1, batch(T0, [ev]));
    expect(r.body.rejected).toBe(1);
    expect(h.counters.get("duplicate_position")).toBe(1);
  });

  it("fails closed with 503 when the plausibility store is down, and stores nothing", async () => {
    h.store.down = true;
    const r = await h.post(TOKENS.shopperS1, ok());
    expect(r.status).toBe(503);
    expect(h.outbox.rows).toHaveLength(0);
  });

  it("a failed outbox write is 503 and does not turn the client's retry into duplicates", async () => {
    h.outbox.failNext = true;
    const a = await h.post(TOKENS.shopperS1, ok());
    expect(a.status).toBe(503);
    const b = await h.post(TOKENS.shopperS1, ok());
    expect(b.body).toEqual({ accepted: 1, duplicates: 0, rejected: 0 });
    expect(h.outbox.rows).toHaveLength(1);
  });
});

describe("rate limits are keyed on user and session, not the install id", () => {
  it("the 61st batch of one session in a minute is 429 while a second session of the same user is accepted", async () => {
    for (let i = 0; i < 60; i += 1) {
      const r = await h.post(TOKENS.shopperS1, batch(T0, [viewEvent(i + 1, T0 - 1000, "feed", PRODUCT(i + 1))]));
      expect(r.status).toBe(202);
    }
    const over = await h.post(TOKENS.shopperS1, batch(T0, [viewEvent(1000, T0 - 1000, "feed", PRODUCT(1000))]));
    expect(over.status).toBe(429);
    const second = await h.post(TOKENS.shopperS2, batch(T0, [viewEvent(1001, T0 - 1000, "feed", PRODUCT(1001))]));
    expect(second.status).toBe(202);
  });

  it("caps events per user at 600 per minute across sessions (429)", async () => {
    let status = 202;
    for (let i = 0; i < 13 && status === 202; i += 1) {
      const evs = Array.from({ length: 50 }, (_, j) => viewEvent(i * 100 + j + 1, T0 - 1000, "feed", PRODUCT(i * 100 + j + 1)));
      const token = i % 2 === 0 ? TOKENS.shopperS1 : TOKENS.shopperS2;
      status = (await h.post(token, batch(T0, evs))).status;
    }
    expect(status).toBe(429);
    expect(h.counters.get("user_event_cap")).toBeGreaterThan(0);
  });
});

describe("search terms (M9)", () => {
  const click = (n: number, term: string) => ({
    event_id: EV(n),
    name: "search_result_clicked",
    occurred_at: iso(T0 - 1000),
    properties: { store_id: STORE, product_id: PRODUCT(n), term },
  });

  it("rejects phone numbers with separators, emails and URLs", async () => {
    const r = await h.post(TOKENS.shopperS1, batch(T0, [
      click(1, "call 0100 123 4567"), click(2, "me@example.com"), click(3, "https://evil.test/x"), click(4, "٠١٠٠١٢٣٤٥٦٧"),
    ]));
    expect(r.body).toEqual({ accepted: 0, duplicates: 0, rejected: 4 });
    expect(h.counters.get("term_pii_shape")).toBe(4);
    expect(h.outbox.rows).toHaveLength(0);
  });

  it("drops terms below the minimum length", async () => {
    const r = await h.post(TOKENS.shopperS1, batch(T0, [click(1, "ab")]));
    expect(r.body.rejected).toBe(1);
  });

  it("keeps an all-vocabulary term in clear and stores any other term only as a hash", async () => {
    const r = await h.post(TOKENS.shopperS1, batch(T0, [click(1, "White  LINEN dress"), click(2, "Mohamed Ahmed Hassan"), click(3, "dress ahmed")]));
    expect(r.body.accepted).toBe(3);
    const events = (h.outbox.rows[0]?.payload as { events: { properties: Record<string, unknown> }[] }).events;
    expect(events[0]?.properties["term"]).toBe("white linen dress");
    expect(events[1]?.properties["term"]).toBeUndefined();
    expect(events[1]?.properties["term_hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(events[2]?.properties["term"]).toBeUndefined();
    const json = JSON.stringify(h.outbox.rows[0]);
    expect(json).not.toMatch(/mohamed|ahmed|hassan/i);
  });
});
