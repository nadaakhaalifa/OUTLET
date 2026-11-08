import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: (k: string) => (jar.has(k) ? { value: jar.get(k) } : undefined) }) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));

import { sellerGet } from "../src/server/seller-get";
import { alternateLinks, parseSegment, DEFAULT_SEGMENT } from "../src/lib/segment";
import { requireLocale } from "../src/lib/segment-page";
import { createSellerApi } from "../src/client/seller-api";

describe("segment", () => {
  it("parses valid segments and rejects invalid ones", () => {
    expect(DEFAULT_SEGMENT).toBe("eg-ar");
    expect(parseSegment("eg-ar")).toMatchObject({ marketId: "eg", locale: "ar-EG", dir: "rtl" });
    expect(parseSegment("eg-en")).toMatchObject({ locale: "en-EG", dir: "ltr" });
    for (const bad of ["xx-ar", "eg-fr", "EG-AR", "eg", ""]) expect(parseSegment(bad)).toBeNull();
  });
  it("builds canonical and hreflang alternates per locale", () => {
    const en = parseSegment("eg-en")!;
    expect(alternateLinks(en, "/products")).toEqual({
      canonical: "/eg-en/products",
      languages: { "ar-EG": "/eg-ar/products", "en-EG": "/eg-en/products", "x-default": "/eg-ar/products" },
    });
    expect(alternateLinks(parseSegment("eg-ar")!, "").canonical).toBe("/eg-ar");
  });
  it("requireLocale resolves or 404s", async () => {
    await expect(requireLocale(Promise.resolve({ segment: "eg-en" }))).resolves.toMatchObject({ locale: "en-EG" });
    await expect(requireLocale(Promise.resolve({ segment: "zz-zz" }))).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("sellerGet", () => {
  beforeEach(() => { jar.clear(); vi.stubEnv("API_URL", "https://api.example.test/"); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("fails closed with 503 when the API is not configured (never fabricates data)", async () => {
    vi.stubEnv("API_URL", "");
    expect(await sellerGet("eg", "products")).toEqual({ ok: false, status: 503, code: "api-unconfigured" });
  });
  it("401 without a session, even when a store cookie exists; empty token counts as none", async () => {
    jar.set("seller_store", "s1");
    expect(await sellerGet("eg", "products")).toEqual({ ok: false, status: 401, code: "unauthenticated" });
    jar.set("seller_session", "");
    expect((await sellerGet("eg", "products")).ok).toBe(false);
  });
  it("400 store-scope-required without a store (missing or empty)", async () => {
    jar.set("seller_session", "tok");
    expect(await sellerGet("eg", "products")).toEqual({ ok: false, status: 400, code: "store-scope-required" });
    jar.set("seller_store", "");
    expect(await sellerGet("eg", "products")).toEqual({ ok: false, status: 400, code: "store-scope-required" });
  });
  it("sends the bearer token and store id, strips the trailing slash, and returns parsed data", async () => {
    jar.set("seller_session", "tok");
    jar.set("seller_store", "s1");
    const f = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ items: [1] }), { status: 200 })));
    vi.stubGlobal("fetch", f);
    expect(await sellerGet("eg", "products")).toEqual({ ok: true, data: { items: [1] } });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.test/v1/eg/seller/products");
    expect(init.headers).toMatchObject({ authorization: "Bearer tok", "x-store-id": "s1" });
    expect(init.cache).toBe("no-store");
  });
  it.each([
    [JSON.stringify({ code: "forbidden" }), 403, "forbidden"],
    [JSON.stringify({ code: 7 }), 500, "unknown"],
    ["<html>", 502, "unknown"],
  ])("maps a %s error body (status %i) to code %s", async (body, status, code) => {
    jar.set("seller_session", "tok");
    jar.set("seller_store", "s1");
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(body, { status })));
    expect(await sellerGet("eg", "x")).toEqual({ ok: false, status, code });
  });
  it("a network failure or a non-JSON 200 never throws", async () => {
    jar.set("seller_session", "tok");
    jar.set("seller_store", "s1");
    vi.stubGlobal("fetch", () => Promise.reject(new Error("down")));
    expect(await sellerGet("eg", "x")).toEqual({ ok: false, status: 503, code: "api-unavailable" });
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("not json", { status: 200 })));
    expect(await sellerGet("eg", "x")).toEqual({ ok: false, status: 503, code: "api-unavailable" });
  });
});

describe("createSellerApi", () => {
  const res = (body: unknown, status = 200): Response => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  const wire = { id: "p1", version: 1, status: "DRAFT" };

  it("GETs without an idempotency key, mutations carry one plus If-Match and a JSON body", async () => {
    const f = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() => Promise.resolve(res(wire)));
    const api = createSellerApi("eg", f as unknown as typeof fetch);
    await api.getProduct("p1");
    let h = f.mock.calls[0]![1].headers as Record<string, string>;
    expect(f.mock.calls[0]![0]).toBe("/api/seller/eg/products/p1");
    expect(h["idempotency-key"]).toBeUndefined();
    expect(h["content-type"]).toBeUndefined();
    await api.patch("p1", 3, { a: 1 });
    h = f.mock.calls[1]![1].headers as Record<string, string>;
    expect(h["if-match"]).toBe('"3"');
    expect(h["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(h["content-type"]).toBe("application/json");
    expect(f.mock.calls[1]![1].body).toBe('{"a":1}');
    await api.createDraft("open_box", "c1");
    expect(JSON.parse(f.mock.calls[2]![1].body as string)).toEqual({ condition_grade_code: "open_box", primary_category_id: "c1" });
    await api.defectCard("p1", 2, {});
    await api.publish("p1", 2);
    await api.readiness("p1");
    await api.attributeSet("c1");
    expect(f.mock.calls.map((c) => c[0]).slice(3)).toEqual(["/api/seller/eg/products/p1/defect-cards", "/api/seller/eg/products/p1/publish", "/api/seller/eg/products/p1/readiness", "/api/seller/eg/attribute-sets/c1"]);
  });
  it("maps Problem bodies to failures with reason codes; unknown bodies to code unknown", async () => {
    const api = (r: Response) => createSellerApi("eg", () => Promise.resolve(r));
    expect(await api(res({ code: "validation-failed", errors: [{ code: "A" }, { code: "B" }] }, 422)).getProduct("p")).toEqual({ ok: false, status: 422, code: "validation-failed", reasons: ["A", "B"] });
    expect(await api(res({ code: "not-found" }, 404)).getProduct("p")).toEqual({ ok: false, status: 404, code: "not-found", reasons: [] });
    expect(await api(res("<html>", 502)).getProduct("p")).toEqual({ ok: false, status: 502, code: "unknown", reasons: [] });
    expect(await api(res({ nope: 1 }, 500)).getProduct("p")).toMatchObject({ code: "unknown" });
  });
  it("rejects a malformed success body and reports network errors as status 0", async () => {
    expect(await createSellerApi("eg", () => Promise.resolve(res({ id: 1 }))).getProduct("p")).toEqual({ ok: false, status: 200, code: "bad-response", reasons: [] });
    expect(await createSellerApi("eg", () => Promise.reject(new Error("x"))).getProduct("p")).toEqual({ ok: false, status: 0, code: "network", reasons: [] });
  });
  it("categories unwraps the page items and passes failures through", async () => {
    const page = { items: [{ id: "c", name: "n", depth: 1, path: "a/b" }], next_cursor: null };
    expect(await createSellerApi("eg", () => Promise.resolve(res(page))).categories()).toEqual({ ok: true, data: page.items });
    expect(await createSellerApi("eg", () => Promise.resolve(res({ code: "forbidden" }, 403))).categories()).toMatchObject({ ok: false, status: 403 });
  });
  it("defaults to the global fetch", async () => {
    const f = vi.fn(() => Promise.resolve(res(wire)));
    vi.stubGlobal("fetch", f);
    expect((await createSellerApi("eg").getProduct("p")).ok).toBe(true);
    expect(f).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  describe("upload (XHR)", () => {
    class FakeXhr {
      static last: FakeXhr;
      status = 200;
      responseText = "";
      upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      headers: Record<string, string> = {};
      sent: FormData | null = null;
      url = "";
      constructor() { FakeXhr.last = this; }
      open(_m: string, url: string): void { this.url = url; }
      setRequestHeader(k: string, v: string): void { this.headers[k] = v; }
      send(f: FormData): void { this.sent = f; }
    }
    beforeEach(() => { vi.stubGlobal("XMLHttpRequest", FakeXhr); });
    const file = new File([new Uint8Array([1])], "a.png", { type: "image/png" });

    it("sends kind before file with an idempotency key, reports measurable progress only, and parses the media id", async () => {
      const progress = vi.fn();
      const p = createSellerApi("eg").upload("p1", "defect", file, progress);
      const x = FakeXhr.last;
      expect(x.url).toBe("/api/seller/eg/products/p1/media");
      expect(x.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(Array.from(x.sent!.keys())).toEqual(["kind", "file"]);
      expect(x.sent!.get("kind")).toBe("defect");
      x.upload.onprogress!({ lengthComputable: true, loaded: 1, total: 4 });
      x.upload.onprogress!({ lengthComputable: false, loaded: 0, total: 0 });
      expect(progress).toHaveBeenCalledTimes(1);
      expect(progress).toHaveBeenCalledWith(0.25);
      x.responseText = JSON.stringify({ media_id: "m1" });
      x.onload!();
      expect(await p).toEqual({ ok: true, data: { media_id: "m1" } });
    });
    it("maps HTTP errors through the Problem parser, bad bodies to bad-response, and network errors to network", async () => {
      const run = (fn: (x: FakeXhr) => void) => { const p = createSellerApi("eg").upload("p", "product", file, vi.fn()); fn(FakeXhr.last); return p; };
      expect(await run((x) => { x.status = 413; x.responseText = JSON.stringify({ code: "too-large" }); x.onload!(); })).toEqual({ ok: false, status: 413, code: "too-large", reasons: [] });
      expect(await run((x) => { x.status = 199; x.responseText = ""; x.onload!(); })).toMatchObject({ ok: false, status: 199, code: "unknown" });
      expect(await run((x) => { x.responseText = JSON.stringify({ wrong: 1 }); x.onload!(); })).toEqual({ ok: false, status: 200, code: "bad-response", reasons: [] });
      expect(await run((x) => { x.responseText = "not json"; x.onload!(); })).toEqual({ ok: false, status: 200, code: "bad-response", reasons: [] });
      expect(await run((x) => { x.onerror!(); })).toEqual({ ok: false, status: 0, code: "network", reasons: [] });
    });
  });
});
