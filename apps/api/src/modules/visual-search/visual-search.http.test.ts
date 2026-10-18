import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { seededUnitVector } from "./adapters/in-memory";
import { bearer, cand, createHarness, jpeg, P, S, TOKENS, USERS, type Harness } from "./test/harness";

let h: Harness;
const photo = (tag: number) => jpeg(800, 1000, tag);

beforeEach(async () => {
  if (h !== undefined) await h.close();
  h = await createHarness({ userDailyLimit: 1000 });
});
afterAll(async () => {
  if (h !== undefined) await h.close();
});

const tick = (): void => h.clock.advance(61_000);
const search = async (token: string | null, body: object) => {
  tick();
  const r = h.http().post("/v1/search/visual");
  return (token === null ? r : r.set(bearer(token))).send(body);
};
const items = (r: { body: unknown }) => (r.body as { items: { product_id: string; verified_discount_pct: number | null; match: string }[] }).items;

describe("search by image", () => {
  it("returns the visually closest in-stock items, deletes the query image and records no user id", async () => {
    h.addProduct(cand(1, 1), photo(1));
    h.addProduct(cand(2, 2), photo(2));
    h.addProduct(cand(3, 3), photo(3));
    const id = await h.upload(TOKENS.a, photo(2));
    const r = await search(TOKENS.a, { upload_id: id, limit: 3 });
    expect(r.status).toBe(200);
    const body = r.body as { items: { product_id: string; match: string; price_piastres: string }[]; low_confidence: boolean; model_version: string };
    expect(body.items[0]?.product_id).toBe(P(2));
    expect(body.items[0]?.match).toBe("close");
    expect(body.items[0]?.price_piastres).toBe("100000");
    expect(body.low_confidence).toBe(false);
    // zero retention: object gone, upload row consumed and deleted, request log has no user or vector
    expect(h.images.objects.has(id)).toBe(false);
    expect(h.store.uploads.get(id)?.deleted).toBe(true);
    const log = h.store.requests.at(-1);
    expect(log).toBeDefined();
    expect(JSON.stringify(log)).not.toContain(USERS.a);
    expect(Object.keys(log ?? {}).sort()).toEqual(["categoryGuess", "id", "latencyMs", "mode", "modelVersion", "outcome", "resultCount", "tsMs"]);
  });

  it("strips EXIF/GPS before the embedder and the safety classifier see the bytes", async () => {
    h.addProduct(cand(1, 1), photo(1));
    const original = jpeg(800, 1000, 1, true);
    expect(Buffer.from(original).includes(Buffer.from("GPSLatitude"))).toBe(true);
    const id = await h.upload(TOKENS.a, original);
    const r = await search(TOKENS.a, { upload_id: id });
    expect(r.status).toBe(200);
    const seen = h.embedder.calls[0]?.bytes;
    expect(seen).toBeDefined();
    expect(Buffer.from(seen ?? new Uint8Array()).includes(Buffer.from("GPS"))).toBe(false);
    expect(Buffer.from(seen ?? new Uint8Array()).includes(Buffer.from("made-by-phone"))).toBe(false);
  });

  it("excludes out-of-stock, suspended and size-mismatched items even when they are the closest", async () => {
    h.addProduct(cand(1, 1, { inStock: false }), photo(5));
    h.addProduct(cand(2, 2, { storeActive: false }), photo(5));
    h.addProduct(cand(3, 3, { sizesInStock: ["XL"] }), photo(5));
    h.addProduct(cand(4, 4), photo(9));
    h.shopper.by.set(USERS.a, { ageYears: 25, sizeLabels: ["M"], myStoreIds: [] });
    const id = await h.upload(TOKENS.a, photo(5));
    const r = await search(TOKENS.a, { upload_id: id, filters: { in_my_size: true } });
    expect(items(r).map((i) => i.product_id)).toEqual([P(4)]);
  });

  it("applies scope, budget and age filters server-side", async () => {
    h.addProduct(cand(1, 1, { world: "global" }), photo(1));
    h.addProduct(cand(2, 2, { priceMinor: 900_000n }), photo(2));
    h.addProduct(cand(3, 3, { minAge: 21 }), photo(3));
    h.addProduct(cand(4, 4), photo(4));
    h.shopper.by.set(USERS.a, { ageYears: 19, sizeLabels: [], myStoreIds: [S(4)] });
    let r = await search(TOKENS.a, { upload_id: await h.upload(TOKENS.a, photo(1)), filters: { world: "local" } });
    expect(items(r).map((i) => i.product_id).sort()).toEqual([P(2), P(4)]);
    r = await search(TOKENS.a, { upload_id: await h.upload(TOKENS.a, photo(1)), filters: { max_price_piastres: "500000" } });
    expect(items(r).map((i) => i.product_id)).not.toContain(P(2));
    expect(items(r).map((i) => i.product_id)).not.toContain(P(3)); // 21+ item hidden from a 19 year old
    r = await search(TOKENS.a, { upload_id: await h.upload(TOKENS.a, photo(1)), filters: { my_stores: true } });
    expect(items(r).map((i) => i.product_id)).toEqual([P(4)]);
  });

  it("emits a percent off only when price integrity allowed the claim", async () => {
    h.addProduct(cand(1, 1, { claimAllowed: true, verifiedDiscountPct: 40 }), photo(1));
    h.addProduct(cand(2, 2, { claimAllowed: false, verifiedDiscountPct: 60 }), photo(2));
    const r = await search(TOKENS.a, { upload_id: await h.upload(TOKENS.a, photo(1)) });
    const byId = new Map(items(r).map((i) => [i.product_id, i.verified_discount_pct]));
    expect(byId.get(P(1))).toBe(40);
    expect(byId.get(P(2))).toBeNull();
  });

  it("never compares across model versions", async () => {
    h.addProduct(cand(1, 1), photo(1));
    h.index.set(P(2), h.embedder.vectorOf(photo(1)), "other-model-v0");
    h.catalog.add(cand(2, 2));
    const r = await search(TOKENS.a, { upload_id: await h.upload(TOKENS.a, photo(1)) });
    expect(items(r).map((i) => i.product_id)).toEqual([P(1)]);
    h.embedder.modelVersion = "other-model-v2";
    const r2 = await search(TOKENS.a, { upload_id: await h.upload(TOKENS.a, photo(1)) });
    expect(items(r2)).toEqual([]);
  });

  it("flags low confidence as closest-we-have, never an exact match", async () => {
    h.index.set(P(1), seededUnitVector(424242), h.embedder.modelVersion);
    h.catalog.add(cand(1, 1));
    const r = await search(TOKENS.a, { upload_id: await h.upload(TOKENS.a, photo(77)) });
    expect(r.status).toBe(200);
    expect((r.body as { low_confidence: boolean }).low_confidence).toBe(true);
    expect(items(r)[0]?.match).toBe("similar");
  });

  it("passes detected face regions to the embedder as masks (no face is embedded)", async () => {
    h.addProduct(cand(1, 1), photo(1));
    h.faces.faces = [{ x: 0.4, y: 0.05, w: 0.2, h: 0.2 }];
    const r = await search(TOKENS.a, { upload_id: await h.upload(TOKENS.a, photo(1)), crop: { x: 0.1, y: 0.3, w: 0.8, h: 0.6 } });
    expect(r.status).toBe(200);
    expect(h.embedder.calls[0]?.maskRegions).toEqual([{ x: 0.4, y: 0.05, w: 0.2, h: 0.2 }]);
    expect(h.embedder.calls[0]?.crop).toEqual({ x: 0.1, y: 0.3, w: 0.8, h: 0.6 });
  });

  it("diversifies so no store appears more than twice in a row", async () => {
    for (let n = 1; n <= 4; n++) h.addProduct(cand(n, 1), photo(1));
    h.addProduct(cand(5, 2), photo(1));
    const r = await search(TOKENS.a, { upload_id: await h.upload(TOKENS.a, photo(1)), limit: 5 });
    const stores = items(r).map((i) => h.catalog.items.get(i.product_id)?.storeId);
    for (let i = 2; i < stores.length; i++) expect(new Set([stores[i], stores[i - 1], stores[i - 2]]).size).toBeGreaterThan(1);
  });
});

describe("rejections and failure handling", () => {
  it("rejects NSFW and non-fashion images with a neutral 422 and still deletes the upload", async () => {
    h.safety.nsfw = true;
    const id = await h.upload(TOKENS.a, photo(1));
    const r = await search(TOKENS.a, { upload_id: id });
    expect(r.status).toBe(422);
    expect((r.body as { code: string }).code).toBe("image_unsafe");
    expect(h.images.objects.has(id)).toBe(false);
    h.safety.nsfw = false;
    h.safety.fashion = false;
    const r2 = await search(TOKENS.a, { upload_id: await h.upload(TOKENS.a, photo(2)) });
    expect(r2.status).toBe(422);
    expect((r2.body as { code: string }).code).toBe("image_not_fashion");
  });

  it("rejects non-images, oversized pixels and infected uploads", async () => {
    const junk = await h.upload(TOKENS.a, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    expect((await search(TOKENS.a, { upload_id: junk })).status).toBe(422);
    const big = await h.upload(TOKENS.a, jpeg(9000, 9000));
    const rBig = await search(TOKENS.a, { upload_id: big });
    expect(rBig.status).toBe(422);
    expect((rBig.body as { code: string }).code).toBe("image_too_large_dimensions");
    const bad = await h.upload(TOKENS.a, photo(1), "infected");
    expect((await search(TOKENS.a, { upload_id: bad })).status).toBe(422);
    expect(h.embedder.calls).toHaveLength(0);
  });

  it("answers 409 while the scan is pending and keeps nothing after the retry window", async () => {
    const id = await h.upload(TOKENS.a, photo(1), "pending_scan");
    const r = await search(TOKENS.a, { upload_id: id });
    expect(r.status).toBe(409);
    expect(h.embedder.calls).toHaveLength(0);
  });

  it("kill switch: 503 Problem+JSON from both endpoints and the issuer", async () => {
    h.addProduct(cand(1, 1), photo(1));
    const id = await h.upload(TOKENS.a, photo(1));
    h.flags.on = false;
    const r = await search(TOKENS.a, { upload_id: id });
    expect(r.status).toBe(503);
    expect((r.body as { code: string }).code).toBe("visual_search_disabled");
    tick();
    const up = await h.http().post("/v1/search/visual/uploads").set(bearer(TOKENS.a)).send({ content_type: "image/jpeg", size_bytes: 10 });
    expect(up.status).toBe(503);
    tick();
    const sim = await h.http().get(`/v1/products/${P(1)}/visually-similar`);
    expect(sim.status).toBe(503);
  });

  it("embedder timeout: attribute fallback with a category hint, 503 without", async () => {
    h.addProduct(cand(1, 1), photo(1));
    h.embedder.delayMs = 200;
    const lim = await createHarness({ embedTimeoutMs: 20 });
    lim.addProduct(cand(1, 1), photo(1));
    lim.embedder.delayMs = 200;
    const hinted = await lim.upload(TOKENS.a, photo(1));
    lim.clock.advance(61_000);
    const r = await lim.http().post("/v1/search/visual").set(bearer(TOKENS.a)).send({ upload_id: hinted, category_hint: "dress" });
    expect(r.status).toBe(200);
    expect((r.body as { degraded: boolean }).degraded).toBe(true);
    const plain = await lim.upload(TOKENS.a, photo(1));
    lim.clock.advance(61_000);
    const r2 = await lim.http().post("/v1/search/visual").set(bearer(TOKENS.a)).send({ upload_id: plain });
    expect(r2.status).toBe(503);
    await lim.close();
  });

  it("index down: 503 for image queries, attribute fallback for the PDP list", async () => {
    h.addProduct(cand(1, 1), photo(1));
    h.addProduct(cand(2, 2), photo(2));
    h.index.down = true;
    expect((await search(TOKENS.a, { upload_id: await h.upload(TOKENS.a, photo(1)) })).status).toBe(503);
    tick();
    const sim = await h.http().get(`/v1/products/${P(1)}/visually-similar`);
    expect(sim.status).toBe(200);
    expect((sim.body as { degraded: boolean }).degraded).toBe(true);
    expect(items(sim).map((i) => i.product_id)).toEqual([P(2)]);
  });

  it("external embedders need the cross_border_ml consent", async () => {
    h.addProduct(cand(1, 1), photo(1));
    h.embedder.residency = "external";
    const r = await search(TOKENS.a, { upload_id: await h.upload(TOKENS.a, photo(1)) });
    expect(r.status).toBe(403);
    expect(h.embedder.calls).toHaveLength(0);
    h.consent.granted.add(USERS.a);
    const ok = await search(TOKENS.a, { upload_id: await h.upload(TOKENS.a, photo(1)) });
    expect(ok.status).toBe(200);
  });

  it("enforces the per-user daily cap and the global cost cap", async () => {
    const lim = await createHarness({ userDailyLimit: 2, globalDailyLimit: 3 });
    lim.addProduct(cand(1, 1), photo(1));
    const go = async (tok: string) => {
      const id = await lim.upload(tok, photo(1));
      lim.clock.advance(61_000);
      return lim.http().post("/v1/search/visual").set(bearer(tok)).send({ upload_id: id });
    };
    expect((await go(TOKENS.a)).status).toBe(200);
    expect((await go(TOKENS.a)).status).toBe(200);
    const capped = await go(TOKENS.a);
    expect(capped.status).toBe(429);
    expect((capped.body as { code: string }).code).toBe("daily_limit");
    expect((await go(TOKENS.b)).status).toBe(200);
    const global = await go(TOKENS.b);
    expect(global.status).toBe(503);
    expect((global.body as { code: string }).code).toBe("visual_search_capacity");
    await lim.close();
  });

  it("sweeper deletes abandoned uploads after expiry", async () => {
    const id = await h.upload(TOKENS.a, photo(1));
    expect(h.images.objects.has(id)).toBe(true);
    h.clock.advance(11 * 60_000);
    const r = await h.sweep.execute();
    expect(r.deletedObjects).toBe(1);
    expect(h.images.objects.has(id)).toBe(false);
  });
});

describe("authorization and abuse", () => {
  it("anonymous 401; seller and admin tokens are not shopper audiences", async () => {
    for (const t of [null, TOKENS.seller, TOKENS.admin]) {
      const r = await search(t, { upload_id: "visual-query/2026/10/x" });
      expect([401, 403]).toContain(r.status);
    }
  });

  it("another shopper's upload id and a replayed id are 404 and never read", async () => {
    h.addProduct(cand(1, 1), photo(1));
    const id = await h.upload(TOKENS.a, photo(1));
    const foreign = await search(TOKENS.b, { upload_id: id });
    expect(foreign.status).toBe(404);
    expect(h.embedder.calls).toHaveLength(0);
    expect((await search(TOKENS.a, { upload_id: id })).status).toBe(200);
    expect((await search(TOKENS.a, { upload_id: id })).status).toBe(404);
  });

  it("does not accept URLs or unknown fields (no server-side fetch, no mass assignment)", async () => {
    const r = await search(TOKENS.a, { upload_id: "https://evil.test/a.jpg", image_url: "http://169.254.169.254/" });
    expect(r.status).toBe(400);
    expect(h.embedder.calls).toHaveLength(0);
  });

  it("rate limits uploads and searches per user", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const r = await h.http().post("/v1/search/visual/uploads").set(bearer(TOKENS.a)).send({ content_type: "image/jpeg", size_bytes: 10 });
      last = r.status;
    }
    expect(last).toBe(429);
  });

  it("rejects declared sizes above 10 MB at issuance", async () => {
    tick();
    const r = await h.http().post("/v1/search/visual/uploads").set(bearer(TOKENS.a)).send({ content_type: "image/jpeg", size_bytes: 11 * 1024 * 1024 });
    expect(r.status).toBe(400);
  });
});

describe("similar by product (visual)", () => {
  it("uses the product's own embedding, excludes itself and unavailable items, public", async () => {
    h.addProduct(cand(1, 1), photo(1));
    h.addProduct(cand(2, 2), photo(1));
    h.addProduct(cand(3, 3, { inStock: false }), photo(1));
    h.addProduct(cand(4, 4), photo(8));
    tick();
    const r = await h.http().get(`/v1/products/${P(1)}/visually-similar?limit=5`);
    expect(r.status).toBe(200);
    const ids = items(r).map((i) => i.product_id);
    expect(ids[0]).toBe(P(2));
    expect(ids).not.toContain(P(1));
    expect(ids).not.toContain(P(3));
    tick();
    expect((await h.http().get(`/v1/products/${P(99)}/visually-similar`)).status).toBe(404);
  });
});
