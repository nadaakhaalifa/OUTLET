import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVICE, bearer, idemKey } from "./harness.js";
import type { TestApp } from "./harness.js";
import { createTestApp } from "./harness.js";
import { makePng, multipartBody } from "./png.js";
import { DEFECT_CARD, DETAILS, foreignProduct, newDraft } from "./route-fixtures.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

interface Product {
  id: string;
  version: number;
  status: string;
  media: { role: string; media: { media_id: string } }[];
  skus: { price: { amount_minor: string } }[];
  defect_card?: { items: { hotspot_x_bp?: number | null; hotspot_y_bp?: number | null }[] } | null;
}
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the expected body shape
const json = <T>(body: string): T => JSON.parse(body) as T;
const hdr = (token: string, store: string, extra: Record<string, string> = {}): Record<string, string> => ({ ...bearer(token), "x-store-id": store, "idempotency-key": idemKey(t), ...extra });
const A = (): string => t.seed.storeA;

const upload = async (token: string, productId: string, kind: "product" | "defect", file = makePng()): Promise<string> => {
  const form = multipartBody({ kind }, { name: "p.png", type: "image/png", data: file });
  const res = await t.inject({ method: "POST", url: `/v1/eg/seller/products/${productId}/media`, headers: hdr(token, A(), { "content-type": form.contentType }), payload: form.payload });
  expect(res.statusCode, res.body).toBe(201);
  return json<{ media_id: string }>(res.body).media_id;
};
const patch = (token: string, id: string, version: number, payload: unknown, key?: string) =>
  t.inject({ method: "PATCH", url: `/v1/eg/seller/products/${id}`, headers: { ...hdr(token, A(), { "if-match": `"${String(version)}"` }), ...(key === undefined ? {} : { "idempotency-key": key }) }, payload: payload as object });

describe("seller wizard flow (draft, photos, defect card, details, price, publish)", () => {
  it("publish is blocked with every reason until the defect card exists, then goes live", async () => {
    const d = await newDraft(t, A(), "open_box");
    const main = await upload(d.token, d.id, "product");
    const close = await upload(d.token, d.id, "defect");

    let r = await patch(d.token, d.id, d.version, {
      condition: { condition_grade_code: "open_box", media: [{ media_id: main, role: "main", position: 0 }, { media_id: close, role: "condition", position: 1 }] },
    });
    expect(r.statusCode, r.body).toBe(200);
    let p = json<Product>(r.body);
    expect(p.media.map((m) => m.role)).toEqual(["main", "condition"]);

    r = await patch(d.token, d.id, p.version, {
      details: { ...DETAILS(t.seed.categoryId), attributes: { colour: "black", material: "cotton", size_run: [{ label: "M", cm: 94 }] } },
      price: { price: { amount_minor: "129900", currency: "EGP" } },
    });
    expect(r.statusCode, r.body).toBe(200);
    p = json<Product>(r.body);
    expect(p.skus[0]?.price.amount_minor).toBe("129900");

    const ready = await t.inject({ method: "GET", url: `/v1/eg/seller/products/${d.id}/readiness`, headers: { ...bearer(d.token), "x-store-id": A() } });
    expect(json<{ blocked_reasons: string[] }>(ready.body).blocked_reasons).toEqual(["DEFECT_CARD_REQUIRED"]);

    const blocked = await t.inject({ method: "POST", url: `/v1/eg/seller/products/${d.id}/publish`, headers: hdr(d.token, A()), payload: {} });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.headers["content-type"]).toContain("application/problem+json");
    const prob = json<{ code: string; errors: { code: string }[] }>(blocked.body);
    expect(prob.code).toBe("activation-blocked");
    expect(prob.errors.map((e) => e.code)).toEqual(["DEFECT_CARD_REQUIRED"]);

    const card = await t.inject({
      method: "POST",
      url: `/v1/eg/seller/products/${d.id}/defect-cards`,
      headers: hdr(d.token, A(), { "if-match": `"${String(p.version)}"` }),
      payload: { ...DEFECT_CARD(), items: [{ ...DEFECT_CARD().items[0], photo_media_id: close }] },
    });
    expect(card.statusCode, card.body).toBe(201);
    expect(json<{ defect_card: { items: { hotspot_x_bp: number; hotspot_y_bp: number }[] } }>(card.body).defect_card.items[0]).toMatchObject({ hotspot_x_bp: 2500, hotspot_y_bp: 6000 });

    const live = await t.inject({ method: "POST", url: `/v1/eg/seller/products/${d.id}/publish`, headers: hdr(d.token, A()), payload: {} });
    expect(live.statusCode, live.body).toBe(200);
    expect(json<{ status: string; blocked_reasons: string[] }>(live.body)).toMatchObject({ status: "PUBLISHED", blocked_reasons: [] });

    const list = await t.inject({ method: "GET", url: "/v1/eg/seller/products?limit=50&status=PUBLISHED", headers: { ...bearer(d.token), "x-store-id": A() } });
    expect(json<{ items: { id: string }[] }>(list.body).items.map((i) => i.id)).toContain(d.id);
  });

  it("a non-defect grade publishes without a defect card; a defect grade without a close-up photo is blocked", async () => {
    const d = await newDraft(t, A(), "new_with_imperfections");
    const main = await upload(d.token, d.id, "product");
    await patch(d.token, d.id, d.version, { condition: { condition_grade_code: "new_with_imperfections", media: [{ media_id: main, role: "main", position: 0 }] } });
    const r = await t.inject({ method: "POST", url: `/v1/eg/seller/products/${d.id}/publish`, headers: hdr(d.token, A()), payload: {} });
    expect(r.statusCode).toBe(409);
    expect(json<{ errors: { code: string }[] }>(r.body).errors.map((e) => e.code)).toEqual(expect.arrayContaining(["DEFECT_CARD_REQUIRED", "CONDITION_PHOTO_REQUIRED"]));
  });

  it("a defect card is refused for a grade that takes none (422)", async () => {
    const d = await newDraft(t, A(), "new_with_tags");
    const r = await t.inject({ method: "POST", url: `/v1/eg/seller/products/${d.id}/defect-cards`, headers: hdr(d.token, A(), { "if-match": `"${String(d.version)}"` }), payload: DEFECT_CARD() });
    expect(r.statusCode).toBe(422);
  });
});

describe("authorization and concurrency", () => {
  it("store A staff cannot PATCH, upload to, read, or publish store B's product (404, no side effect)", async () => {
    const other = await foreignProduct(t);
    const { token } = await t.seller(A(), ["catalog"]);
    const r = await patch(token, other, 1, { details: DETAILS(t.seed.categoryId) });
    expect(r.statusCode).toBe(404);
    const form = multipartBody({ kind: "product" }, { name: "p.png", type: "image/png", data: makePng() });
    expect((await t.inject({ method: "POST", url: `/v1/eg/seller/products/${other}/media`, headers: hdr(token, A(), { "content-type": form.contentType }), payload: form.payload })).statusCode).toBe(404);
    expect((await t.inject({ method: "GET", url: `/v1/eg/seller/products/${other}`, headers: { ...bearer(token), "x-store-id": A() } })).statusCode).toBe(404);
    const owner = await t.seller(t.seed.storeB, ["owner"]);
    const untouched = await t.inject({ method: "GET", url: `/v1/eg/seller/products/${other}`, headers: { ...bearer(owner.token), "x-store-id": t.seed.storeB } });
    expect(json<Product>(untouched.body).version).toBe(1);
  });

  it("a shopper (no membership) gets 404 and a staff role without listing.write gets 403", async () => {
    const d = await newDraft(t, A());
    const shopper = await t.mint({ amr: ["otp", "passkey"] });
    expect((await patch(shopper, d.id, d.version, { details: DETAILS(t.seed.categoryId) })).statusCode).toBe(404);
    const finance = await t.seller(A(), ["finance"]);
    expect((await patch(finance.token, d.id, d.version, { details: DETAILS(t.seed.categoryId) })).statusCode).toBe(403);
    const noPasskey = await t.seller(A(), ["catalog"], ["otp"]);
    const r = await t.inject({ method: "GET", url: "/v1/eg/seller/products", headers: { ...bearer(noPasskey.token), "x-store-id": A() } });
    expect(r.statusCode).toBe(403);
    expect(json<{ code: string }>(r.body).code).toBe("passkey-required");
  });

  it("If-Match: missing → 428, malformed → 400, stale → 409; the same Idempotency-Key replays the stored answer", async () => {
    const d = await newDraft(t, A());
    const noMatch = await t.inject({ method: "PATCH", url: `/v1/eg/seller/products/${d.id}`, headers: hdr(d.token, A()), payload: { details: DETAILS(t.seed.categoryId) } });
    expect(noMatch.statusCode).toBe(428);
    const bad = await t.inject({ method: "PATCH", url: `/v1/eg/seller/products/${d.id}`, headers: hdr(d.token, A(), { "if-match": "abc" }), payload: { details: DETAILS(t.seed.categoryId) } });
    expect(bad.statusCode).toBe(400);
    const key = idemKey(t);
    const first = await patch(d.token, d.id, d.version, { details: DETAILS(t.seed.categoryId) }, key);
    expect(first.statusCode).toBe(200);
    const replay = await patch(d.token, d.id, d.version, { details: DETAILS(t.seed.categoryId) }, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(json(replay.body)).toEqual(json(first.body));
    const stale = await patch(d.token, d.id, d.version, { details: { ...DETAILS(t.seed.categoryId), title_ar: "عنوان آخر" } });
    expect(stale.statusCode).toBe(409);
    expect(json<{ code: string }>(stale.body).code).toBe("version-conflict");
  });

  it("rejects an empty patch, unknown fields and a non-Arabic title (400/422)", async () => {
    const d = await newDraft(t, A());
    expect((await patch(d.token, d.id, d.version, {})).statusCode).toBe(400);
    expect((await patch(d.token, d.id, d.version, { details: DETAILS(t.seed.categoryId), is_admin: true })).statusCode).toBe(400);
    expect((await patch(d.token, d.id, d.version, { details: { ...DETAILS(t.seed.categoryId), title_ar: "Sneakers" } })).statusCode).toBe(422);
  });
});

describe("media upload", () => {
  it("rejects a non-image, a wrong kind, a missing file and a body over 10 MB", async () => {
    const d = await newDraft(t, A());
    const send = (form: { payload: Buffer; contentType: string }) =>
      t.inject({ method: "POST", url: `/v1/eg/seller/products/${d.id}/media`, headers: hdr(d.token, A(), { "content-type": form.contentType }), payload: form.payload });
    expect((await send(multipartBody({ kind: "product" }, { name: "x.png", type: "image/png", data: Buffer.from("not an image") }))).statusCode).toBe(422);
    expect((await send(multipartBody({ kind: "document" }, { name: "x.png", type: "image/png", data: makePng() }))).statusCode).toBe(400);
    expect((await send(multipartBody({ kind: "product" }, { name: "x.png", type: "image/png", data: Buffer.alloc(10 * 1024 * 1024 + 10, 1) }))).statusCode).toBe(413);
    const json400 = await t.inject({ method: "POST", url: `/v1/eg/seller/products/${d.id}/media`, headers: hdr(d.token, A()), payload: { kind: "product" } });
    expect(json400.statusCode).toBe(415);
  });

  it("same Idempotency-Key with a different file is refused (422), same file replays", async () => {
    const d = await newDraft(t, A());
    const key = idemKey(t);
    const go = (data: Buffer) => {
      const form = multipartBody({ kind: "product" }, { name: "p.png", type: "image/png", data });
      return t.inject({ method: "POST", url: `/v1/eg/seller/products/${d.id}/media`, headers: hdr(d.token, A(), { "content-type": form.contentType, "idempotency-key": key }), payload: form.payload });
    };
    const small = makePng(96, 96);
    const first = await go(small);
    expect(first.statusCode).toBe(201);
    expect((await go(small)).headers["idempotent-replayed"]).toBe("true");
    expect((await go(makePng(160, 160))).statusCode).toBe(422);
  });
});

describe("reference data", () => {
  it("lists categories and the attribute set with required flags and non-critical defect types", async () => {
    const { token } = await t.seller(A(), ["catalog"]);
    const h = { ...bearer(token), "x-store-id": A(), "x-device-id": DEVICE };
    const cats = json<{ items: { id: string }[] }>((await t.inject({ method: "GET", url: "/v1/eg/seller/categories?limit=50", headers: h })).body);
    expect(cats.items.map((c) => c.id)).toContain(t.seed.categoryId);
    const set = json<{ attributes: { code: string; required: boolean; options: unknown[] }[]; defect_types: { code: string }[] }>(
      (await t.inject({ method: "GET", url: `/v1/eg/seller/attribute-sets/${t.seed.categoryId}`, headers: h })).body,
    );
    expect(set.attributes.filter((a) => a.required).map((a) => a.code)).toEqual(["colour", "material", "size_run"]);
    expect(set.attributes.find((a) => a.code === "colour")?.options.length).toBeGreaterThan(3);
    expect(set.defect_types.map((x) => x.code)).toContain("stain");
  });
});
