import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import { AdsModule, MissingAdsPortsError } from "./ads.module";
import { InMemoryAdsStore } from "./adapters/in-memory";
import { markSponsored, servableSelections } from "./adapters/search-bridge";
import { EGP, IDEM, P_A1, P_A2, P_B1, STORE_A, STORE_B, TOKENS, U, bearer, createAdsHarness, type AdsHarness } from "./test/harness";

let h: AdsHarness;
let seq = 0;
const idem = (): Record<string, string> => ({ "Idempotency-Key": IDEM(++seq) });
const money = (n: number) => ({ amount: String(EGP(n)), currency: "EGP" });
const iso = (ms: number): string => new Date(ms).toISOString();

beforeAll(async () => {
  h = await createAdsHarness();
  h.rt.flags.enabled = true;
}, 60_000);
afterAll(async () => {
  await h.close();
});

type Method = "get" | "post" | "patch" | "put";
const send = (method: Method, path: string, token: string | null, body?: unknown, extra: Record<string, string> = idem()) => {
  h.rt.clock.advance(61_000);
  let r = h.http()[method](path).set(extra);
  if (token !== null) r = r.set(bearer(token));
  return body === undefined ? r : r.send(body as object);
};
const campaignBody = (over: Record<string, unknown> = {}) => ({
  store_id: STORE_A,
  name: "Summer dresses",
  daily_budget: money(100),
  max_cpc: money(5),
  keywords: ["dress"],
  categories: [],
  starts_at: iso(h.rt.clock.nowMs() - 1_000),
  bids: [{ product_id: P_A1, bid: money(3) }],
  ...over,
});

describe("authentication and authorization matrix (negative test on every route)", () => {
  const routes: [Method, string, unknown][] = [
    ["post", "/v1/seller/ads/campaigns", {}],
    ["get", `/v1/seller/ads/campaigns?store_id=${STORE_A}`, undefined],
    ["get", `/v1/seller/ads/campaigns/${U(900)}`, undefined],
    ["patch", `/v1/seller/ads/campaigns/${U(900)}`, {}],
    ["post", `/v1/seller/ads/campaigns/${U(900)}/pause`, {}],
    ["post", `/v1/seller/ads/campaigns/${U(900)}/resume`, {}],
    ["post", "/v1/seller/ads/topup", {}],
    ["get", `/v1/seller/ads/balance?store_id=${STORE_A}`, undefined],
    ["get", `/v1/seller/ads/reports?store_id=${STORE_A}&from=2026-04-01T00:00:00Z&to=2026-05-01T00:00:00Z`, undefined],
    ["get", "/v1/admin/ads/config", undefined],
    ["put", "/v1/admin/ads/config", {}],
  ];
  for (const [method, path, body] of routes) {
    it(`${method.toUpperCase()} ${path.split("?")[0]}: 401 without a token and for the wrong audience`, async () => {
      expect((await send(method, path, null, body)).status).toBe(401);
      expect((await send(method, path, TOKENS.shopper, body)).status).toBe(401);
      if (path.includes("/admin/")) expect((await send(method, path, TOKENS.ownerA, body)).status).toBe(401);
    });
  }

  it("POST /v1/ads/click: 401 without a token or with a seller audience token", async () => {
    const body = { click_token: "x".repeat(60), session_id: "session-aaaaaaaaaaaaaaaa" };
    expect((await send("post", "/v1/ads/click", null, body)).status).toBe(401);
    expect((await send("post", "/v1/ads/click", TOKENS.ownerA, body)).status).toBe(401);
  });

  it("admin config: 403 for a non-ads admin role", async () => {
    expect((await send("get", "/v1/admin/ads/config", TOKENS.adminSupport)).status).toBe(403);
  });
});

describe("seller campaigns and tenant isolation", () => {
  let campaignId = "";

  it("owner creates a campaign for their own store; products of another store are refused", async () => {
    const ok = await send("post", "/v1/seller/ads/campaigns", TOKENS.ownerA, campaignBody());
    expect(ok.status).toBe(201);
    expect(ok.body.vat_inclusive).toBe(false);
    campaignId = ok.body.id as string;
    const foreignProduct = await send("post", "/v1/seller/ads/campaigns", TOKENS.ownerA, campaignBody({ bids: [{ product_id: P_B1, bid: money(3) }] }));
    expect(foreignProduct.status).toBe(400);
    expect(JSON.stringify(foreignProduct.body)).toContain("product_not_owned");
  });

  it("seller B creating a campaign for store A is 404, never 403 (no tenancy hint)", async () => {
    expect((await send("post", "/v1/seller/ads/campaigns", TOKENS.ownerB, campaignBody())).status).toBe(404);
    expect((await send("get", `/v1/seller/ads/campaigns?store_id=${STORE_A}`, TOKENS.ownerB)).status).toBe(404);
  });

  it("seller B reading or changing seller A's campaign is 404", async () => {
    expect((await send("get", `/v1/seller/ads/campaigns/${campaignId}`, TOKENS.ownerB)).status).toBe(404);
    expect((await send("patch", `/v1/seller/ads/campaigns/${campaignId}`, TOKENS.ownerB, { name: "Hijack" })).status).toBe(404);
    expect((await send("post", `/v1/seller/ads/campaigns/${campaignId}/pause`, TOKENS.ownerB, {})).status).toBe(404);
    expect((await send("get", `/v1/seller/ads/campaigns/${U(950)}`, TOKENS.ownerB)).status).toBe(404);
  });

  it("support staff of store A can read but not write (missing role is 403)", async () => {
    expect((await send("post", "/v1/seller/ads/campaigns", TOKENS.supportA, campaignBody())).status).toBe(403);
    expect((await send("get", `/v1/seller/ads/campaigns/${campaignId}`, TOKENS.supportA)).status).toBe(200);
    expect((await send("patch", `/v1/seller/ads/campaigns/${campaignId}`, TOKENS.supportA, { name: "Nope" })).status).toBe(403);
  });

  it("mass assignment: unknown and server-owned fields are rejected", async () => {
    expect((await send("post", "/v1/seller/ads/campaigns", TOKENS.ownerA, campaignBody({ status: "ACTIVE", spent: money(1) }))).status).toBe(400);
    expect((await send("patch", `/v1/seller/ads/campaigns/${campaignId}`, TOKENS.ownerA, { status: "ACTIVE" })).status).toBe(400);
  });

  it("requires an Idempotency-Key on writes", async () => {
    h.rt.clock.advance(61_000);
    const r = await h.http().post("/v1/seller/ads/campaigns").set(bearer(TOKENS.ownerA)).send(campaignBody());
    expect(r.status).toBe(400);
  });

  it("pause and resume follow the state machine; resume needs a funded balance", async () => {
    const paused = await send("post", `/v1/seller/ads/campaigns/${campaignId}/pause`, TOKENS.ownerA, {});
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe("PAUSED");
    const noFunds = await send("post", `/v1/seller/ads/campaigns/${campaignId}/resume`, TOKENS.ownerA, {});
    expect(noFunds.status).toBe(409);
    expect(noFunds.body.code).toBe("no_balance");
    const again = await send("post", `/v1/seller/ads/campaigns/${campaignId}/pause`, TOKENS.ownerA, {});
    expect(again.status).toBe(409);
  });
});

describe("top-up, balance and reports", () => {
  it("only an owner may top up (finance can read the balance but not spend)", async () => {
    expect((await send("post", "/v1/seller/ads/topup", TOKENS.financeA, { store_id: STORE_A, amount: money(500) })).status).toBe(403);
    expect((await send("post", "/v1/seller/ads/topup", TOKENS.ownerB, { store_id: STORE_A, amount: money(500) })).status).toBe(404);
    const ok = await send("post", "/v1/seller/ads/topup", TOKENS.ownerA, { store_id: STORE_A, amount: money(500) });
    expect(ok.status).toBe(201);
    expect(ok.body.vat.amount).toBe(String(EGP(70)));
    expect(ok.body.gross.amount).toBe(String(EGP(570)));
    const topUpId = ok.body.top_up_id as string;
    await h.rt.confirm.execute({ topUpId, intentRef: ok.body.payment.intent_ref as string });
    const bal = await send("get", `/v1/seller/ads/balance?store_id=${STORE_A}`, TOKENS.financeA);
    expect(bal.status).toBe(200);
    expect(bal.body.balance.amount).toBe(String(EGP(500)));
    expect((await send("get", `/v1/seller/ads/balance?store_id=${STORE_A}`, TOKENS.ownerB)).status).toBe(404);
  });

  it("reports are scoped to the caller's store and reject foreign campaign ids", async () => {
    const from = iso(h.rt.clock.nowMs() - 86_400_000);
    const to = iso(h.rt.clock.nowMs() + 86_400_000);
    const ok = await send("get", `/v1/seller/ads/reports?store_id=${STORE_A}&from=${from}&to=${to}`, TOKENS.ownerA);
    expect(ok.status).toBe(200);
    expect(ok.body.total.impressions).toBe(0);
    expect((await send("get", `/v1/seller/ads/reports?store_id=${STORE_A}&from=${from}&to=${to}`, TOKENS.ownerB)).status).toBe(404);
    const created = await send("post", "/v1/seller/ads/campaigns", TOKENS.ownerB, campaignBody({ store_id: STORE_B, bids: [{ product_id: P_B1, bid: money(3) }] }));
    const foreign = await send("get", `/v1/seller/ads/reports?store_id=${STORE_A}&campaign_id=${created.body.id as string}&from=${from}&to=${to}`, TOKENS.ownerA);
    expect(foreign.status).toBe(404);
  });
});

describe("click route and admin config", () => {
  it("a bad token is 400; a valid token returns only the product id and bills internally", async () => {
    const bad = await send("post", "/v1/ads/click", TOKENS.shopper, { click_token: "z".repeat(60), session_id: "session-aaaaaaaaaaaaaaaa" });
    expect(bad.status).toBe(400);
    h.rt.eligibility.seed({ productId: P_A2, storeId: STORE_A });
    const created = await send("post", "/v1/seller/ads/campaigns", TOKENS.ownerA, campaignBody({ bids: [{ product_id: P_A2, bid: money(3) }] }));
    expect(created.status).toBe(201);
    const [sel] = await h.rt.select.execute({ ctx: { query: "dress", categoryIds: [], storeScope: null, locale: "ar" }, sessionId: "session-aaaaaaaaaaaaaaaa" });
    if (sel === undefined) throw new Error("no selection");
    h.rt.clock.advance(1_000);
    const r = await send("post", "/v1/ads/click", TOKENS.shopper, { click_token: sel.clickToken, session_id: "session-aaaaaaaaaaaaaaaa" });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(["product_id"]);
  });

  it("marketing admin reads and updates the platform config; invalid ranges are 400", async () => {
    const cur = await send("get", "/v1/admin/ads/config", TOKENS.admin);
    expect(cur.status).toBe(200);
    const next = { ...cur.body, floor_price: money(2), slots: 2 };
    const put = await send("put", "/v1/admin/ads/config", TOKENS.admin, next);
    expect(put.status).toBe(200);
    expect(put.body.floor_price.amount).toBe(String(EGP(2)));
    const bad = await send("put", "/v1/admin/ads/config", TOKENS.admin, { ...next, slots: 9 });
    expect(bad.status).toBe(400);
  });
});

describe("integration with search through its public index", () => {
  const page = { hits: Array.from({ length: 6 }, (_, i) => ({ productId: U(7000 + i), sponsored: false })), total: 6, degraded: false } as const;
  const sel = (productId: string, position: number) => ({
    campaignId: U(1), productId, storeId: STORE_A, position, impressionId: U(2), clickToken: "t", sponsored: true as const,
  });

  it("flags only auction winners that are in the organic page; the search cap stays authoritative", () => {
    const winners = [sel(U(7001), 0), sel(U(7003), 1), sel(U(9999), 2)];
    expect(servableSelections(page, winners).map((s) => s.productId)).toEqual([U(7001), U(7003)]);
    const marked = markSponsored(page, winners);
    expect(marked.hits.filter((x) => x.sponsored).map((x) => x.productId)).toEqual([U(7001), U(7003)]);
    expect(marked.total).toBe(6);
  });
});

describe("architecture and boot", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
    });

  it("no ads source file imports the budget or sizing modules, and search only through its index", () => {
    const root = new URL(".", import.meta.url).pathname;
    for (const f of walk(root).filter((x) => !x.endsWith(".test.ts"))) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/from\s+["'][^"']*modules\/(budget|sizing)[^"']*["']/);
      expect(src, f).not.toMatch(/from\s+["']\.\.\/\.\.\/(budget|sizing)(\/|["'])/);
      const search = [...src.matchAll(/from\s+["'](\.\.[^"']*\/search(?:\/[^"']*)?)["']/g)].map((m) => m[1]);
      for (const s of search) expect(s, f).toMatch(/\/search$/);
    }
  });

  it("boots in test mode and refuses production adapters without a real store or ports", () => {
    expect(() => AdsModule.forRoot(loadConfig({ NODE_ENV: "test" }))).not.toThrow();
    const cfg = { ...loadConfig({ NODE_ENV: "test" }), adapters: "postgres" } as unknown as ReturnType<typeof loadConfig>;
    expect(() => AdsModule.forRoot(cfg)).toThrow(NoProductionAdaptersError);
    expect(() => AdsModule.forRoot(cfg, { store: new InMemoryAdsStore() })).toThrow(MissingAdsPortsError);
  });
});
