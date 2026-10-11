import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DAY,
  IDEM,
  P,
  S,
  TOKENS,
  USERS,
  bearer,
  cand,
  createHarness,
  type Harness,
} from "./test/harness";
import { FakeAffordability } from "./index";
import type { Test } from "supertest";

let h: Harness;
let seq = 0;
const idem = (): Record<string, string> => ({ "Idempotency-Key": IDEM(++seq) });
const afford = new FakeAffordability(150_000n);

beforeAll(async () => {
  h = await createHarness({ affordability: afford });
  // 12 products over 4 stores; store 1 dominates popularity.
  for (let n = 1; n <= 12; n++) h.addProduct(cand(n, n <= 6 ? 1 : ((n % 3) + 2)));
  h.addProduct(cand(20, 5, { isNewSeller: true, popularity: 1, categoryId: "shoes" }));
}, 60_000);
afterAll(async () => {
  await h.close();
});

const tick = (): void => h.clock.advance(61_000);
const get = (path: string, token: string | null = null) => {
  tick();
  const r = h.http().get(path);
  return token === null ? r : r.set(bearer(token));
};
const send = (method: "post" | "patch" | "delete", path: string, token: string | null, body?: unknown) => {
  tick();
  const r = h.http()[method](path).set(idem());
  const withAuth = token === null ? r : r.set(bearer(token));
  return body === undefined ? withAuth : withAuth.send(body as object);
};

describe("feed personalization", () => {
  it("consented, fresh features: personalized feed; ranker receives user features", async () => {
    h.consent.grant(USERS.a);
    await h.record.execute({ userId: USERS.a, type: "viewed", itemId: P(7), storeId: S(2), categoryId: "dress" });
    expect(await h.build.execute(USERS.a)).toBe("built");
    h.ranker.calls.length = 0;
    const r = await get("/v1/feed", TOKENS.a);
    expect(r.status).toBe(200);
    expect(r.body.personalized).toBe(true);
    expect(h.ranker.calls.at(-1)?.personalized).toBe(true);
    expect(h.ranker.calls.at(-1)?.features).not.toBeNull();
  });

  it("personalized=false: ranker receives NO user features and the feature store is never read", async () => {
    h.ranker.calls.length = 0;
    h.personalization.featureReads.length = 0;
    const r = await get("/v1/feed?personalized=false", TOKENS.a);
    expect(r.status).toBe(200);
    expect(r.body.personalized).toBe(false);
    expect(r.body.personalization_reason).toBe("requested_off");
    expect(h.ranker.calls).toHaveLength(1);
    expect(h.ranker.calls[0]?.features).toBeNull();
    expect(h.ranker.calls[0]?.personalized).toBe(false);
    expect(h.personalization.featureReads).toEqual([]);
  });

  it("PATCH /me/settings personalization=false: later feed is non-personal, features are deleted", async () => {
    const r = await send("patch", "/v1/me/settings", TOKENS.a, { personalization: false });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ personalization: false, history_paused: false });
    expect(await h.history.getFeatures(USERS.a)).toBeNull();
    h.ranker.calls.length = 0;
    h.personalization.featureReads.length = 0;
    const f = await get("/v1/feed", TOKENS.a);
    expect(f.body.personalized).toBe(false);
    expect(f.body.personalization_reason).toBe("setting_off");
    expect(h.ranker.calls[0]?.features).toBeNull();
    expect(h.personalization.featureReads).toEqual([]);
    await send("patch", "/v1/me/settings", TOKENS.a, { personalization: true });
  });

  it("withdrawn consent: feed falls back to non-personal without reading features", async () => {
    h.consent.withdraw(USERS.a);
    h.personalization.featureReads.length = 0;
    const f = await get("/v1/feed", TOKENS.a);
    expect(f.body.personalization_reason).toBe("no_consent");
    expect(h.personalization.featureReads).toEqual([]);
    h.consent.grant(USERS.a);
  });

  it("stale features (> 24h) fail closed to non-personal", async () => {
    await h.build.execute(USERS.a);
    h.clock.advance(25 * 3_600_000);
    const f = await get("/v1/feed", TOKENS.a);
    expect(f.body.personalized).toBe(false);
    expect(f.body.personalization_reason).toBe("no_features");
  });

  it("kill.ml_ranking off: non-personal, no exploration", async () => {
    h.flags.mlRanking = false;
    const f = await get("/v1/feed", TOKENS.a);
    expect(f.body.personalization_reason).toBe("kill_switch");
    expect(f.body.items.some((i: { reason: string }) => i.reason === "new_seller")).toBe(false);
    h.flags.mlRanking = true;
  });

  it("ranker down: popularity fallback, flagged degraded", async () => {
    h.ranker.down = true;
    const f = await get("/v1/feed?personalized=false", TOKENS.b);
    expect(f.status).toBe(200);
    expect(f.body.degraded).toContain("ranker_down");
    expect(f.body.items.length).toBeGreaterThan(0);
    h.ranker.down = false;
  });

  it("diversity: no more than two consecutive items of one store while others remain", async () => {
    const f = await get("/v1/feed?personalized=false&limit=12", TOKENS.b);
    const stores = (f.body.items as { store_id: string }[]).map((i) => i.store_id);
    let run = 1;
    for (let i = 1; i < stores.length; i++) {
      run = stores[i] === stores[i - 1] ? run + 1 : 1;
      if (run > 2) expect(stores.slice(i).every((s) => s === stores[i])).toBe(true);
    }
  });

  it("exploration never exceeds 5% of the list", async () => {
    for (let n = 30; n < 60; n++) h.addProduct(cand(n, 6, { isNewSeller: true, popularity: 1 }));
    const f = await get("/v1/feed?personalized=false&limit=50", TOKENS.b);
    const explored = (f.body.items as { reason: string }[]).filter((i) => i.reason === "new_seller").length;
    expect(f.body.items.length).toBeLessThanOrEqual(50);
    expect(explored).toBeLessThanOrEqual(2);
  });

  it("affordable=true applies the request-time filter and nothing is persisted", async () => {
    h.addProduct(cand(40, 1, { priceMinor: 900_000n, popularity: 500 }));
    const f = await get("/v1/feed?personalized=false&affordable=true&limit=50", TOKENS.b);
    expect(f.body.affordability_applied).toBe(true);
    expect((f.body.items as { price_piastres: string }[]).every((i) => BigInt(i.price_piastres) <= 150_000n)).toBe(true);
    expect(afford.calls).toContain(USERS.b);
    expect(JSON.stringify(await h.history.getFeatures(USERS.b))).not.toMatch(/afford|budget/i);
  });

  it("never exposes user ids, scores or feature values, and no fake discount", async () => {
    const f = await get("/v1/feed?personalized=false", TOKENS.b);
    const text = JSON.stringify(f.body);
    expect(text).not.toContain(USERS.b);
    for (const i of f.body.items as { verified_discount_pct: number | null; sponsored: boolean }[]) {
      expect(i.verified_discount_pct).toBeNull();
      expect(i.sponsored).toBe(false);
    }
  });
});

describe("similar, similar for less, goes with", () => {
  it("similar-for-less only returns cheaper items whose claim is allowed", async () => {
    h.addProduct(cand(50, 1, { priceMinor: 200_000n }));
    h.addProduct(cand(51, 2, { priceMinor: 150_000n, claimAllowed: true, verifiedDiscountPct: 25 }));
    h.addProduct(cand(52, 3, { priceMinor: 120_000n, claimAllowed: false, verifiedDiscountPct: 40 }));
    h.addProduct(cand(53, 4, { priceMinor: 250_000n, claimAllowed: true, verifiedDiscountPct: 10 }));
    for (const n of [50, 51, 52, 53]) h.vectors.set(P(n), [1, n / 100, 0]);
    const r = await get(`/v1/products/${P(50)}/similar?mode=for_less`);
    expect(r.status).toBe(200);
    const ids = (r.body.items as { product_id: string }[]).map((i) => i.product_id);
    expect(ids).toEqual([P(51)]);
    expect(r.body.items[0].verified_discount_pct).toBe(25);
  });

  it("similar falls back to category rules when the ANN index is down", async () => {
    h.vectors.down = true;
    const r = await get(`/v1/products/${P(50)}/similar`);
    expect(r.status).toBe(200);
    expect(r.body.degraded).toBe(true);
    expect(r.body.items.length).toBeGreaterThan(0);
    h.vectors.down = false;
  });

  it("goes-with uses co-buy and excludes the anchor's category", async () => {
    h.addProduct(cand(60, 2, { categoryId: "shoes" }));
    h.addProduct(cand(61, 2, { categoryId: "dress" }));
    await h.reco.upsertCooccurrence(
      [
        { itemA: P(50), itemB: P(60), kind: "co_buy", score: 9, windowDays: 90 },
        { itemA: P(50), itemB: P(61), kind: "co_buy", score: 8, windowDays: 90 },
      ],
      h.clock.nowMs(),
    );
    const r = await get(`/v1/products/${P(50)}/similar?mode=goes_with`);
    expect((r.body.items as { product_id: string }[]).map((i) => i.product_id)).toEqual([P(60)]);
  });

  it("unknown product, suspended store: 404; bad id: 400; anonymous allowed", async () => {
    expect((await get(`/v1/products/${P(999)}/similar`)).status).toBe(404);
    h.addProduct(cand(70, 7, { storeActive: false }));
    expect((await get(`/v1/products/${P(70)}/similar`)).status).toBe(404);
    expect((await get("/v1/products/not-a-uuid/similar")).status).toBe(400);
  });

  it("suspended store items are filtered at read", async () => {
    h.addProduct(cand(71, 7, { storeActive: false }));
    h.vectors.set(P(71), [1, 0.5, 0]);
    const r = await get(`/v1/products/${P(50)}/similar`);
    expect((r.body.items as { product_id: string }[]).map((i) => i.product_id)).not.toContain(P(71));
  });
});

describe("restock and price drops", () => {
  it("restock reminder for a kept basic after the interval; empty without consent", async () => {
    h.addProduct(cand(80, 2, { categoryId: "basics" }));
    h.catalog.setBasic(P(80), 30);
    await h.record.execute({ userId: USERS.a, type: "bought", itemId: P(80), atMs: h.clock.nowMs() - 40 * DAY });
    h.consent.grant(USERS.a);
    const r = await get("/v1/me/recommendations/restock", TOKENS.a);
    expect((r.body.items as { product_id: string }[]).map((i) => i.product_id)).toEqual([P(80)]);
    expect(r.body.items[0].reason).toBe("restock");
    h.consent.withdraw(USERS.a);
    const r2 = await get("/v1/me/recommendations/restock", TOKENS.a);
    expect(r2.body).toEqual({ items: [], personalized: false });
    h.consent.grant(USERS.a);
  });

  it("price-dropped-on-viewed reports a fact with piastres, never a discount claim", async () => {
    h.addProduct(cand(81, 2, { priceMinor: 100_000n }));
    expect((await send("post", `/v1/me/recently-viewed`, TOKENS.a, { product_id: P(81) })).status).toBe(200);
    h.addProduct(cand(81, 2, { priceMinor: 80_000n }));
    const r = await get("/v1/me/recommendations/price-drops", TOKENS.a);
    const row = (r.body.items as { product_id: string; price_drop: { drop_piastres: string }; verified_discount_pct: null }[]).find(
      (i) => i.product_id === P(81),
    );
    expect(row?.price_drop.drop_piastres).toBe("20000");
    expect(row?.verified_discount_pct).toBeNull();
  });
});

describe("clicks", () => {
  it("records a click for a known product and ignores unknown ones", async () => {
    const before = h.reco.statsFor(P(1), "feed").clicks;
    const r = await send("post", "/v1/recommendations/clicks", TOKENS.a, { module: "feed", product_id: P(1), model_version: "ltr-v1" });
    expect(r.status).toBe(204);
    expect(h.reco.statsFor(P(1), "feed").clicks).toBe(before + 1);
    await send("post", "/v1/recommendations/clicks", TOKENS.a, { module: "feed", product_id: P(9999), model_version: "x" });
    expect(h.reco.statsFor(P(9999), "feed")).toEqual({ impressions: 0, clicks: 0 });
    expect((await send("post", "/v1/recommendations/clicks", TOKENS.a, { module: "nope", product_id: P(1), model_version: "x" })).status).toBe(400);
  });
});

describe("authorization matrix", () => {
  const authed: [string, string][] = [
    ["get", "/v1/feed"],
    ["get", "/v1/me/recommendations/restock"],
    ["get", "/v1/me/recommendations/price-drops"],
    ["post", "/v1/recommendations/clicks"],
    ["get", "/v1/me/history"],
    ["delete", "/v1/me/history"],
    ["post", "/v1/me/history/pause"],
    ["patch", "/v1/me/settings"],
    ["get", "/v1/me/recently-viewed"],
    ["post", "/v1/me/recently-viewed"],
  ];
  const call = (m: string, path: string, token: string | null) => {
    tick();
    let r = (h.http() as unknown as Record<string, (p: string) => Test>)[m]!(path).set(idem());
    if (token !== null) r = r.set(bearer(token));
    return r.send({});
  };
  it("401 without a token", async () => {
    for (const [m, p] of authed) expect((await call(m, p, null)).status, `${m} ${p}`).toBe(401);
  });
  it("seller and admin audiences cannot use buyer routes", async () => {
    for (const [m, p] of authed) {
      expect([401, 403], `${m} ${p} seller`).toContain((await call(m, p, TOKENS.seller)).status);
      expect([401, 403], `${m} ${p} admin`).toContain((await call(m, p, TOKENS.admin)).status);
    }
  });
});
