/**
 * Contract tests against the REAL API: the Nest AppModule boots in-process (apps/api harness, in-memory
 * adapters), listens on an ephemeral loopback port, and the generated client talks to it over real HTTP.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ATTEST_HEADERS, createHarness, type Harness } from "../../../apps/api/src/test/harness";
import { ApiError, ContractDriftError, createClient, dataOf, schemas, type OutletClient } from "./index";

const PHONE = "+201001234567";
const INSTALL = "0192f3a4-5b6c-4d8e-9f01-23456789abcd";
const MISSING = "0192f3a4-5b6c-7d8e-9f01-23456789ffff";

let h: Harness;
let base = "";
let anon: OutletClient;
let me: OutletClient;
let refreshToken = "";
let accessToken = "";

beforeAll(async () => {
  h = await createHarness();
  await h.app.listen(0, "127.0.0.1");
  const addr = h.app.getHttpServer().address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
  anon = createClient({ baseUrl: base, getHeaders: () => ({ ...ATTEST_HEADERS }) });
  const sent = dataOf(await anon.requestOtp({ body: { phone_e164: PHONE } }));
  const code = h.mailbox.last(PHONE)?.code ?? "";
  const verified = dataOf(await anon.verifyOtp({ body: { challenge_id: sent.challenge_id, code, device: { platform: "ios", install_id: INSTALL } } }));
  refreshToken = verified.refresh_token;
  accessToken = verified.access_token;
  me = createClient({ baseUrl: base, getHeaders: () => ({ ...ATTEST_HEADERS }), getToken: () => verified.access_token });
});
afterAll(async () => {
  await h.close();
});

describe("generated client against the real API: success parses", () => {
  it("auth: requestOtp and verifyOtp returned parsed token pairs", () => {
    expect(refreshToken.length).toBeGreaterThan(10);
  });
  it("getCart", async () => {
    const cart = dataOf(await me.getCart());
    expect(Array.isArray(cart.groups)).toBe(true);
  });
  it("getConsents then updateConsents (idempotent write) round-trips", async () => {
    const before = dataOf(await me.getConsents());
    expect(before).toBeDefined();
    const after = dataOf(await me.updateConsents({ body: { changes: [{ purpose: "analytics", granted: true, policy_version: "1" }] } }));
    expect(after).toBeDefined();
  });
  it("listMyOrders", async () => {
    expect(dataOf(await me.listMyOrders()).items).toEqual([]);
  });
  it("listStores with a required query", async () => {
    const r = dataOf(await me.listStores({ query: { world: "local" } }));
    expect(Array.isArray(r.items)).toBe(true);
  });
  it("search", async () => {
    expect(dataOf(await me.search({ query: { q: "dress" } }))).toBeDefined();
  });
  it("getPlusPaywall", async () => {
    expect(dataOf(await me.getPlusPaywall())).toBeDefined();
  });
  it("createWishlist replays the stored response for a reused Idempotency-Key", async () => {
    const body = { intent: "want" as const, title: "Eid" };
    const key = "0192f3a4-5b6c-7d8e-9f01-23456789abc9";
    const first = await me.createWishlist({ body }, { idempotencyKey: key });
    const second = await me.createWishlist({ body }, { idempotencyKey: key });
    expect(dataOf(second).id).toBe(dataOf(first).id);
    expect(!first.notModified && first.replayed).toBe(false);
    expect(!second.notModified && second.replayed).toBe(true);
    const list = dataOf(await me.listWishlists());
    expect(list.items.filter((w) => w.title === "Eid").length).toBe(1);
  });
  it("listMyGiftCards, getMyRewards, listSessions, getNotificationPreferences, listSavedSearches, listFavoriteStores", async () => {
    expect(dataOf(await me.listMyGiftCards())).toBeDefined();
    expect(dataOf(await me.getMyRewards())).toBeDefined();
    expect(dataOf(await me.listSessions()).items.length).toBeGreaterThanOrEqual(1);
    expect(dataOf(await me.getNotificationPreferences())).toBeDefined();
    expect(dataOf(await me.listSavedSearches())).toBeDefined();
    expect(dataOf(await me.listFavoriteStores())).toBeDefined();
  });
});

describe("generated client against the real API: errors are Problem+JSON", () => {
  it("401 without a token", async () => {
    const err = (await anon.getCart().catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.problemValid).toBe(true);
    expect(schemas.Problem.safeParse(err.problem).success).toBe(true);
  });
  it("404 for an unknown product", async () => {
    const err = (await me.getProduct({ path: { productId: MISSING } }).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.problemValid).toBe(true);
  });
  it("business rule failures (unknown address in a quote, unknown sku in the bag) are Problem+JSON", async () => {
    const q = (await me.quoteCheckout({ body: { address_id: MISSING } }).catch((e: unknown) => e)) as ApiError;
    expect(q).toBeInstanceOf(ApiError);
    expect(q.problemValid).toBe(true);
    expect(q.status).toBeGreaterThanOrEqual(400);
    const l = (await me.addCartLine({ body: { sku_id: MISSING, qty: 1 } }).catch((e: unknown) => e)) as ApiError;
    expect(l).toBeInstanceOf(ApiError);
    expect(l.problemValid).toBe(true);
  });
  it("a server 400 for a body that the client schema would reject parses as Problem+JSON on the wire", async () => {
    const res = await fetch(`${base}/v1/me/privacy/consents`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, ...ATTEST_HEADERS },
      body: JSON.stringify({ changes: [] }),
    });
    expect(res.status).toBe(400);
    expect(schemas.Problem.safeParse(await res.json()).success).toBe(true);
  });
  it("the client refuses to send that invalid body in the first place", async () => {
    const err = await me.updateConsents({ body: { changes: [] } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContractDriftError);
    expect((err as ContractDriftError).phase).toBe("request");
  });
});


/** These four drifted from the spec until the decisions in docs/plan/api-client-gap.md section A; they must now parse. */
describe("formerly drifting operations now match the contract", () => {
  it("getFeed (degraded is a list of reasons)", async () => {
    expect(dataOf(await me.getFeed()).degraded).toEqual([]);
  });
  it("getMyPlus (entitlement groups split commerce benefits from app features)", async () => {
    const plus = dataOf(await me.getMyPlus());
    expect(plus.entitlements.groups).toEqual({ commerce_benefits: [], app_features: [] });
  });
  it("getMyReferral (share_url, rewarded_this_year, yearly_cap)", async () => {
    const r = dataOf(await me.getMyReferral());
    expect(r.share_url).toContain(r.code);
    expect(r).toMatchObject({ rewarded_this_year: 0, yearly_cap: 50, referrals: [] });
  });
  it("getWallet (total, sub_balances, as_of)", async () => {
    const w = dataOf(await me.getWallet());
    expect(w.total).toEqual({ amount: "0", currency: "EGP" });
    expect(w.sub_balances).toEqual([]);
  });
  it("listAddresses is an empty page for a user with none, not a 404", async () => {
    const r = dataOf(await me.listAddresses());
    expect(r.items).toEqual([]);
    expect(r.page.has_more).toBe(false);
  });
  it("getMe parses for a freshly logged-in user", async () => {
    expect(dataOf(await me.getMe()).phone_verified).toBe(true);
  });
  it("getLatestDataExport is a 404 Problem when no export was ever requested", async () => {
    const err = (await me.getLatestDataExport().catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
  });
});
