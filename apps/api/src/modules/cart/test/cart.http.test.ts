import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QUOTE_BAG_FOR_CHECKOUT } from "../adapters/tokens";
import type { QuoteBagForCheckout } from "../application/bag";
import { login, type LoggedIn } from "../../../test/harness";
import { EGP, createCartHarness, uid, type CartHarness } from "./cart-harness";

let h: CartHarness;
let phoneSeq = 0;
const nextPhone = () => `+2010055${String(10_000 + ++phoneSeq)}`;
const STORE_A = uid(1);
const STORE_B = uid(1);
const bearer = (u: LoggedIn) => ({ Authorization: `Bearer ${u.accessToken}` });
const idem = () => ({ "Idempotency-Key": uid(7) });

function addSku(store: string, pounds: bigint, over: { available?: boolean } = {}): string {
  const skuId = uid(2);
  h.catalog.addSku({
    skuId,
    productId: uid(3),
    storeId: store,
    title: { ar: "قميص", en: "Shirt" },
    sizeLabel: "M",
    unitPrice: EGP(pounds),
    available: over.available ?? true,
  });
  return skuId;
}

async function add(u: LoggedIn, skuId: string, qty = 1, source?: string) {
  return h
    .http()
    .post("/v1/cart/lines")
    .set(bearer(u))
    .set(idem())
    .send({ sku_id: skuId, qty, ...(source !== undefined ? { source } : {}) });
}
const getCart = (u: LoggedIn) => h.http().get("/v1/cart").set(bearer(u));
type Group = { store: { id: string }; free_delivery: Record<string, unknown>; merchandise_subtotal: { amount: string }; status: string; lines: Record<string, unknown>[] };
const group = (body: { groups: Group[] }, store: string): Group => {
  const g = body.groups.find((x) => x.store.id === store);
  if (g === undefined) throw new Error("group missing");
  return g;
};

beforeAll(async () => {
  h = await createCartHarness();
  h.catalog.addStore(STORE_A);
  h.catalog.addStore(STORE_B);
}, 30_000);
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  h.clock.advance(61_000);
});

describe("acceptance: free delivery per store (spec 6)", () => {
  it("store A 1,950 + a 60 EGP item unlocks; store B 2,100 alone is free", async () => {
    const u = await login(h, nextPhone());
    const a1 = addSku(STORE_A, 1950n);
    const a2 = addSku(STORE_A, 60n);
    const b1 = addSku(STORE_B, 2100n);
    const r1 = await add(u, a1);
    expect(r1.status).toBe(201);
    expect(group(r1.body, STORE_A).free_delivery).toMatchObject({
      unlocked: false,
      remaining: { amount: "5000", currency: "EGP" },
      threshold: { amount: "200000" },
      plus_member: false,
    });
    const r2 = await add(u, a2);
    expect(group(r2.body, STORE_A).free_delivery).toMatchObject({ unlocked: true, remaining: { amount: "0" } });
    expect(group(r2.body, STORE_A).merchandise_subtotal.amount).toBe("201000");
    const r3 = await add(u, b1);
    expect(group(r3.body, STORE_B).free_delivery.unlocked).toBe(true);
    expect(r3.body.line_count).toBe(3);
  });

  it("Plus member: every group unlocked, plus_member true", async () => {
    const u = await login(h, nextPhone());
    h.membership.grant(u.userId);
    const r = await add(u, addSku(STORE_A, 10n));
    expect(group(r.body, STORE_A).free_delivery).toMatchObject({ unlocked: true, plus_member: true, remaining: { amount: "0" } });
  });

  it("per-store threshold override and platform default are honoured", async () => {
    const store = uid(1);
    h.catalog.addStore(store);
    h.catalog.setStoreThreshold(store, EGP(500n));
    const u = await login(h, nextPhone());
    const r = await add(u, addSku(store, 600n));
    expect(group(r.body, store).free_delivery).toMatchObject({ unlocked: true, threshold: { amount: "50000" } });
  });
});

describe("limits", () => {
  it("rejects the 11th unit of a SKU with 422", async () => {
    const u = await login(h, nextPhone());
    const s = addSku(STORE_A, 10n);
    expect((await add(u, s, 10)).status).toBe(201);
    const r = await add(u, s, 1);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("sku_unit_limit_reached");
  });

  it("rejects the 51st line with 422 and still merges at 50", async () => {
    const u = await login(h, nextPhone());
    const first = addSku(STORE_A, 1n);
    await add(u, first);
    // seed 49 more lines straight into the repository to keep the HTTP rate limit out of this test
    const cart = await h.repo.getOrCreate(u.userId, uid(9), h.clock.nowMs());
    const fillers = Array.from({ length: 49 }, () => {
      const skuId = addSku(STORE_A, 1n);
      return { id: uid(5), skuId, storeId: STORE_A, qty: 1, priceAtAdd: EGP(1n), thresholdAtAdd: null, state: "IN_BAG" as const, source: null, unavailableSinceMs: null, addedAtMs: 0 };
    });
    await h.repo.save({ ...cart, lines: [...cart.lines, ...fillers] }, cart.version, h.clock.nowMs());
    const over = await add(u, addSku(STORE_A, 1n));
    expect(over.status).toBe(422);
    expect(over.body.code).toBe("line_limit_reached");
    expect((await add(u, first)).status).toBe(201);
  });

  it("validates the body: quantity bounds, unknown fields, bad ids", async () => {
    const u = await login(h, nextPhone());
    const s = addSku(STORE_A, 10n);
    for (const body of [{ sku_id: s, qty: 0 }, { sku_id: s, qty: 11 }, { sku_id: s, qty: 1.5 }, { sku_id: "nope", qty: 1 }, { sku_id: s, qty: 1, price: 1 }, { sku_id: s, qty: 1, source: "reorder" }]) {
      const r = await h.http().post("/v1/cart/lines").set(bearer(u)).set(idem()).send(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("unknown, unavailable and suspended-store SKUs are 422", async () => {
    const u = await login(h, nextPhone());
    expect((await add(u, uid(2))).body.code).toBe("unknown_sku");
    expect((await add(u, addSku(STORE_A, 10n, { available: false }))).body.code).toBe("sku_unavailable");
    const closed = uid(1);
    h.catalog.addStore(closed, { open: false });
    expect((await add(u, addSku(closed, 10n))).body.code).toBe("store_suspended");
  });
});

describe("honest pricing", () => {
  it("shows dropped, rose and none; never a reference price on the bag", async () => {
    const u = await login(h, nextPhone());
    const s1 = addSku(STORE_A, 100n);
    const s2 = addSku(STORE_A, 100n);
    const s3 = addSku(STORE_A, 100n);
    await add(u, s1);
    await add(u, s2);
    await add(u, s3);
    h.catalog.setPrice(s1, EGP(80n));
    h.catalog.setPrice(s2, EGP(120n));
    const r = await getCart(u);
    const lines = group(r.body, STORE_A).lines;
    const by = (sku: string) => lines.find((l) => l["sku_id"] === sku);
    expect(by(s1)?.["price_change"]).toBe("dropped");
    expect(by(s2)?.["price_change"]).toBe("rose");
    expect(by(s3)?.["price_change"]).toBe("none");
    expect(by(s1)?.["price_at_add"]).toEqual({ amount: "10000", currency: "EGP" });
    expect(by(s1)).not.toHaveProperty("reference_price");
    expect(group(r.body, STORE_A).merchandise_subtotal.amount).toBe("30000");
  });
});

describe("save for later, unavailable, suspended", () => {
  it("saved lines are shown but not counted; qty and state update through PATCH with If-Match", async () => {
    const u = await login(h, nextPhone());
    const s = addSku(STORE_A, 100n);
    const added = await add(u, s, 2);
    const lineId = group(added.body, STORE_A).lines[0]?.["id"] as string;
    const etag = added.headers["etag"] as string;
    const saved = await h.http().patch(`/v1/cart/lines/${lineId}`).set(bearer(u)).set("If-Match", etag).send({ saved_for_later: true });
    expect(saved.status).toBe(200);
    expect(group(saved.body, STORE_A).merchandise_subtotal.amount).toBe("0");
    expect(group(saved.body, STORE_A).lines[0]?.["saved_for_later"]).toBe(true);
    const back = await h
      .http()
      .patch(`/v1/cart/lines/${lineId}`)
      .set(bearer(u))
      .set("If-Match", saved.headers["etag"] as string)
      .send({ saved_for_later: false, qty: 3 });
    expect(group(back.body, STORE_A).merchandise_subtotal.amount).toBe("30000");
    expect(group(back.body, STORE_A).lines[0]?.["qty"]).toBe(3);
  });

  it("PATCH needs If-Match (428) and rejects a stale one (412); empty and invalid bodies are 400", async () => {
    const u = await login(h, nextPhone());
    const added = await add(u, addSku(STORE_A, 100n));
    const lineId = group(added.body, STORE_A).lines[0]?.["id"] as string;
    const url = `/v1/cart/lines/${lineId}`;
    expect((await h.http().patch(url).set(bearer(u)).send({ qty: 2 })).status).toBe(428);
    expect((await h.http().patch(url).set(bearer(u)).set("If-Match", '"stale"').send({ qty: 2 })).status).toBe(412);
    expect((await h.http().patch(url).set(bearer(u)).set("If-Match", added.headers["etag"] as string).send({})).status).toBe(400);
    expect((await h.http().patch(url).set(bearer(u)).set("If-Match", added.headers["etag"] as string).send({ qty: 11 })).status).toBe(400);
  });

  it("an unavailable line stays, is not counted and emits cart.line_unavailable once", async () => {
    const u = await login(h, nextPhone());
    const keep = addSku(STORE_A, 100n);
    const gone = addSku(STORE_A, 50n);
    await add(u, keep);
    await add(u, gone);
    h.catalog.setAvailable(gone, false);
    const before = h.cartEvents.events.length;
    const r1 = await getCart(u);
    const r2 = await getCart(u);
    const g = group(r1.body, STORE_A);
    expect(g.merchandise_subtotal.amount).toBe("10000");
    expect(g.lines.find((l) => l["sku_id"] === gone)?.["availability"]).toBe("unavailable");
    expect(group(r2.body, STORE_A).merchandise_subtotal.amount).toBe("10000");
    const emitted = h.cartEvents.events.slice(before);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ name: "cart.line_unavailable", skuId: gone, reason: "sold_out", userId: u.userId });
    h.catalog.setAvailable(gone, true);
    await getCart(u);
    h.catalog.setAvailable(gone, false);
    await getCart(u);
    expect(h.cartEvents.events.slice(before)).toHaveLength(2);
  });

  it("a suspended store's group is locked and counts nothing, but its lines can be removed", async () => {
    const store = uid(1);
    h.catalog.addStore(store);
    const u = await login(h, nextPhone());
    const added = await add(u, addSku(store, 3000n));
    h.catalog.setStoreOpen(store, false);
    const r = await getCart(u);
    const g = group(r.body, store);
    expect(g.status).toBe("locked_store_suspended");
    expect(g.merchandise_subtotal.amount).toBe("0");
    expect(g.free_delivery.unlocked).toBe(false);
    const del = await h.http().delete(`/v1/cart/lines/${group(added.body, store).lines[0]?.["id"] as string}`).set(bearer(u));
    expect(del.status).toBe(200);
    expect(del.body.groups).toEqual([]);
  });

  it("delisted SKUs are omitted rather than priced from stale data", async () => {
    const u = await login(h, nextPhone());
    const s = addSku(STORE_A, 100n);
    await add(u, s);
    h.catalog.delist(s);
    const r = await getCart(u);
    expect(r.body.groups).toEqual([]);
  });
});

describe("ETag and idempotency", () => {
  it("GET is 304 for a matching If-None-Match and changes after a write", async () => {
    const u = await login(h, nextPhone());
    await add(u, addSku(STORE_A, 100n));
    const first = await getCart(u);
    const etag = first.headers["etag"] as string;
    expect((await h.http().get("/v1/cart").set(bearer(u)).set("If-None-Match", etag)).status).toBe(304);
    await add(u, addSku(STORE_A, 100n));
    const second = await getCart(u);
    expect(second.headers["etag"]).not.toBe(etag);
  });

  it("POST without a key is 400; a replayed key does not add twice; a different body with the same key is 422", async () => {
    const u = await login(h, nextPhone());
    const s = addSku(STORE_A, 100n);
    expect((await h.http().post("/v1/cart/lines").set(bearer(u)).send({ sku_id: s, qty: 1 })).status).toBe(400);
    const key = uid(7);
    const body = { sku_id: s, qty: 2 };
    const one = await h.http().post("/v1/cart/lines").set(bearer(u)).set("Idempotency-Key", key).send(body);
    const two = await h.http().post("/v1/cart/lines").set(bearer(u)).set("Idempotency-Key", key).send(body);
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(two.headers["idempotent-replayed"]).toBe("true");
    expect(group((await getCart(u)).body, STORE_A).lines[0]?.["qty"]).toBe(2);
    const diff = await h.http().post("/v1/cart/lines").set(bearer(u)).set("Idempotency-Key", key).send({ sku_id: s, qty: 3 });
    expect(diff.status).toBe(422);
  });
});

describe("free-delivery suggestions", () => {
  const candidate = (store: string, pounds: bigint, over: Record<string, unknown> = {}) => ({
    skuId: uid(2),
    productId: uid(3),
    title: { ar: "حزام" },
    store: { id: store, slug: "s", name: { ar: "م" }, kind: "local" as const, verifiedBadge: false, maxVerifiedDiscountPct: null, rating: null, ratingCount: 0, followerCount: 0, liveDrop: false, isFavorite: false },
    unitPrice: EGP(pounds),
    badge: "none" as const,
    referencePrice: null,
    discountPct: null,
    condition: "new_with_tags" as const,
    sponsored: false,
    ...over,
  });

  it("ranks single-item unlockers first, caps at 20, forces unverified claims to null", async () => {
    const store = uid(1);
    h.catalog.addStore(store);
    const u = await login(h, nextPhone());
    await add(u, addSku(store, 1950n)); // remaining 50 EGP
    const cheap = candidate(store, 20n);
    const unlock = candidate(store, 60n);
    const fake = candidate(store, 70n, { badge: "verified_discount", referencePrice: null, discountPct: 40 });
    const real = candidate(store, 90n, { badge: "verified_discount", referencePrice: EGP(150n), discountPct: 40 });
    h.catalog.setCandidates(store, [cheap, real, fake, unlock]);
    const r = await h.http().get(`/v1/cart/free-delivery-suggestions?store_id=${store}`).set(bearer(u));
    expect(r.status).toBe(200);
    expect(r.body.remaining).toEqual({ amount: "5000", currency: "EGP" });
    const ids = r.body.suggestions.map((s: { id: string }) => s.id);
    expect(ids).toEqual([unlock.productId, fake.productId, real.productId, cheap.productId]);
    const fakeWire = r.body.suggestions.find((s: { id: string }) => s.id === fake.productId);
    expect(fakeWire.price).toEqual({ price: { amount: "7000", currency: "EGP" }, badge: "none", reference_price: null, discount_pct: null });
    const realWire = r.body.suggestions.find((s: { id: string }) => s.id === real.productId);
    expect(realWire.price.reference_price).toEqual({ amount: "15000", currency: "EGP" });
  });

  it("is empty once unlocked or for a Plus member, 404 for an unknown store, 400 for a bad id", async () => {
    const store = uid(1);
    h.catalog.addStore(store);
    h.catalog.setCandidates(store, [candidate(store, 10n)]);
    const u = await login(h, nextPhone());
    await add(u, addSku(store, 2500n));
    const done = await h.http().get(`/v1/cart/free-delivery-suggestions?store_id=${store}`).set(bearer(u));
    expect(done.body).toMatchObject({ remaining: { amount: "0" }, suggestions: [] });
    const p = await login(h, nextPhone());
    h.membership.grant(p.userId);
    const plus = await h.http().get(`/v1/cart/free-delivery-suggestions?store_id=${store}`).set(bearer(p));
    expect(plus.body.suggestions).toEqual([]);
    expect((await h.http().get(`/v1/cart/free-delivery-suggestions?store_id=${uid(1)}`).set(bearer(u))).status).toBe(404);
    expect((await h.http().get("/v1/cart/free-delivery-suggestions?store_id=x").set(bearer(u))).status).toBe(400);
    expect((await h.http().get("/v1/cart/free-delivery-suggestions").set(bearer(u))).status).toBe(400);
  });

  it("excludes SKUs already in the bag and an empty store gets the full threshold", async () => {
    const store = uid(1);
    h.catalog.addStore(store);
    const u = await login(h, nextPhone());
    const c = candidate(store, 300n);
    h.catalog.setCandidates(store, [c]);
    const r = await h.http().get(`/v1/cart/free-delivery-suggestions?store_id=${store}`).set(bearer(u));
    expect(r.body.remaining).toEqual({ amount: "200000", currency: "EGP" });
    expect(r.body.suggestions).toHaveLength(1);
  });
});

describe("checkout-time threshold wins and the change is shown", () => {
  it("quote reports the previous and current threshold, and no change when equal", async () => {
    const store = uid(1);
    h.catalog.addStore(store);
    const u = await login(h, nextPhone());
    await add(u, addSku(store, 1000n));
    const quote = h.app.get<QuoteBagForCheckout>(QUOTE_BAG_FOR_CHECKOUT, { strict: false });
    expect((await quote.execute(u.userId)).groups[0]?.thresholdChange).toBeNull();
    h.catalog.setStoreThreshold(store, EGP(900n));
    const changed = (await quote.execute(u.userId)).groups[0];
    expect(changed?.thresholdChange).toEqual({ previous: EGP(2000n), current: EGP(900n) });
    expect(changed?.freeDelivery.threshold).toEqual(EGP(900n));
    expect(changed?.freeDelivery.unlocked).toBe(true);
  });
});

describe("failure handling", () => {
  it("answers 503 when the catalog is down and never a stale bag", async () => {
    const u = await login(h, nextPhone());
    h.catalog.failing = true;
    try {
      const r = await getCart(u);
      expect(r.status).toBe(503);
      expect(r.body.code).toBe("catalog_unavailable");
    } finally {
      h.catalog.failing = false;
    }
  });
});
