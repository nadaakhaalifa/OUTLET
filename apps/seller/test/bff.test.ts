import { describe, expect, it } from "vitest";
import { passResponse, planProxy, problemResponse, sameOrigin, type BffInput } from "../src/server/bff";

const STORE = "0b7d1f4e-0000-4000-8000-000000000001";
const PRODUCT = "0b7d1f4e-0000-4000-8000-0000000000aa";
const jar = (m: Record<string, string>) => ({ get: (n: string) => (m[n] === undefined ? undefined : { value: m[n] }) });
const input = (over: Partial<BffInput> = {}): BffInput => ({
  method: "GET",
  segments: ["eg", "products"],
  search: "?limit=20",
  headers: new Headers({ host: "seller.test", "idempotency-key": "k", "if-match": '"2"', cookie: "secret", "x-forwarded-for": "1.1.1.1" }),
  cookies: jar({ seller_session: "tok", seller_store: STORE }),
  body: null,
  apiUrl: "http://api.test/",
  ...over,
});

describe("planProxy", () => {
  it("forwards GET to the seller route with bearer and store, dropping cookies and unknown headers", () => {
    const plan = planProxy(input());
    expect(plan.kind).toBe("forward");
    if (plan.kind !== "forward") return;
    expect(plan.url).toBe("http://api.test/v1/eg/seller/products?limit=20");
    expect(plan.init.headers.get("authorization")).toBe("Bearer tok");
    expect(plan.init.headers.get("x-store-id")).toBe(STORE);
    expect(plan.init.headers.get("cookie")).toBeNull();
    expect(plan.init.headers.get("x-forwarded-for")).toBeNull();
    expect(plan.init.headers.get("if-match")).toBe('"2"');
  });

  it("forwards a seller order cancel POST to the API with the Idempotency-Key and the JSON body", () => {
    const plan = planProxy(input({ segments: ["eg", "orders", PRODUCT, "cancel"], method: "POST", headers: new Headers({ host: "seller.test", origin: "http://seller.test", "sec-fetch-site": "same-origin", "idempotency-key": "0190a000-0000-7000-8000-000000000001", "content-type": "application/json", cookie: "secret" }) }));
    expect(plan.kind).toBe("forward");
    if (plan.kind !== "forward") return;
    expect(plan.url).toBe(`http://api.test/v1/eg/seller/orders/${PRODUCT}/cancel`);
    expect(plan.init.headers.get("idempotency-key")).toBe("0190a000-0000-7000-8000-000000000001");
    expect(plan.init.headers.get("cookie")).toBeNull();
  });

  it("allows only the seller catalog paths", () => {
    for (const path of [["products", PRODUCT], ["products", PRODUCT, "readiness"], ["products", PRODUCT, "media"], ["products", PRODUCT, "defect-cards"], ["products", PRODUCT, "publish"], ["categories"], ["attribute-sets", PRODUCT], ["orders"], ["orders", PRODUCT], ["orders", PRODUCT, "accept"], ["orders", PRODUCT, "cancel"], ["orders", PRODUCT, "reject"], ["orders", PRODUCT, "pack"], ["shipments"], ["inventory"], ["inventory", "adjustments"]]) {
      expect(planProxy(input({ segments: ["eg", ...path] })).kind, path.join("/")).toBe("forward");
    }
    for (const path of [["orders", "not-a-uuid"], ["orders", PRODUCT, "ship"], ["orders", PRODUCT, "../../me"], ["shipments", PRODUCT], ["inventory", "units"], ["products", "not-a-uuid"], ["products", PRODUCT, "../../me"], ["store", "members"], []]) {
      expect(planProxy(input({ segments: ["eg", ...path] })), path.join("/")).toMatchObject({ kind: "reject", status: 404 });
    }
    expect(planProxy(input({ segments: ["EG", "products"] }))).toMatchObject({ status: 404 });
  });

  it("rejects missing session (401), missing or malformed store (400), unconfigured API (503), unsupported methods (405)", () => {
    expect(planProxy(input({ cookies: jar({ seller_store: STORE }) }))).toMatchObject({ kind: "reject", status: 401, code: "unauthenticated" });
    expect(planProxy(input({ cookies: jar({ seller_session: "tok" }) }))).toMatchObject({ status: 400, code: "store-scope-required" });
    expect(planProxy(input({ cookies: jar({ seller_session: "tok", seller_store: "x" }) }))).toMatchObject({ status: 400 });
    expect(planProxy(input({ apiUrl: undefined }))).toMatchObject({ status: 503, code: "api-unconfigured" });
    expect(planProxy(input({ method: "DELETE" }))).toMatchObject({ status: 405 });
  });

  it("writes need a same-origin request (CSRF) and carry the body", () => {
    const write = input({ method: "PATCH", segments: ["eg", "products", PRODUCT], body: new ArrayBuffer(2) });
    expect(planProxy(write)).toMatchObject({ kind: "reject", status: 403, code: "cross-origin" });
    const good = planProxy({ ...write, headers: new Headers({ host: "seller.test", origin: "http://seller.test", "sec-fetch-site": "same-origin", "idempotency-key": "k" }) });
    expect(good.kind).toBe("forward");
    if (good.kind === "forward") expect(good.init.body).toBeDefined();
  });
});

describe("sameOrigin", () => {
  it("accepts matching Origin/Host and same-origin fetch metadata; rejects cross-site and other hosts", () => {
    expect(sameOrigin(new Headers({ host: "a.test", origin: "https://a.test" }))).toBe(true);
    expect(sameOrigin(new Headers({ host: "a.test", origin: "https://evil.test" }))).toBe(false);
    expect(sameOrigin(new Headers({ host: "a.test", origin: "https://a.test", "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(sameOrigin(new Headers({ host: "a.test" }))).toBe(false);
    expect(sameOrigin(new Headers({ host: "a.test", "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(sameOrigin(new Headers({ host: "a.test", origin: "not a url" }))).toBe(false);
  });
});

describe("responses", () => {
  it("problems are no-store problem+json; upstream headers are allow-listed", async () => {
    const p = problemResponse(401, "unauthenticated");
    expect(p.headers.get("content-type")).toBe("application/problem+json");
    expect(p.headers.get("cache-control")).toBe("no-store");
    const up = new Response('{"a":1}', { status: 409, headers: { "content-type": "application/problem+json", "set-cookie": "x=1", etag: 'W/"1"', "x-powered-by": "nest" } });
    const out = await passResponse(up);
    expect(out.status).toBe(409);
    expect(out.headers.get("set-cookie")).toBeNull();
    expect(out.headers.get("x-powered-by")).toBeNull();
    expect(out.headers.get("etag")).toBe('W/"1"');
    expect(await out.text()).toBe('{"a":1}');
    expect((await passResponse(new Response(null, { status: 304 }))).status).toBe(304);
  });

  describe("onboarding (user tenant, no store)", () => {
    const noStore = jar({ seller_session: "tok" });
    it("forwards the applicant routes with the bearer and without X-Store-Id", () => {
      for (const [method, path] of [["GET", ["onboarding"]], ["POST", ["onboarding"]], ["PUT", ["onboarding", "bank-account"]], ["POST", ["onboarding", "documents"]], ["POST", ["onboarding", "submit"]]] as const) {
        const plan = planProxy(input({ method, segments: ["eg", ...path], search: "", cookies: noStore, headers: new Headers({ host: "seller.test", origin: "http://seller.test", "sec-fetch-site": "same-origin", "content-type": "multipart/form-data; boundary=x" }), body: new ArrayBuffer(1) }));
        expect(plan.kind, `${method} ${path.join("/")}`).toBe("forward");
        if (plan.kind !== "forward") continue;
        expect(plan.url).toBe(`http://api.test/v1/eg/seller/${path.join("/")}`);
        expect(plan.init.headers.get("x-store-id")).toBeNull();
        expect(plan.init.headers.get("authorization")).toBe("Bearer tok");
        expect(plan.init.headers.get("content-type")).toContain("multipart");
      }
    });
    it("still needs a session, a same-origin write, and the right method and path", () => {
      expect(planProxy(input({ segments: ["eg", "onboarding"], cookies: jar({}) }))).toMatchObject({ status: 401 });
      expect(planProxy(input({ method: "POST", segments: ["eg", "onboarding"], cookies: noStore, headers: new Headers({ host: "seller.test", origin: "http://evil.test" }) }))).toMatchObject({ status: 403 });
      expect(planProxy(input({ method: "PATCH", segments: ["eg", "onboarding"], cookies: noStore }))).toMatchObject({ status: 405 });
      expect(planProxy(input({ method: "PUT", segments: ["eg", "products"] }))).toMatchObject({ status: 405 });
      expect(planProxy(input({ segments: ["eg", "onboarding", "members"], cookies: noStore }))).toMatchObject({ status: 404 });
      expect(planProxy(input({ segments: ["eg", "products"], cookies: noStore }))).toMatchObject({ status: 400 });
    });
  });
});
