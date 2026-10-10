import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SEED } from "../adapters/in-memory";
import { PRINCIPALS, STORE_A, STORE_B, bearer, createCatalogHarness, idemKey, type CatalogHarness, type TestPrincipal } from "./harness";

const UP_IMG = "0192f3a4-5b6c-7d8e-9f01-0000000a0001";
const UP_IMG2 = "0192f3a4-5b6c-7d8e-9f01-0000000a0002";
const UP_DEFECT = "0192f3a4-5b6c-7d8e-9f01-0000000a0003";
const UP_B_IMG = "0192f3a4-5b6c-7d8e-9f01-0000000b0001";
const UP_CSV = "0192f3a4-5b6c-7d8e-9f01-0000000c0001";

let h: CatalogHarness;

beforeAll(async () => {
  h = await createCatalogHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  h.fixtures.uploads.add(STORE_A, UP_IMG);
  h.fixtures.uploads.add(STORE_A, UP_IMG2);
  h.fixtures.uploads.add(STORE_A, UP_DEFECT);
  h.fixtures.uploads.add(STORE_B, UP_B_IMG);
});

const body = (over: Record<string, unknown> = {}) => ({
  title: { ar: "فستان كتان أبيض", en: "White linen dress" },
  description: { ar: "فستان صيفي خفيف" },
  category_id: SEED.categoryDresses,
  brand_id: SEED.brandAcme,
  condition: "new_with_tags",
  image_upload_ids: [UP_IMG],
  skus: [
    { size_label: "M", color: "White", price: { amount: "129900", currency: "EGP" }, initial_stock: 4, seller_sku: "LD-M" },
    { size_label: "L", color: "White", price: { amount: "129900", currency: "EGP" }, initial_stock: 40, seller_sku: "LD-L" },
  ],
  ...over,
});

async function create(p: TestPrincipal = PRINCIPALS.ownerA, over: Record<string, unknown> = {}) {
  return h.http().post("/v1/seller/products").set(bearer(p)).set("Idempotency-Key", idemKey()).send(body(over));
}

async function createOk(over: Record<string, unknown> = {}) {
  const r = await create(PRINCIPALS.ownerA, over);
  expect(r.status).toBe(201);
  return r.body as { id: string; skus: { id: string }[]; status: string };
}

describe("POST /v1/seller/products", () => {
  it("creates a draft with server-controlled fields and seeds stock through the port", async () => {
    const before = h.fixtures.events.events.length;
    const r = await create();
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("draft");
    expect(r.body.title).toEqual({ ar: "فستان كتان أبيض", en: "White linen dress" });
    expect(r.body.price_claim_state).toBe("none");
    expect(r.body.skus).toHaveLength(2);
    expect(r.body.skus[0].price).toEqual({ amount: "129900", currency: "EGP" });
    expect(r.body.skus[0]).toMatchObject({ on_hand: 4, available: 4 });
    expect(h.fixtures.events.events.length).toBe(before + 1);
    const ev = h.fixtures.events.events.at(-1);
    expect(ev).toMatchObject({ name: "product.created", storeId: STORE_A, actorId: PRINCIPALS.ownerA.actor.id });
  });

  it("rejects missing, Latin-only and blank Arabic titles with 422 and creates nothing", async () => {
    const count = h.fixtures.products.countForTest();
    for (const ar of ["Linen dress", "12345", "   "]) {
      const r = await create(PRINCIPALS.ownerA, { title: { ar, en: "x" } });
      expect(r.status).toBe(422);
      expect(r.body.errors).toEqual([{ pointer: "/title/ar", code: "arabic_text_required" }]);
    }
    const noTitle = await h
      .http()
      .post("/v1/seller/products")
      .set(bearer(PRINCIPALS.ownerA))
      .set("Idempotency-Key", idemKey())
      .send({ ...body(), title: undefined });
    expect(noTitle.status).toBe(400);
    expect(h.fixtures.products.countForTest()).toBe(count);
  });

  it("requires defect photos for minor_defect", async () => {
    const bad = await create(PRINCIPALS.ownerA, { condition: "minor_defect" });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toContainEqual({ pointer: "/defect_photo_upload_ids", code: "defect_photo_required" });
    const ok = await create(PRINCIPALS.ownerA, { condition: "minor_defect", defect_photo_upload_ids: [UP_DEFECT] });
    expect(ok.status).toBe(201);
    expect(ok.body.defect_photo_upload_ids).toEqual([UP_DEFECT]);
  });

  it("refuses mass assignment of server-controlled, reference-price and discount fields", async () => {
    for (const extra of [
      { status: "active" },
      { store_id: STORE_B },
      { version: 99 },
      { was_price: { amount: "500000", currency: "EGP" } },
      { reference_price: { amount: "500000", currency: "EGP" } },
      { discount_pct: 50 },
      { badge: "verified_discount" },
      { offer_group_id: SEED.brandAcme },
    ]) {
      const r = await create(PRINCIPALS.ownerA, extra);
      expect(r.status).toBe(400);
    }
    const nested = await create(PRINCIPALS.ownerA, {
      skus: [{ size_label: "M", price: { amount: "100", currency: "EGP" }, was_price: { amount: "900", currency: "EGP" } }],
    });
    expect(nested.status).toBe(400);
  });

  it("validates price range, duplicate variants and gtin", async () => {
    const r = await create(PRINCIPALS.ownerA, {
      skus: [
        { size_label: "M", color: "Red", price: { amount: "0", currency: "EGP" }, barcode_gtin: "123" },
        { size_label: "m", color: "red", price: { amount: "100", currency: "EGP" } },
      ],
    });
    expect(r.status).toBe(422);
    const codes = (r.body.errors as { code: string }[]).map((e) => e.code);
    expect(codes).toEqual(expect.arrayContaining(["price_out_of_range", "gtin_invalid", "duplicate_variant"]));
  });

  it("refuses a foreign upload id, an unknown category and an inactive category", async () => {
    const foreign = await create(PRINCIPALS.ownerA, { image_upload_ids: [UP_B_IMG] });
    expect(foreign.status).toBe(422);
    expect(foreign.body.errors).toEqual([{ pointer: "/image_upload_ids/0", code: "upload_not_found" }]);
    const unknown = await create(PRINCIPALS.ownerA, { category_id: "0192f3a4-5b6c-7d8e-9f01-ffffffffffff" });
    expect(unknown.body.errors).toEqual([{ pointer: "/category_id", code: "category_not_found" }]);
    const inactive = await create(PRINCIPALS.ownerA, { category_id: SEED.categoryInactive });
    expect(inactive.body.errors).toEqual([{ pointer: "/category_id", code: "category_inactive" }]);
  });

  it("replays an idempotent create and rejects a missing key and a reused key with another body", async () => {
    const key = idemKey();
    const first = await h.http().post("/v1/seller/products").set(bearer(PRINCIPALS.ownerA)).set("Idempotency-Key", key).send(body());
    const again = await h.http().post("/v1/seller/products").set(bearer(PRINCIPALS.ownerA)).set("Idempotency-Key", key).send(body());
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.body.id).toBe(first.body.id);
    const other = await h
      .http()
      .post("/v1/seller/products")
      .set(bearer(PRINCIPALS.ownerA))
      .set("Idempotency-Key", key)
      .send(body({ material: "other" }));
    expect(other.status).toBe(422);
    const none = await h.http().post("/v1/seller/products").set(bearer(PRINCIPALS.ownerA)).send(body());
    expect(none.status).toBe(400);
  });

  it("conflicts on a GTIN already used by the same variant in the store", async () => {
    const gtin = "4006381333931";
    const sku = (size: string) => [{ size_label: size, color: "Blue", price: { amount: "5000", currency: "EGP" }, barcode_gtin: gtin }];
    expect((await create(PRINCIPALS.ownerA, { skus: sku("S") })).status).toBe(201);
    const dup = await create(PRINCIPALS.ownerA, { skus: sku("S") });
    expect(dup.status).toBe(409);
    expect(JSON.stringify(dup.body)).not.toContain(gtin);
  });

  it("requires X-Store-Id for multi-store staff and honours it", async () => {
    const none = await create(PRINCIPALS.multi);
    expect(none.status).toBe(422);
    expect(none.body.code).toBe("store_selection_required");
    h.fixtures.uploads.add(STORE_B, UP_IMG);
    const withHeader = await h
      .http()
      .post("/v1/seller/products")
      .set(bearer(PRINCIPALS.multi))
      .set("X-Store-Id", STORE_B)
      .set("Idempotency-Key", idemKey())
      .send(body({ image_upload_ids: [UP_B_IMG] }));
    expect(withHeader.status).toBe(201);
    const stored = await h.fixtures.products.findById(withHeader.body.id as string);
    expect(stored?.storeId).toBe(STORE_B);
    h.fixtures.uploads.add(STORE_A, UP_IMG);
  });
});

describe("PATCH /v1/seller/products/{id} and the listing lifecycle", () => {
  async function etagOf(id: string, p: TestPrincipal = PRINCIPALS.ownerA): Promise<string> {
    const r = await h.http().get(`/v1/seller/products/${id}`).set(bearer(p));
    expect(r.status).toBe(200);
    return r.headers.etag as string;
  }
  const patch = (id: string, etag: string | null, data: Record<string, unknown>, p: TestPrincipal = PRINCIPALS.ownerA) => {
    let r = h.http().patch(`/v1/seller/products/${id}`).set(bearer(p));
    if (etag !== null) r = r.set("If-Match", etag);
    return r.send(data);
  };

  it("requires If-Match (428) and checks it (412)", async () => {
    const p = await createOk();
    expect((await patch(p.id, null, { material: "كتان" })).status).toBe(428);
    expect((await patch(p.id, '"nope"', { material: "كتان" })).status).toBe(412);
    const etag = await etagOf(p.id);
    const ok = await patch(p.id, etag, { material: "كتان" });
    expect(ok.status).toBe(200);
    expect(ok.body.material).toBe("كتان");
    // The old validator is now stale.
    expect((await patch(p.id, etag, { material: "قطن" })).status).toBe(412);
  });

  it("publishes only when the gate holds and reports every unmet requirement", async () => {
    const p = await createOk({ image_upload_ids: [], description: undefined });
    const etag = await etagOf(p.id);
    const r = await patch(p.id, etag, { status: "active" });
    expect(r.status).toBe(422);
    expect((r.body.errors as { pointer: string }[]).map((e) => e.pointer).sort()).toEqual(["/description/ar", "/image_upload_ids"]);
    const fixed = await patch(p.id, etag, { status: "active", description: { ar: "وصف المنتج" }, image_upload_ids: [UP_IMG] });
    expect(fixed.status).toBe(200);
    expect(fixed.body.status).toBe("active");
  });

  it("walks active, paused, active and emits status events", async () => {
    const p = await createOk();
    let etag = await etagOf(p.id);
    expect((await patch(p.id, etag, { status: "active" })).body.status).toBe("active");
    etag = await etagOf(p.id);
    expect((await patch(p.id, etag, { status: "paused" })).body.status).toBe("paused");
    etag = await etagOf(p.id);
    expect((await patch(p.id, etag, { status: "active" })).body.status).toBe("active");
    const names = h.fixtures.events.events.filter((e) => e.productId === p.id).map((e) => e.name);
    expect(names.filter((n) => n === "product.status_changed")).toHaveLength(3);
  });

  it("refuses a seller trying to clear a system pause and any change to a delisted product", async () => {
    const p = await createOk();
    const stored = await h.fixtures.products.findById(p.id);
    if (stored === null) throw new Error("fixture");
    await h.fixtures.products.replace({ ...stored, status: "auto_paused_price_parity", version: stored.version + 1 }, stored.version);
    const etag = await etagOf(p.id);
    const r = await patch(p.id, etag, { status: "active" });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("invalid_transition");

    const q = await createOk();
    const s2 = await h.fixtures.products.findById(q.id);
    if (s2 === null) throw new Error("fixture");
    await h.fixtures.products.replace({ ...s2, status: "delisted", version: s2.version + 1 }, s2.version);
    const e2 = await etagOf(q.id);
    expect((await patch(q.id, e2, { material: "x" })).status).toBe(422);
  });

  it("rejects mass assignment and an empty body on update", async () => {
    const p = await createOk();
    const etag = await etagOf(p.id);
    for (const data of [{ store_id: STORE_B }, { skus: [] }, { price: { amount: "1", currency: "EGP" } }, {}, { status: "delisted" }]) {
      expect((await patch(p.id, etag, data)).status).toBe(400);
    }
  });

  it("requires a minor_defect product to keep its defect photos when condition changes", async () => {
    const p = await createOk();
    const etag = await etagOf(p.id);
    const r = await patch(p.id, etag, { condition: "minor_defect" });
    expect(r.status).toBe(422);
    expect(r.body.errors).toContainEqual({ pointer: "/defect_photo_upload_ids", code: "defect_photo_required" });
  });
});

describe("GET /v1/seller/products", () => {
  it("lists only the caller's store, newest first, with cursor paging", async () => {
    for (let i = 0; i < 3; i += 1) {
      h.clock.advance(1000);
      await createOk({ title: { ar: `منتج ${i}` } });
    }
    const first = await h.http().get("/v1/seller/products?limit=2").set(bearer(PRINCIPALS.ownerA));
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.page.has_more).toBe(true);
    const second = await h.http().get(`/v1/seller/products?limit=50&cursor=${first.body.page.next_cursor}`).set(bearer(PRINCIPALS.ownerA));
    expect(second.status).toBe(200);
    const ids = new Set([...first.body.items, ...second.body.items].map((x: { id: string }) => x.id));
    expect(ids.size).toBe(first.body.items.length + second.body.items.length);
    const b = await h.http().get("/v1/seller/products?limit=50").set(bearer(PRINCIPALS.ownerB));
    for (const it of b.body.items as { id: string }[]) expect(ids.has(it.id)).toBe(false);
    const bad = await h.http().get("/v1/seller/products?cursor=!!!").set(bearer(PRINCIPALS.ownerA));
    expect(bad.status).toBe(400);
    const forged = await h
      .http()
      .get(`/v1/seller/products?cursor=${Buffer.from("1:not-a-uuid").toString("base64url")}`)
      .set(bearer(PRINCIPALS.ownerA));
    expect(forged.status).toBe(400);
  });
});

describe("GET /v1/products/{id} public read model", () => {
  async function activeProduct(over: Record<string, unknown> = {}) {
    const p = await createOk(over);
    const etag = (await h.http().get(`/v1/seller/products/${p.id}`).set(bearer(PRINCIPALS.ownerA))).headers.etag as string;
    const r = await h
      .http()
      .patch(`/v1/seller/products/${p.id}`)
      .set(bearer(PRINCIPALS.ownerA))
      .set("If-Match", etag)
      .send({ status: "active" });
    expect(r.status).toBe(200);
    return p;
  }

  it("hides draft products from shoppers exactly like missing ones", async () => {
    const p = await createOk();
    const hidden = await h.http().get(`/v1/products/${p.id}`).set(bearer(PRINCIPALS.buyer));
    const missing = await h.http().get("/v1/products/0192f3a4-5b6c-7d8e-9f01-aaaaaaaaaaaa").set(bearer(PRINCIPALS.buyer));
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect({ ...hidden.body, request_id: undefined }).toEqual({ ...missing.body, request_id: undefined });
    expect((await h.http().get("/v1/products/not-a-uuid").set(bearer(PRINCIPALS.buyer))).status).toBe(400);
  });

  it("shows no reference price, percent or badge without pricing evidence, and live stock rules", async () => {
    const p = await activeProduct();
    h.fixtures.stock.set(p.skus[0]?.id ?? "", { onHand: 3, available: 3 });
    h.fixtures.stock.set(p.skus[1]?.id ?? "", { onHand: 40, available: 40 });
    const r = await h.http().get(`/v1/products/${p.id}`).set(bearer(PRINCIPALS.buyer));
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("private, no-cache");
    expect(r.body.price).toMatchObject({ badge: "none", reference_price: null, discount_pct: null, claim_id: null });
    expect(r.body.sponsored).toBe(false);
    const [m, l] = r.body.skus as { units_left: number | null; available: boolean; price: { badge: string; reference_price: unknown } }[];
    expect(m).toMatchObject({ available: true, units_left: 3 });
    expect(l).toMatchObject({ available: true, units_left: null });
    expect(m?.price).toMatchObject({ badge: "none", reference_price: null });
    expect(r.body.seller_legal_identity_visible).toBe(true);
    expect(r.body.images).toHaveLength(1);
    expect(r.body).not.toHaveProperty("defect_photos");
    expect(JSON.stringify(r.body)).not.toMatch(/Legal store-a|CR-1|TC-1|iban/i);
  });

  it("passes through a complete verified claim only", async () => {
    const p = await activeProduct();
    const skuId = p.skus[0]?.id ?? "";
    h.fixtures.stock.set(skuId, { onHand: 9, available: 9 });
    h.fixtures.prices.set(skuId, { badge: "verified_discount", referencePrice: { amount: 200_000n, currency: "EGP" }, discountPct: 35, claimId: "0192f3a4-5b6c-7d8e-9f01-0000000d0001" });
    const r = await h.http().get(`/v1/products/${p.id}`).set(bearer(PRINCIPALS.buyer));
    const m = (r.body.skus as { id: string; price: Record<string, unknown> }[]).find((s) => s.id === skuId);
    expect(m?.price).toMatchObject({ badge: "verified_discount", reference_price: { amount: "200000", currency: "EGP" }, discount_pct: 35 });
    h.fixtures.prices.set(skuId, { badge: "verified_discount", referencePrice: { amount: 200_000n, currency: "EGP" }, discountPct: 2, claimId: "c" });
    const bad = await h.http().get(`/v1/products/${p.id}`).set(bearer(PRINCIPALS.buyer));
    expect((bad.body.skus as { id: string; price: Record<string, unknown> }[]).find((s) => s.id === skuId)?.price).toMatchObject({
      badge: "none",
      reference_price: null,
      discount_pct: null,
    });
  });

  it("degrades safely when inventory is unavailable and never caches stock", async () => {
    const p = await activeProduct();
    const skuId = p.skus[0]?.id ?? "";
    h.fixtures.stock.set(skuId, { onHand: 2, available: 2 });
    const live = await h.http().get(`/v1/products/${p.id}`).set(bearer(PRINCIPALS.buyer));
    expect((live.body.skus as { id: string; units_left: number | null }[]).find((s) => s.id === skuId)?.units_left).toBe(2);
    h.fixtures.stock.set(skuId, { onHand: 1, available: 1 });
    const changed = await h.http().get(`/v1/products/${p.id}`).set(bearer(PRINCIPALS.buyer));
    expect((changed.body.skus as { id: string; units_left: number | null }[]).find((s) => s.id === skuId)?.units_left).toBe(1);
    expect(changed.headers.etag).not.toBe(live.headers.etag);
    h.fixtures.stock.failReads = true;
    const down = await h.http().get(`/v1/products/${p.id}`).set(bearer(PRINCIPALS.buyer));
    h.fixtures.stock.failReads = false;
    expect(down.status).toBe(200);
    for (const s of down.body.skus as { available: boolean; units_left: number | null }[]) {
      expect(s).toMatchObject({ available: false, units_left: null });
    }
  });

  it("serves 304 for a matching If-None-Match and a new validator after a price change", async () => {
    const p = await activeProduct();
    const first = await h.http().get(`/v1/products/${p.id}`).set(bearer(PRINCIPALS.buyer));
    const etag = first.headers.etag as string;
    const same = await h.http().get(`/v1/products/${p.id}`).set(bearer(PRINCIPALS.buyer)).set("If-None-Match", etag);
    expect(same.status).toBe(304);
    const stored = await h.fixtures.products.findById(p.id);
    if (stored === null) throw new Error("fixture");
    const [s0, ...rest] = stored.skus;
    if (s0 === undefined) throw new Error("fixture");
    await h.fixtures.products.replace({ ...stored, version: stored.version + 1, skus: [{ ...s0, price: { amount: 99_900n, currency: "EGP" } }, ...rest] }, stored.version);
    const after = await h.http().get(`/v1/products/${p.id}`).set(bearer(PRINCIPALS.buyer)).set("If-None-Match", etag);
    expect(after.status).toBe(200);
    expect(after.headers.etag).not.toBe(etag);
  });

  it("exposes defect photos only for minor_defect and hygiene categories as not returnable", async () => {
    const d = await activeProduct({ condition: "minor_defect", defect_photo_upload_ids: [UP_DEFECT] });
    const r = await h.http().get(`/v1/products/${d.id}`).set(bearer(PRINCIPALS.buyer));
    expect(r.body.defect_photos).toHaveLength(1);
    const u = await activeProduct({ category_id: SEED.categoryUnderwear });
    const ru = await h.http().get(`/v1/products/${u.id}`).set(bearer(PRINCIPALS.buyer));
    expect(ru.body.return_eligibility).toEqual({ returnable: false, reason_code: "hygiene_non_returnable" });
  });

  it("hides products of an invisible store", async () => {
    const p = await activeProduct();
    const profile = await h.fixtures.stores.profile(STORE_A, "x");
    if (profile === null) throw new Error("fixture");
    h.fixtures.stores.set({ ...profile, visible: false });
    expect((await h.http().get(`/v1/products/${p.id}`).set(bearer(PRINCIPALS.buyer))).status).toBe(404);
    h.fixtures.stores.set(profile);
  });

  it("hides seller identity when the store profile is incomplete", async () => {
    const p = await activeProduct();
    const profile = await h.fixtures.stores.profile(STORE_A, "x");
    if (profile === null) throw new Error("fixture");
    h.fixtures.stores.set({ ...profile, legal: { ...profile.legal, taxCardNo: "" } });
    const r = await h.http().get(`/v1/products/${p.id}`).set(bearer(PRINCIPALS.buyer));
    expect(r.body.seller_legal_identity_visible).toBe(false);
    h.fixtures.stores.set(profile);
  });
});

describe("bulk CSV import over HTTP", () => {
  const HEADER = "product_ref,title_ar,title_en,description_ar,category_slug,brand_slug,condition,size_label,color,seller_sku,barcode_gtin,price_egp,initial_stock,image_upload_ids,defect_photo_upload_ids";
  const good = (ref: string, size: string) => `${ref},فستان ${ref},,وصف,dresses,acme,new_with_tags,${size},White,${ref}-${size},,1299.50,5,${UP_IMG},`;
  const csv = (lines: string[]) => [HEADER, ...lines].join("\n");
  const start = (p: TestPrincipal, data: Record<string, unknown>) =>
    h.http().post("/v1/seller/catalog/imports").set(bearer(p)).set("Idempotency-Key", idemKey()).send(data);

  it("defaults to dry run, never mutates, and is repeatable", async () => {
    h.fixtures.uploads.add(STORE_A, UP_CSV, csv([good("p1", "M"), good("p1", "L"), "p2,English,,,dresses,,new_with_tags,M,,,,10,,,"]));
    const snapshot = h.fixtures.products.snapshotForTest();
    const events = h.fixtures.events.events.length;
    const r1 = await start(PRINCIPALS.ownerA, { upload_id: UP_CSV });
    expect(r1.status).toBe(202);
    expect(r1.body).toMatchObject({ status: "dry_run_complete", dry_run: true, rows_total: 3, rows_ok: 2, rows_failed: 1 });
    expect(h.fixtures.products.snapshotForTest()).toBe(snapshot);
    expect(h.fixtures.events.events.length).toBe(events);
    const r2 = await start(PRINCIPALS.ownerA, { upload_id: UP_CSV, dry_run: true });
    expect(r2.body.error_report_url).toBe(r1.body.error_report_url);
    expect(h.fixtures.products.snapshotForTest()).toBe(snapshot);

    const report = Buffer.from(String(r1.body.error_report_url).split(",")[1] ?? "", "base64").toString("utf8");
    expect(report).toBe("row,column,code\n4,title_ar,arabic_text_required");
    const got = await h.http().get(`/v1/seller/catalog/imports/${r1.body.id}`).set(bearer(PRINCIPALS.ownerA));
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(r1.body.id);
  });

  it("applies only valid products on a real run and the result equals the dry-run report", async () => {
    h.fixtures.uploads.add(STORE_A, UP_CSV, csv([good("q1", "M"), good("q1", "L"), "q2,English,,,dresses,,new_with_tags,M,,,,10,,,"]));
    const dry = await start(PRINCIPALS.ownerA, { upload_id: UP_CSV, dry_run: true });
    const before = h.fixtures.products.countForTest();
    const real = await start(PRINCIPALS.ownerA, { upload_id: UP_CSV, dry_run: false });
    expect(real.status).toBe(202);
    expect(real.body).toMatchObject({ status: "completed", dry_run: false, rows_ok: 2, rows_failed: 1 });
    expect(real.body.error_report_url).toBe(dry.body.error_report_url);
    expect(h.fixtures.products.countForTest()).toBe(before + 1);
    const list = await h.http().get("/v1/seller/products?limit=50").set(bearer(PRINCIPALS.ownerA));
    const created = (list.body.items as { title: { ar: string }; status: string; skus: unknown[] }[]).find((x) => x.title.ar === "فستان q1");
    expect(created).toMatchObject({ status: "draft" });
    expect(created?.skus).toHaveLength(2);
  });

  it("fails a file with unknown columns without processing rows", async () => {
    h.fixtures.uploads.add(STORE_A, UP_CSV, "product_ref,title_ar,evil\n1,2,3");
    const before = h.fixtures.products.countForTest();
    const r = await start(PRINCIPALS.ownerA, { upload_id: UP_CSV, dry_run: false });
    expect(r.body).toMatchObject({ status: "failed", rows_total: 0 });
    expect(h.fixtures.products.countForTest()).toBe(before);
  });

  it("refuses another store's upload and bodies with extra keys", async () => {
    h.fixtures.uploads.add(STORE_B, "0192f3a4-5b6c-7d8e-9f01-0000000c0002", csv([good("z", "M")]));
    const r = await start(PRINCIPALS.ownerA, { upload_id: "0192f3a4-5b6c-7d8e-9f01-0000000c0002" });
    expect(r.status).toBe(422);
    expect(r.body.errors).toEqual([{ pointer: "/upload_id", code: "upload_not_found" }]);
    expect((await start(PRINCIPALS.ownerA, { upload_id: UP_CSV, store_id: STORE_B })).status).toBe(400);
  });

  it("neutralises formula cells in the report and never echoes cell values", async () => {
    const evil = `p9,=HYPERLINK("http://evil"),,,dresses,,new_with_tags,M,,,,abc,,,`;
    h.fixtures.uploads.add(STORE_A, UP_CSV, csv([evil]));
    const r = await start(PRINCIPALS.ownerA, { upload_id: UP_CSV });
    const report = Buffer.from(String(r.body.error_report_url).split(",")[1] ?? "", "base64").toString("utf8");
    expect(report).not.toMatch(/HYPERLINK|evil/);
  });
});
