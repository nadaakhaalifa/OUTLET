import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDEM, TOKENS, USERS, bearer, createStylistHarness, type StylistHarness } from "./test/harness";
import { item, sku, U } from "./test/fixtures";

let h: StylistHarness;
let seq = 0;
beforeAll(async () => {
  h = await createStylistHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
});

const tick = (): void => h.clock.advance(61_000);
const post = (path: string, token: string | null, body: unknown, idem = false) => {
  tick();
  let r = h.http().post(path);
  if (idem) r = r.set({ "Idempotency-Key": IDEM(++seq) });
  if (token !== null) r = r.set(bearer(token));
  return r.send(body as object);
};

interface WireOutfit {
  id: string;
  total_piastres: string;
  source: string;
  items: { item_id: string; slot: string; price_piastres: string }[];
  ai_suggestion: boolean;
}

describe("POST /v1/stylist/outfits", () => {
  it("returns 3-5 outfits within budget, labelled as AI suggestions, money as piastre strings", async () => {
    const r = await post("/v1/stylist/outfits", TOKENS.a, { budget_piastres: "300000", occasion: "wedding_guest", modest: true, season: "summer" });
    expect(r.status).toBe(200);
    expect(r.body.ai_notice).toBe("AI suggestions");
    const outfits = r.body.outfits as WireOutfit[];
    expect(outfits.length).toBeGreaterThanOrEqual(3);
    expect(outfits.length).toBeLessThanOrEqual(5);
    for (const o of outfits) {
      expect(BigInt(o.total_piastres) <= 300_000n).toBe(true);
      expect(o.ai_suggestion).toBe(true);
      expect(typeof o.total_piastres).toBe("string");
    }
  });

  it("401 without a token or on the wrong audience; strict body rejects extra fields", async () => {
    expect((await post("/v1/stylist/outfits", null, {})).status).toBe(401);
    expect((await post("/v1/stylist/outfits", TOKENS.shopperOnSellerAud, {})).status).toBe(401);
    const bad = await post("/v1/stylist/outfits", TOKENS.a, { price: "1" });
    expect(bad.status).toBe(400);
  });

  it("returns rules output (never an error) when ML is down", async () => {
    h.embeddings.down = true;
    const r = await post("/v1/stylist/outfits", TOKENS.a, {});
    h.embeddings.down = false;
    expect(r.status).toBe(200);
    expect(r.body.source).toBe("rules");
    expect(r.body.fallback_reason).toBe("ml_down");
    expect(r.body.outfits.length).toBeGreaterThan(0);
  });

  it("503 when the catalog source is down", async () => {
    h.candidates.down = true;
    const r = await post("/v1/stylist/outfits", TOKENS.a, {});
    h.candidates.down = false;
    expect(r.status).toBe(503);
  });
});

describe("POST /v1/stylist/complete-look and /capsule", () => {
  it("keeps the anchor in every outfit, and 422 when the anchor is not in the shopper's size", async () => {
    const anchor = sku(9);
    const r = await post("/v1/stylist/complete-look", TOKENS.a, { anchor_item_id: anchor });
    expect(r.status).toBe(200);
    for (const o of r.body.outfits as WireOutfit[]) expect(o.items.some((i) => i.item_id === anchor)).toBe(true);
    const idx = h.candidates.items.findIndex((c) => c.itemId === anchor);
    const keep = h.candidates.items[idx];
    h.candidates.items[idx] = { ...item("dress", 9, 100), itemId: anchor, inSize: false };
    const bad = await post("/v1/stylist/complete-look", TOKENS.a, { anchor_item_id: anchor });
    if (keep !== undefined) h.candidates.items[idx] = keep;
    expect(bad.status).toBe(422);
    expect((await post("/v1/stylist/complete-look", null, { anchor_item_id: anchor })).status).toBe(401);
  });

  it("capsule respects budget and piece count", async () => {
    const r = await post("/v1/stylist/capsule", TOKENS.a, { budget_piastres: "500000", pieces: 8, outfits: 10 });
    expect(r.status).toBe(200);
    const o = (r.body.outfits as WireOutfit[])[0];
    expect(o).toBeDefined();
    expect(BigInt(o?.total_piastres ?? "0") <= 500_000n).toBe(true);
    expect((o?.items.length ?? 0) <= 8).toBe(true);
    expect((await post("/v1/stylist/capsule", null, {})).status).toBe(401);
  });
});

describe("POST /v1/stylist/outfits/:id/add-to-bag", () => {
  const generate = async (token: string): Promise<WireOutfit> => {
    const r = await post("/v1/stylist/outfits", token, { budget_piastres: "400000" });
    return (r.body.outfits as WireOutfit[])[0] as WireOutfit;
  };

  it("adds once (idempotent), and reports sold-out items instead of dropping them silently", async () => {
    const o = await generate(TOKENS.a);
    const sold = o.items[0];
    const live = h.live.prices.get(sold?.item_id ?? "");
    if (sold === undefined || live === undefined) throw new Error("fixture");
    h.live.prices.set(sold.item_id, { ...live, inStockInSize: false });
    const r = await post(`/v1/stylist/outfits/${o.id}/add-to-bag`, TOKENS.a, {}, true);
    h.live.prices.set(sold.item_id, live);
    expect(r.status).toBe(200);
    expect(r.body.added).toBe(true);
    expect(r.body.unavailable).toEqual([{ item_id: sold.item_id, slot: sold.slot, reason: "sold_out" }]);
    expect(r.body.item_ids).not.toContain(sold.item_id);
    expect(h.bag.adds).toHaveLength(1);
    const again = await post(`/v1/stylist/outfits/${o.id}/add-to-bag`, TOKENS.a, {}, true);
    expect(again.status).toBe(200);
    expect(again.body.already_added).toBe(true);
    expect(h.bag.adds).toHaveLength(1);
  });

  it("409 when live prices push an outfit over the typed budget", async () => {
    const o = await generate(TOKENS.a);
    for (const i of o.items) {
      const l = h.live.prices.get(i.item_id);
      if (l !== undefined) h.live.prices.set(i.item_id, { ...l, pricePiastres: l.pricePiastres * 3n });
    }
    const r = await post(`/v1/stylist/outfits/${o.id}/add-to-bag`, TOKENS.a, {}, true);
    for (const c of h.candidates.items) h.live.prices.set(c.itemId, { pricePiastres: c.pricePiastres, storeId: c.storeId, inStockInSize: true });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("budget_exceeded");
  });

  it("another shopper's outfit is 404, identical to a missing one; wrong role 403; no token 401", async () => {
    const o = await generate(TOKENS.a);
    const foreign = await post(`/v1/stylist/outfits/${o.id}/add-to-bag`, TOKENS.b, {}, true);
    const missing = await post(`/v1/stylist/outfits/${U(999_999)}/add-to-bag`, TOKENS.b, {}, true);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body.code).toBe(missing.body.code);
    expect((await post(`/v1/stylist/outfits/${o.id}/add-to-bag`, TOKENS.sellerOnBuyerAud, {}, true)).status).toBe(403);
    expect((await post(`/v1/stylist/outfits/${o.id}/add-to-bag`, null, {}, true)).status).toBe(401);
    expect((await post(`/v1/stylist/outfits/${o.id}/add-to-bag`, TOKENS.a, {}, false)).status).toBe(400);
    expect(h.bag.adds.some((a) => a.userId === USERS.b)).toBe(false);
  });
});

describe("POST /v1/stylist/feedback", () => {
  it("records feedback and updates the style vector; foreign outfit is 404", async () => {
    const g = await post("/v1/stylist/outfits", TOKENS.a, {});
    const o = (g.body.outfits as WireOutfit[])[0] as WireOutfit;
    const it0 = o.items[0];
    if (it0 === undefined) throw new Error("fixture");
    h.embeddings.vectors.set(it0.item_id, [1, 0, 0]);
    const ok = await post("/v1/stylist/feedback", TOKENS.a, { outfit_id: o.id, item_id: it0.item_id, signal: "like" });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ recorded: true, style_updated: true });
    expect(await h.store.getStyleVector(USERS.a)).toEqual([1, 0, 0]);
    const foreign = await post("/v1/stylist/feedback", TOKENS.b, { outfit_id: o.id, item_id: it0.item_id, signal: "like" });
    expect(foreign.status).toBe(404);
    expect((await post("/v1/stylist/feedback", null, { outfit_id: o.id, item_id: it0.item_id, signal: "like" })).status).toBe(401);
    expect((await post("/v1/stylist/feedback", TOKENS.a, { outfit_id: o.id, item_id: it0.item_id, signal: "love" })).status).toBe(400);
  });

  it("with personalization off nothing is stored and the vector is not touched", async () => {
    const g = await post("/v1/stylist/outfits", TOKENS.b, {});
    const o = (g.body.outfits as WireOutfit[])[0] as WireOutfit;
    const it0 = o.items[0];
    if (it0 === undefined) throw new Error("fixture");
    h.personalization.off.add(USERS.b);
    const r = await post("/v1/stylist/feedback", TOKENS.b, { outfit_id: o.id, item_id: it0.item_id, signal: "dislike" });
    h.personalization.off.delete(USERS.b);
    expect(r.body).toEqual({ recorded: false, reason: "personalization_off" });
    expect(await h.store.getStyleVector(USERS.b)).toBeNull();
  });
});

describe("fair use", () => {
  it("429 after 30 generations in a UTC day, reset the next day", async () => {
    const q = await createStylistHarness({ config: { dailyGenerations: 2, mlTimeoutMs: 800, freeDeliveryThresholdPiastres: 200_000n } });
    try {
      const go = () => {
        q.clock.advance(61_000);
        return q.http().post("/v1/stylist/outfits").set(bearer(TOKENS.a)).send({});
      };
      expect((await go()).status).toBe(200);
      expect((await go()).status).toBe(200);
      const third = await go();
      expect(third.status).toBe(429);
      expect(third.headers["retry-after"]).toBeDefined();
      q.clock.advance(24 * 3_600_000);
      expect((await go()).status).toBe(200);
    } finally {
      await q.close();
    }
  });
});
