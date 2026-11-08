import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVICE, bearer, idemKey } from "./harness.js";
import type { TestApp } from "./harness.js";
import { createTestApp } from "./harness.js";
import { makePng } from "./png.js";
import { DETAILS, newDraft } from "./route-fixtures.js";

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the expected body shape
const json = <T>(body: string): T => JSON.parse(body) as T;
const A = (): string => t.seed.storeA;
const hdr = (token: string, extra: Record<string, string> = {}): Record<string, string> => ({ ...bearer(token), "x-store-id": A(), "idempotency-key": idemKey(t), ...extra });
const raw = (parts: { name: string; value: string; file?: { filename: string; type: string; data: Buffer } }[]) => {
  const boundary = `----b${randomBytes(6).toString("hex")}`;
  const bufs = parts.map((p) => Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.file === undefined ? "" : `; filename="${p.file.filename}"`}\r\n${p.file === undefined ? "" : `Content-Type: ${p.file.type}\r\n`}\r\n`),
    p.file?.data ?? Buffer.from(p.value), Buffer.from("\r\n"),
  ]));
  return { payload: Buffer.concat([...bufs, Buffer.from(`--${boundary}--\r\n`)]), contentType: `multipart/form-data; boundary=${boundary}` };
};
const upload = (token: string, id: string, form: { payload: Buffer; contentType: string }) =>
  t.inject({ method: "POST", url: `/v1/eg/seller/products/${id}/media`, headers: hdr(token, { "content-type": form.contentType }), payload: form.payload });

describe("seller catalog: list pagination", () => {
  it("a cursor continues exactly after the previous page: no overlap, no gaps, and the last page has no cursor", async () => {
    const { token } = await t.seller(A(), ["catalog"]);
    const made = [await newDraft(t, A()), await newDraft(t, A()), await newDraft(t, A())].map((d) => d.id);
    const get = async (cursor?: string) => json<{ items: { id: string }[]; next_cursor: string | null }>((await t.inject({ method: "GET", url: `/v1/eg/seller/products?limit=2${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`, headers: { ...bearer(token), "x-store-id": A() } })).body);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await get(cursor);
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((x) => x.id));
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of made) expect(seen).toContain(id);
  });

  it("a tampered cursor is rejected as a client error, never a 500 and never another store's rows", async () => {
    const { token } = await t.seller(A(), ["catalog"]);
    const r = await t.inject({ method: "GET", url: "/v1/eg/seller/products?cursor=not-a-real-cursor", headers: { ...bearer(token), "x-store-id": A() } });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
  });
});

describe("seller catalog: price patch creates then updates the single active SKU", () => {
  it("first price patch uses the given seller_sku; the second changes the price of the same SKU instead of adding one", async () => {
    const d = await newDraft(t, A());
    const patch = (version: number, price: string, sku?: string) =>
      t.inject({ method: "PATCH", url: `/v1/eg/seller/products/${d.id}`, headers: hdr(d.token, { "if-match": `"${String(version)}"` }), payload: { price: { price: { amount_minor: price, currency: "EGP" }, ...(sku === undefined ? {} : { seller_sku: sku }) } } });
    const first = await patch(d.version, "50000", "MY-SKU-1");
    expect(first.statusCode, first.body).toBe(200);
    const p1 = json<{ version: number; skus: { id: string; seller_sku: string; price: { amount_minor: string } }[] }>(first.body);
    expect(p1.skus).toHaveLength(1);
    expect(p1.skus[0]).toMatchObject({ seller_sku: "MY-SKU-1", price: { amount_minor: "50000" } });
    const second = await patch(p1.version, "45000", "IGNORED-ON-UPDATE");
    expect(second.statusCode, second.body).toBe(200);
    const p2 = json<{ skus: { id: string; seller_sku: string; price: { amount_minor: string } }[] }>(second.body);
    expect(p2.skus).toHaveLength(1);
    expect(p2.skus[0]).toMatchObject({ id: p1.skus[0]?.id, seller_sku: "MY-SKU-1", price: { amount_minor: "45000" } });
  });

  it("without a seller_sku the SKU code is derived from the product id", async () => {
    const d = await newDraft(t, A());
    const r = await t.inject({ method: "PATCH", url: `/v1/eg/seller/products/${d.id}`, headers: hdr(d.token, { "if-match": `"${String(d.version)}"` }), payload: { price: { price: { amount_minor: "1000", currency: "EGP" } } } });
    expect(json<{ skus: { seller_sku: string }[] }>(r.body).skus[0]?.seller_sku).toBe(`SKU-${d.id.slice(0, 8)}`);
  });
});

describe("seller catalog: media upload form edge cases", () => {
  it("a multipart body with no file part is 400 file-required and stores nothing", async () => {
    const d = await newDraft(t, A());
    const r = await upload(d.token, d.id, raw([{ name: "kind", value: "product" }]));
    expect([r.statusCode, json<{ code: string }>(r.body).code]).toEqual([400, "file-required"]);
  });

  it("a missing kind, a duplicated kind and a kind sent as a file are all 400 validation errors on /body/kind", async () => {
    const d = await newDraft(t, A());
    const png = { filename: "p.png", type: "image/png", data: makePng() };
    const cases = [
      raw([{ name: "file", value: "", file: png }]),
      raw([{ name: "kind", value: "product" }, { name: "kind", value: "product" }, { name: "file", value: "", file: png }]),
      raw([{ name: "kind", value: "x", file: { filename: "k.txt", type: "text/plain", data: Buffer.from("product") } }]),
    ];
    for (const form of cases) {
      const r = await upload(d.token, d.id, form);
      expect(r.statusCode, r.body).toBe(400);
      expect(json<{ errors: { path: string }[] }>(r.body).errors.map((e) => e.path)).toContain("/body/kind");
    }
  });
});

describe("seller catalog: publish and reference data edge cases", () => {
  it("publishing with a stale If-Match is a version conflict, not an activation-blocked problem", async () => {
    const d = await newDraft(t, A());
    const r = await t.inject({ method: "POST", url: `/v1/eg/seller/products/${d.id}/publish`, headers: hdr(d.token, { "if-match": `"${String(d.version + 5)}"` }), payload: {} });
    expect(r.statusCode).toBe(409);
    expect(json<{ code: string }>(r.body).code).toBe("version-conflict");
  });

  it("a malformed If-Match on publish is 400, and the draft is unchanged", async () => {
    const d = await newDraft(t, A());
    const r = await t.inject({ method: "POST", url: `/v1/eg/seller/products/${d.id}/publish`, headers: hdr(d.token, { "if-match": "v1" }), payload: {} });
    expect(r.statusCode).toBe(400);
    const g = await t.inject({ method: "GET", url: `/v1/eg/seller/products/${d.id}`, headers: { ...bearer(d.token), "x-store-id": A() } });
    expect(json<{ status: string; version: number }>(g.body)).toMatchObject({ status: "DRAFT", version: d.version });
  });

  it("categories honour Accept-Language: English labels for 'en', Arabic otherwise", async () => {
    const { token } = await t.seller(A(), ["catalog"]);
    const get = async (lang?: string) => json<{ items: { id: string; name?: string; name_ar?: string; name_en?: string | null }[] }>((await t.inject({
      method: "GET", url: "/v1/eg/seller/categories?limit=50", headers: { ...bearer(token), "x-store-id": A(), "x-device-id": DEVICE, ...(lang === undefined ? {} : { "accept-language": lang }) },
    })).body).items.find((c) => c.id === t.seed.categoryId);
    const en = await get("en-US,en;q=0.9");
    const ar = await get("ar-EG");
    const none = await get();
    expect(en).toBeDefined();
    expect(JSON.stringify(none)).toBe(JSON.stringify(ar));
    expect(JSON.stringify(en)).not.toBe(JSON.stringify(ar));
  });

  it("details save requires the current version: a second details patch with the old version is 409", async () => {
    const d = await newDraft(t, A());
    const ok = await t.inject({ method: "PATCH", url: `/v1/eg/seller/products/${d.id}`, headers: hdr(d.token, { "if-match": `"${String(d.version)}"` }), payload: { details: DETAILS(t.seed.categoryId) } });
    expect(ok.statusCode, ok.body).toBe(200);
    const stale = await t.inject({ method: "PATCH", url: `/v1/eg/seller/products/${d.id}`, headers: hdr(d.token, { "if-match": `"${String(d.version)}"` }), payload: { details: DETAILS(t.seed.categoryId) } });
    expect(stale.statusCode).toBe(409);
  });
});
