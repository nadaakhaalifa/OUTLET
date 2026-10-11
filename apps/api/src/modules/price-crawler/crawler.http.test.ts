import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../config/env";
import { MissingCrawlerPortsError, PriceCrawlerModule } from "./index";
import { TOKENS, bearer, createCrawlHarness, type CrawlHarness } from "./test/harness";
import { IDEM, STORE_A, STORE_B, U } from "./test/fixtures";

let h: CrawlHarness;
let seq = 0;
const idem = (): Record<string, string> => ({ "Idempotency-Key": IDEM(++seq) });
const tick = (): void => h.clock.advance(61_000);
beforeEach(async () => {
  h = await createCrawlHarness();
});
afterEach(async () => {
  await h.close();
});

const targetsUrl = (store: string): string => `/v1/seller/stores/${store}/crawl-targets`;
const create = (token: string | null, store = STORE_A, body: unknown = { domain: "my-shop.com", verification_method: "dns_txt", consent_to_monitoring: true }, key = idem()) => {
  tick();
  const r = h.http().post(targetsUrl(store)).set(key);
  return (token === null ? r : r.set(bearer(token))).send(body as object);
};

describe("crawl targets", () => {
  it("owner registers a domain, gets the token once, and can verify it", async () => {
    const r = await create(TOKENS.ownerA);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("pending_verification");
    expect(r.body.verification_token).toMatch(/^zo-verify-[0-9a-f]{32}$/);
    expect(JSON.stringify(r.body)).not.toContain("token_hash");
    const id = r.body.id as string;
    h.verifier.tokens.set("dns_txt:my-shop.com", r.body.verification_token as string);
    tick();
    const v = await h.http().post(`${targetsUrl(STORE_A)}/${id}/verify`).set(idem()).set(bearer(TOKENS.ownerA)).send({});
    expect(v.status).toBe(200);
    expect(v.body.result).toBe("verified");
    tick();
    const list = await h.http().get(targetsUrl(STORE_A)).set(bearer(TOKENS.managerA));
    expect(list.status).toBe(200);
    expect(list.body.items[0]).toMatchObject({ domain: "my-shop.com", status: "verified" });
    expect(JSON.stringify(list.body)).not.toContain("verification_token");
  });
  it("replaying the same Idempotency-Key returns the same answer", async () => {
    const key = idem();
    const a = await create(TOKENS.ownerA, STORE_A, undefined, key);
    const b = await create(TOKENS.ownerA, STORE_A, undefined, key);
    expect(b.status).toBe(a.status);
    expect(b.body.id).toBe(a.body.id);
  });
  it("rejects missing consent, internal domains and a missing key", async () => {
    expect((await create(TOKENS.ownerA, STORE_A, { domain: "my-shop.com", verification_method: "dns_txt", consent_to_monitoring: false })).status).toBe(400);
    expect((await create(TOKENS.ownerA, STORE_A, { domain: "localhost", verification_method: "dns_txt", consent_to_monitoring: true })).status).toBeGreaterThanOrEqual(400);
    expect((await create(TOKENS.ownerA, STORE_A, { domain: "10.0.0.1", verification_method: "file", consent_to_monitoring: true })).status).toBeGreaterThanOrEqual(400);
    tick();
    const noKey = await h.http().post(targetsUrl(STORE_A)).set(bearer(TOKENS.ownerA)).send({ domain: "my-shop.com", verification_method: "file", consent_to_monitoring: true });
    expect(noKey.status).toBe(400);
  });
});

describe("authorization", () => {
  it("another store's owner gets 404 on every store route", async () => {
    expect((await create(TOKENS.ownerB, STORE_A)).status).toBe(404);
    tick();
    expect((await h.http().get(targetsUrl(STORE_A)).set(bearer(TOKENS.ownerB))).status).toBe(404);
    expect((await h.http().get(`/v1/seller/stores/${STORE_A}/channels`).set(bearer(TOKENS.ownerB))).status).toBe(404);
    expect((await h.http().get(`/v1/seller/stores/${STORE_A}/price-matches`).set(bearer(TOKENS.ownerB))).status).toBe(404);
    const own = await create(TOKENS.ownerA);
    tick();
    const v = await h.http().post(`${targetsUrl(STORE_A)}/${own.body.id as string}/verify`).set(idem()).set(bearer(TOKENS.ownerB)).send({});
    expect(v.status).toBe(404);
    tick();
    const ch = await h.http().post(`/v1/seller/stores/${STORE_A}/channels`).set(idem()).set(bearer(TOKENS.ownerB)).send({ kind: "shopify", token_ref: "vault://shop/1", kms_key_ref: "kms://k/1" });
    expect(ch.status).toBe(404);
  });
  it("a verify call through the wrong store path cannot reach another store's target (404)", async () => {
    const own = await create(TOKENS.ownerA);
    tick();
    const v = await h.http().post(`${targetsUrl(STORE_B)}/${own.body.id as string}/verify`).set(idem()).set(bearer(TOKENS.ownerB)).send({});
    expect(v.status).toBe(404);
  });
  it("staff without the settings right get 403; catalog may read matches only", async () => {
    expect((await create(TOKENS.managerA)).status).toBe(403);
    expect((await create(TOKENS.catalogA)).status).toBe(403);
    tick();
    expect((await h.http().get(targetsUrl(STORE_A)).set(bearer(TOKENS.catalogA))).status).toBe(403);
    expect((await h.http().get(`/v1/seller/stores/${STORE_A}/channels`).set(bearer(TOKENS.catalogA))).status).toBe(403);
    expect((await h.http().get(`/v1/seller/stores/${STORE_A}/price-matches`).set(bearer(TOKENS.catalogA))).status).toBe(200);
  });
  it("shoppers, anonymous callers and wrong audiences are refused", async () => {
    expect((await create(TOKENS.shopperOnSellerAud)).status).toBe(403);
    expect((await create(null)).status).toBe(401);
    expect((await create(TOKENS.ownerOnBuyerAud)).status).toBe(401);
    expect((await create(TOKENS.shopper)).status).toBe(401);
    tick();
    expect((await h.http().get(targetsUrl(STORE_A))).status).toBe(401);
  });
  it("the matching config is readable by ops only", async () => {
    tick();
    const ok = await h.http().get("/v1/admin/price-matching/config").set(bearer(TOKENS.opsAdmin));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ tau_bp: 9200, shadow_only: true });
    expect((await h.http().get("/v1/admin/price-matching/config").set(bearer(TOKENS.supportAdmin))).status).toBe(403);
    expect((await h.http().get("/v1/admin/price-matching/config").set(bearer(TOKENS.ownerA))).status).toBe(401);
    expect((await h.http().get("/v1/admin/price-matching/config")).status).toBe(401);
  });
});

describe("channels", () => {
  it("connects an opaque reference and never echoes it back", async () => {
    h.vault.refs.add("vault://shopify/store-a");
    tick();
    const r = await h.http().post(`/v1/seller/stores/${STORE_A}/channels`).set(idem()).set(bearer(TOKENS.ownerA)).send({ kind: "shopify", token_ref: "vault://shopify/store-a", kms_key_ref: "kms://key/1" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: "shopify", status: "active", has_secret: true });
    expect(JSON.stringify(r.body)).not.toContain("vault://");
    tick();
    const bad = await h.http().post(`/v1/seller/stores/${STORE_A}/channels`).set(idem()).set(bearer(TOKENS.ownerA)).send({ kind: "shopify", token_ref: "vault://missing/x", kms_key_ref: "kms://key/1" });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
    tick();
    const list = await h.http().get(`/v1/seller/stores/${STORE_A}/channels`).set(bearer(TOKENS.ownerA));
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain("vault://");
  });
});

describe("module boot", () => {
  it("refuses to boot outside test mode without real ports", () => {
    expect(() => PriceCrawlerModule.forRoot(loadConfig({ NODE_ENV: "development" }))).toThrow(MissingCrawlerPortsError);
    expect(() => PriceCrawlerModule.forRoot(loadConfig({ NODE_ENV: "test" }))).not.toThrow();
  });
});
void U;
