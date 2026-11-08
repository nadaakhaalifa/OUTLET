import { createHash, randomUUID } from "node:crypto";
import type { SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppealService, ChannelConnectionService, ClaimScorer, DAY_MS, MatchingService, SnapshotIngestor, makeWatchEnv } from "../src/index.js";
import type { ExternalItem, FetchResponse, MatchStage } from "../src/index.js";

const T0 = new Date("2026-10-01T09:00:00.000Z");
const MARKET = "EG";
const PUB = "93.184.216.34";
let raw: SqlClient;
let close: () => Promise<void>;
let clock = T0;
let killed = false;
let crawlerKilled = false;
const dnsMap: Record<string, string[]> = {};
const day = (n: number): Date => new Date(T0.getTime() + n * DAY_MS);
const hr = (n: number): Date => new Date(T0.getTime() + n * 3_600_000);

const env = () =>
  makeWatchEnv({ app: roleClient(raw, "outlet_app"), worker: roleClient(raw, "outlet_worker"), marketId: MARKET, now: () => clock, killSwitch: { isKilled: () => Promise.resolve(killed) }, crawlerKilled: () => Promise.resolve(crawlerKilled) });
const q = async <R extends object>(sql: string, p: unknown[] = []): Promise<R[]> => (await raw.query<R>(sql, p)).rows;

const seedStore = async (): Promise<{ storeId: string; userId: string }> => {
  const sellerId = randomUUID();
  const storeId = randomUUID();
  await raw.query("INSERT INTO sellers (id, home_market_id, market_id, legal_type) VALUES ($1, 'EG', 'EG', 'company')", [sellerId]);
  await raw.query("INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, kind, ships_from_country) VALUES ($1, $2, 'EG', $3, 'متجر', 'local', 'EG')", [storeId, sellerId, `s-${storeId.slice(0, 8)}`]);
  dnsMap[`${storeId.slice(0, 8)}.example.com`] = [PUB];
  return { storeId, userId: randomUUID() };
};
/** Internal history: 100 held from day -60, cut to 80 at day -10 (reference 100, 20% off). */
const seedSku = async (storeId: string, cut = 80): Promise<string> => {
  const sku = randomUUID();
  await raw.query("INSERT INTO price_events (id, sku_id, store_ref, market_id, currency, price_minor, valid_from, valid_to, source) VALUES ($1,$2,$3,'EG','EGP',100,$4,$5,'internal')", [randomUUID(), sku, storeId, day(-60), day(-10)]);
  await raw.query("INSERT INTO price_events (id, sku_id, store_ref, market_id, currency, price_minor, valid_from, valid_to, source) VALUES ($1,$2,$3,'EG','EGP',$5,$4,NULL,'internal')", [randomUUID(), sku, storeId, day(-10), cut]);
  return sku;
};
const seedConn = async (storeId: string, status = "active", type = "shopify", prefix = ""): Promise<{ id: string; domain: string }> => {
  const id = randomUUID();
  const domain = `${prefix}${storeId.slice(0, 8)}.example.com`;
  dnsMap[domain] = [PUB];
  await raw.query(
    "INSERT INTO channel_connections (id, store_id, market_id, type, domain, base_url, verify_method, status, verified_at, next_check_at) VALUES ($1,$2,'EG',$3,$4,$5,'oauth',$6,$7,$7)",
    [id, storeId, type, domain, `https://${domain}/products.json`, status, status === "pending" ? null : T0],
  );
  return { id, domain };
};
const seedProduct = async (storeId: string, connId: string): Promise<string> => {
  const id = randomUUID();
  await raw.query("INSERT INTO external_products (id, connection_id, store_id, market_id, external_ref) VALUES ($1,$2,$3,'EG',$4)", [id, connId, storeId, randomUUID()]);
  return id;
};
const snap = (storeId: string, connId: string, pid: string, price: number, at: Date) =>
  raw.query("INSERT INTO channel_snapshots (id, fetched_at, connection_id, external_product_id, store_id, market_id, price_minor, currency, in_stock, method) VALUES ($1,$2,$3,$4,$5,'EG',$6,'EGP',true,'api')", [randomUUID(), at, connId, pid, storeId, price]);
const insertMatch = async (storeId: string, sku: string, pid: string, status = "auto", conf = 9500): Promise<string> => {
  const id = randomUUID();
  await raw.query("INSERT INTO product_matches (id, sku_id, store_id, market_id, external_product_id, method, confidence_bp, model_version, status) VALUES ($1,$2,$3,'EG',$4,'gtin',$5,'v1',$6)", [id, sku, storeId, pid, conf, status]);
  return id;
};

beforeAll(async () => {
  ({ client: raw, close } = await createTestClient());
});
afterAll(async () => {
  await close();
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
describe("ChannelConnectionService", () => {
  const ports = (observed: string[] = [], tokenRef = "kms:key/1", scopes = ["read_products"]) => ({
    dns: { resolve: (h: string) => Promise.resolve(dnsMap[h] ?? []) },
    verifier: { observe: () => Promise.resolve(observed) },
    oauth: { authorizeUrl: () => "u", exchange: () => Promise.resolve({ tokenRef, scopes }), revoke: () => Promise.resolve() },
  });
  it("refuses bad, private and unresolvable domains", async () => {
    const { storeId, userId } = await seedStore();
    const svc = new ChannelConnectionService(env(), ports());
    const base = { storeId, userId, type: "feed" as const, consentAcceptanceId: randomUUID() };
    for (const d of ["localhost", "127.0.0.1", "foo.internal", "no-dot", "a b.com"]) await expect(svc.connect({ ...base, domain: d }), d).rejects.toMatchObject({ code: "invalid" });
    dnsMap["private.example.com"] = ["10.0.0.9"];
    await expect(svc.connect({ ...base, domain: "private.example.com" })).rejects.toMatchObject({ code: "unsafe_target" });
    await expect(svc.connect({ ...base, domain: "ghost.example.com" })).rejects.toMatchObject({ code: "unsafe_target" });
  });
  it("connects PENDING, verifies by DNS proof, is idempotent, and never activates an unverified domain", async () => {
    const { storeId, userId } = await seedStore();
    const domain = `${storeId.slice(0, 8)}.example.com`;
    const svc0 = new ChannelConnectionService(env(), ports());
    const c = await svc0.connect({ storeId, userId, type: "feed", domain, consentAcceptanceId: randomUUID() });
    expect(c.status).toBe("pending");
    expect(c.verificationToken).toMatch(/^outletnk-verify=/);
    const again = await svc0.connect({ storeId, userId, type: "feed", domain, consentAcceptanceId: randomUUID() });
    expect(again.id).toBe(c.id);
    expect(again.verificationToken).toBeUndefined();
    const stored = await q<{ verify_token_hash: Uint8Array }>("SELECT verify_token_hash FROM channel_connections WHERE id = $1", [c.id]);
    expect(Buffer.from(stored[0]?.verify_token_hash ?? []).toString("hex")).toBe(sha(c.verificationToken ?? ""));
    await expect(new ChannelConnectionService(env(), ports(["wrong"])).verify(storeId, userId, c.id)).rejects.toMatchObject({ code: "unverified" });
    expect((await q("SELECT 1 FROM outbox_events WHERE event_type = 'channel.verification_failed' AND aggregate_id = $1", [c.id])).length).toBe(1);
    expect((await q<{ status: string }>("SELECT status FROM channel_connections WHERE id = $1", [c.id]))[0]?.status).toBe("pending");
    const ok = await new ChannelConnectionService(env(), ports([`  ${c.verificationToken ?? ""} `])).verify(storeId, userId, c.id);
    expect(ok.status).toBe("active");
    expect((await q("SELECT 1 FROM outbox_events WHERE event_type = 'channel.connected' AND aggregate_id = $1", [c.id])).length).toBe(1);
    expect((await svc0.list(storeId, userId)).map((x) => x.status)).toEqual(["active"]);
    await svc0.disconnect(storeId, userId, c.id);
    expect((await svc0.list(storeId, userId))[0]?.status).toBe("disconnected");
  });
  it("OAuth: read-only scopes and KMS references only; token never stored", async () => {
    const { storeId, userId } = await seedStore();
    const domain = `${storeId.slice(0, 8)}.example.com`;
    const c = await new ChannelConnectionService(env(), ports()).connect({ storeId, userId, type: "shopify", domain, consentAcceptanceId: randomUUID() });
    expect(c.verificationToken).toBeUndefined();
    await expect(new ChannelConnectionService(env(), ports()).verify(storeId, userId, c.id)).rejects.toMatchObject({ code: "invalid" });
    await expect(new ChannelConnectionService(env(), ports([], "shpat_secret")).completeOAuth(storeId, userId, c.id, "code")).rejects.toMatchObject({ code: "invalid" });
    await expect(new ChannelConnectionService(env(), ports([], "kms:k", ["read_products", "write_products"])).completeOAuth(storeId, userId, c.id, "code")).rejects.toMatchObject({ code: "forbidden" });
    const ok = await new ChannelConnectionService(env(), ports([], "kms:k/2", ["read_products", "products/update"])).completeOAuth(storeId, userId, c.id, "code");
    expect(ok.status).toBe("active");
    const row = (await q<{ oauth_token_ref: string; scopes: string[] }>("SELECT oauth_token_ref, scopes FROM channel_connections WHERE id = $1", [c.id]))[0];
    expect(row).toEqual({ oauth_token_ref: "kms:k/2", scopes: ["read_products", "products/update"] });
    await expect(raw.query("UPDATE channel_connections SET oauth_token_ref = 'raw-token' WHERE id = $1", [c.id])).rejects.toThrow();
    const feed = await new ChannelConnectionService(env(), ports()).connect({ storeId, userId, type: "feed", domain: `x.${domain}`, consentAcceptanceId: randomUUID() }).catch(() => null);
    expect(feed).toBeNull(); // x.<domain> is not in dns map
  });
  it("OAuth is refused for non-OAuth channel types", async () => {
    const { storeId, userId } = await seedStore();
    const c = await seedConn(storeId, "pending", "feed");
    await expect(new ChannelConnectionService(env(), ports()).completeOAuth(storeId, userId, c.id, "c")).rejects.toMatchObject({ code: "invalid" });
  });
  it("tenant negatives: another store sees nothing and cannot verify, complete or disconnect", async () => {
    const a = await seedStore();
    const b = await seedStore();
    const c = await seedConn(a.storeId, "pending");
    const svcB = new ChannelConnectionService(env(), ports(["x"]));
    expect(await svcB.list(b.storeId, b.userId)).toEqual([]);
    await expect(svcB.verify(b.storeId, b.userId, c.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(svcB.completeOAuth(b.storeId, b.userId, c.id, "c")).rejects.toMatchObject({ code: "not_found" });
    await expect(svcB.disconnect(b.storeId, b.userId, c.id)).rejects.toMatchObject({ code: "not_found" });
    const app = roleClient(raw, "outlet_app");
    const { withDbContext } = await import("@outlet/db");
    const seen = await withDbContext(app, { kind: "store", marketId: MARKET, storeId: b.storeId }, (tx) => tx.query("SELECT id FROM channel_connections"));
    expect(seen.rows).toEqual([]);
    await expect(withDbContext(app, { kind: "store", marketId: MARKET, storeId: b.storeId }, (tx) =>
      tx.query("INSERT INTO channel_connections (id, store_id, market_id, type, domain, base_url, verify_method) VALUES ($1,$2,'EG','feed','z.example.com','https://z.example.com/','file')", [randomUUID(), a.storeId]))).rejects.toThrow();
  });
});

describe("SnapshotIngestor", () => {
  const item = (o: Partial<ExternalItem> = {}): ExternalItem => ({ externalRef: "p1", priceMinor: 90n, currency: "EGP", inStock: true, ...o });
  const deps = (responses: (FetchResponse | Error)[], robots = true) => {
    const sleeps: number[] = [];
    const calls: { etag?: string | undefined; address: string }[] = [];
    return {
      sleeps, calls,
      d: {
        fetch: { fetch: (r: { etag?: string; address: string }) => { calls.push({ etag: r.etag, address: r.address }); const x = responses.shift() ?? { status: 200, items: [] }; return x instanceof Error ? Promise.reject(x) : Promise.resolve(x); } },
        dns: { resolve: (h: string) => Promise.resolve(dnsMap[h] ?? []) },
        robots: { allowed: () => Promise.resolve(robots) },
        sleep: (ms: number) => { sleeps.push(ms); return Promise.resolve(); },
        random: () => 0,
      },
    };
  };
  it("ingests, dedupes unchanged prices, honours ETag and writes a daily snapshot", async () => {
    clock = T0;
    const { storeId } = await seedStore();
    const c = await seedConn(storeId);
    await raw.query("UPDATE channel_connections SET next_check_at = '2100-01-01' WHERE id <> $1", [c.id]);
    const r = deps([{ status: 200, etag: "e1", items: [item(), item({ externalRef: "bad", priceMinor: 0n })] }, { status: 304, items: [] }, { status: 200, etag: "e1", items: [item()] }, { status: 200, items: [item({ priceMinor: 85n })] }]);
    const ing = new SnapshotIngestor(env(), r.d);
    expect(await ing.runDue()).toMatchObject({ synced: 1 });
    expect((await q("SELECT 1 FROM channel_snapshots WHERE connection_id = $1", [c.id])).length).toBe(1);
    expect((await q<{ next_check_at: Date }>("SELECT next_check_at FROM channel_connections WHERE id = $1", [c.id]))[0]?.next_check_at.getTime()).toBe(T0.getTime() + 3 * 3_600_000);
    clock = hr(3);
    expect(await ing.runDue()).toMatchObject({ not_modified: 1 });
    expect(r.calls[1]?.etag).toBe("e1");
    clock = hr(6);
    expect(await ing.runDue()).toMatchObject({ synced: 1 });
    expect((await q("SELECT 1 FROM channel_snapshots WHERE connection_id = $1", [c.id])).length).toBe(1); // unchanged within a day: no new row
    clock = hr(9);
    await ing.runDue();
    expect((await q("SELECT 1 FROM channel_snapshots WHERE connection_id = $1", [c.id])).length).toBe(2); // price changed
    clock = day(2);
    await raw.query("UPDATE channel_connections SET next_check_at = $2 WHERE id = $1", [c.id, day(1)]);
    await ing.runDue();
    expect((await q("SELECT 1 FROM channel_snapshots WHERE connection_id = $1", [c.id])).length).toBeGreaterThanOrEqual(2);
    expect((await q("SELECT 1 FROM outbox_events WHERE event_type = 'channel_snapshot.ingested' AND aggregate_id = $1", [c.id])).length).toBeGreaterThanOrEqual(2);
  });
  it("paces a domain to 1 request / 5 s, retries with backoff and marks failures without changing evidence", async () => {
    clock = T0;
    const { storeId } = await seedStore();
    const c = await seedConn(storeId, "active", "feed");
    const r = deps([new Error("boom"), { status: 503, items: [] }, new Error("boom3")]);
    const ing = new SnapshotIngestor(env(), r.d);
    expect(await ing.syncOne({ id: c.id, store_id: storeId, type: "feed", domain: c.domain, base_url: `https://${c.domain}/f.json`, risk_tier: "watched" })).toBe("failed");
    expect(r.sleeps).toEqual([1000, 2000]);
    expect((await q<{ next_check_at: Date }>("SELECT next_check_at FROM channel_connections WHERE id = $1", [c.id]))[0]?.next_check_at.getTime()).toBe(T0.getTime() + 3_600_000);
    const r2 = deps([{ status: 200, items: [] }, { status: 200, items: [] }]);
    const ing2 = new SnapshotIngestor(env(), r2.d);
    const due = { id: c.id, store_id: storeId, type: "feed", domain: c.domain, base_url: `https://${c.domain}/f.json`, risk_tier: "trusted" as const };
    await ing2.syncOne(due);
    await ing2.syncOne(due);
    expect(r2.sleeps).toEqual([5000]);
    const r3 = deps([{ status: 404, items: [] }]);
    expect(await new SnapshotIngestor(env(), r3.d).syncOne(due)).toBe("failed");
  });
  it("skips robots-disallowed and crawler-killed websites; an unsafe or private domain fails closed", async () => {
    clock = T0;
    const { storeId } = await seedStore();
    const c = await seedConn(storeId, "active", "website");
    const due = { id: c.id, store_id: storeId, type: "website", domain: c.domain, base_url: `https://${c.domain}/`, risk_tier: "normal" as const };
    const r = deps([{ status: 200, items: [item()] }], false);
    expect(await new SnapshotIngestor(env(), r.d).syncOne(due)).toBe("skipped");
    expect(r.calls.length).toBe(0);
    crawlerKilled = true;
    expect(await new SnapshotIngestor(env(), deps([], true).d).syncOne(due)).toBe("skipped");
    crawlerKilled = false;
    expect(await new SnapshotIngestor(env(), deps([{ status: 200, items: [item()] }]).d).syncOne(due)).toBe("synced");
    expect((await q<{ method: string }>("SELECT method FROM channel_snapshots WHERE connection_id = $1", [c.id]))[0]?.method).toBe("crawler");
    dnsMap[c.domain] = ["192.168.0.4"];
    expect(await new SnapshotIngestor(env(), deps([{ status: 200, items: [] }]).d).syncOne(due)).toBe("unsafe");
    expect((await q<{ status: string }>("SELECT status FROM channel_connections WHERE id = $1", [c.id]))[0]?.status).toBe("failed");
    dnsMap[c.domain] = [PUB];
  });
  it("runDue returns zeros when nothing is due", async () => {
    clock = day(-300);
    expect(await new SnapshotIngestor(env(), deps([]).d).runDue()).toEqual({ synced: 0, not_modified: 0, failed: 0, skipped: 0, unsafe: 0 });
    clock = T0;
  });
});

describe("MatchingService", () => {
  const stage = (method: MatchStage["method"], sku: string | null, conf: number, throws = false): MatchStage => ({
    method, modelVersion: "m1", find: () => (throws ? Promise.reject(new Error("x")) : Promise.resolve(sku === null ? null : { skuId: sku, confidenceBp: conf })),
  });
  it("waterfall: first stage at or above tau wins; sub-tau needs confirmation; failing stages give nothing", async () => {
    const { storeId, userId } = await seedStore();
    const c = await seedConn(storeId);
    const sku = randomUUID();
    const [p1, p2, p3, p4] = [await seedProduct(storeId, c.id), await seedProduct(storeId, c.id), await seedProduct(storeId, c.id), await seedProduct(storeId, c.id)];
    expect(await new MatchingService(env(), [stage("gtin", null, 0), stage("phash", sku, 9300), stage("embedding", sku, 9900)]).matchProduct(p1)).toBe("auto");
    expect((await q<{ method: string; status: string }>("SELECT method, status FROM product_matches WHERE external_product_id = $1", [p1]))[0]).toEqual({ method: "phash", status: "auto" });
    expect(await new MatchingService(env(), [stage("phash", sku, 8000), stage("embedding", sku, 9100), stage("llm", sku, 7000)]).matchProduct(p2)).toBe("needs_confirmation");
    expect((await q<{ confidence_bp: number }>("SELECT confidence_bp FROM product_matches WHERE external_product_id = $1", [p2]))[0]?.confidence_bp).toBe(9100);
    expect(await new MatchingService(env(), [stage("gtin", sku, 10000, true), stage("llm", null, 0)]).matchProduct(p3)).toBe("none");
    expect(await new MatchingService(env(), []).matchProduct(p4)).toBe("none");
    // an uncertain match upgrades to auto on a better run; an auto or seller-decided match is never overwritten
    expect(await new MatchingService(env(), [stage("gtin", sku, 10000)]).matchProduct(p2)).toBe("auto");
    expect(await new MatchingService(env(), [stage("gtin", sku, 9999)]).matchProduct(p2)).toBe("kept");
    await expect(new MatchingService(env(), []).matchProduct(randomUUID())).rejects.toMatchObject({ code: "not_found" });
    // seller one-tap confirm and the reject guard
    const p5 = await seedProduct(storeId, c.id);
    await new MatchingService(env(), [stage("embedding", sku, 8000)]).matchProduct(p5);
    const m5 = (await q<{ id: string }>("SELECT id FROM product_matches WHERE external_product_id = $1", [p5]))[0]?.id ?? "";
    const svc = new MatchingService(env(), []);
    await svc.confirm(storeId, userId, m5);
    expect((await q<{ status: string }>("SELECT status FROM product_matches WHERE id = $1", [m5]))[0]?.status).toBe("seller_confirmed");
    await expect(svc.confirm(storeId, userId, m5)).rejects.toMatchObject({ code: "forbidden" });
    const autoId = (await q<{ id: string }>("SELECT id FROM product_matches WHERE external_product_id = $1", [p1]))[0]?.id ?? "";
    await expect(svc.reject(storeId, userId, autoId)).rejects.toMatchObject({ code: "forbidden" });
    const p6 = await seedProduct(storeId, c.id);
    await new MatchingService(env(), [stage("embedding", sku, 8000)]).matchProduct(p6);
    const m6 = (await q<{ id: string }>("SELECT id FROM product_matches WHERE external_product_id = $1", [p6]))[0]?.id ?? "";
    await svc.reject(storeId, userId, m6);
    expect((await q<{ status: string }>("SELECT status FROM product_matches WHERE id = $1", [m6]))[0]?.status).toBe("rejected");
    const other = await seedStore();
    await expect(svc.confirm(other.storeId, other.userId, m5)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("ClaimScorer", () => {
  const scorer = () => new ClaimScorer(env());
  const events = async (type: string) => q<{ payload: Record<string, unknown> }>("SELECT payload FROM outbox_events WHERE event_type = $1", [type]);
  it("internal only: verified discount, idempotent re-score; kill switch and no history fail closed", async () => {
    clock = T0;
    const { storeId } = await seedStore();
    const sku = await seedSku(storeId);
    const before = (await events("price_claim.scored")).length;
    const r = await scorer().scoreSku({ storeId, skuId: sku });
    expect(r).toMatchObject({ status: "scored", displayAllowed: true, vrpMinor: 100n, claimChanged: true, reason: "unmatched" });
    expect((await events("price_claim.scored")).length).toBe(before + 1);
    expect(await scorer().scoreSku({ storeId, skuId: sku })).toMatchObject({ claimChanged: false });
    expect((await events("price_claim.scored")).length).toBe(before + 1);
    expect((await q("SELECT 1 FROM price_claims WHERE sku_id = $1", [sku])).length).toBe(1);
    killed = true;
    expect(await scorer().scoreSku({ storeId, skuId: sku })).toMatchObject({ status: "killed", displayAllowed: false });
    killed = false;
    expect(await scorer().scoreSku({ storeId, skuId: randomUUID() })).toMatchObject({ status: "no_history" });
  });
  it("external evidence lowers the VRP, never raises it; a confirmed or sub-tau match behaves as specified", async () => {
    clock = T0;
    const { storeId } = await seedStore();
    const c = await seedConn(storeId);
    const sku = await seedSku(storeId);
    const pid = await seedProduct(storeId, c.id);
    await snap(storeId, c.id, pid, 90, day(-45));
    await snap(storeId, c.id, pid, 90, hr(-2));
    await insertMatch(storeId, sku, pid);
    expect(await scorer().scoreSku({ storeId, skuId: sku })).toMatchObject({ vrpMinor: 90n, displayAllowed: true, reason: "external_lower" });
    expect((await q<{ reference_class: string; discount_bp: number }>("SELECT reference_class, discount_bp FROM price_claims WHERE sku_id = $1 AND status = 'active'", [sku]))[0]).toEqual({ reference_class: "external", discount_bp: 1100 });
    crawlerKilled = true;
    expect(await scorer().scoreSku({ storeId, skuId: sku })).toMatchObject({ vrpMinor: 100n, reason: "unmatched" });
    crawlerKilled = false;
    await snap(storeId, c.id, pid, 200, hr(-1)); // a higher external price afterwards cannot raise the VRP above internal
    const r = await scorer().scoreSku({ storeId, skuId: sku });
    expect(r.vrpMinor !== null && r.vrpMinor <= 100n).toBe(true);
    // two matches: the strictest wins
    const pid2 = await seedProduct(storeId, c.id);
    await snap(storeId, c.id, pid2, 85, day(-45));
    await snap(storeId, c.id, pid2, 85, hr(-1));
    await insertMatch(storeId, sku, pid2, "seller_confirmed", 3000);
    expect((await scorer().scoreSku({ storeId, skuId: sku })).vrpMinor).toBe(85n);
    // a sub-tau (needs_confirmation) match is not evidence
    const sku2 = await seedSku(storeId);
    const pid3 = await seedProduct(storeId, c.id);
    await snap(storeId, c.id, pid3, 50, day(-45));
    await snap(storeId, c.id, pid3, 50, hr(-1));
    await insertMatch(storeId, sku2, pid3, "needs_confirmation", 5000);
    expect((await scorer().scoreSku({ storeId, skuId: sku2 })).vrpMinor).toBe(100n);
  });
  it("stale evidence (72 h) degrades the claim to the plain price", async () => {
    clock = T0;
    const { storeId } = await seedStore();
    const c = await seedConn(storeId);
    const sku = await seedSku(storeId);
    const pid = await seedProduct(storeId, c.id);
    await snap(storeId, c.id, pid, 90, day(-45));
    await snap(storeId, c.id, pid, 90, hr(-71));
    await insertMatch(storeId, sku, pid);
    expect(await scorer().scoreSku({ storeId, skuId: sku })).toMatchObject({ displayAllowed: true });
    clock = hr(2); // last fetch is now 73 h old
    const r = await scorer().scoreSku({ storeId, skuId: sku });
    expect(r).toMatchObject({ displayAllowed: false, vrpMinor: null, reason: "stale_external" });
    expect((await q<{ claim_type: string }>("SELECT claim_type FROM price_claims WHERE sku_id = $1 AND status = 'active'", [sku]))[0]?.claim_type).not.toBe("verified_discount");
    clock = T0;
  });
  it("parity: external cheaper demotes, pauses after 48 h, resolves when fixed", async () => {
    clock = T0;
    const { storeId } = await seedStore();
    const c = await seedConn(storeId);
    const sku = await seedSku(storeId);
    const pid = await seedProduct(storeId, c.id);
    await snap(storeId, c.id, pid, 70, day(-45));
    await snap(storeId, c.id, pid, 70, hr(-1));
    await insertMatch(storeId, sku, pid);
    const r1 = await scorer().scoreSku({ storeId, skuId: sku });
    expect(r1).toMatchObject({ findings: ["parity_breach"], actions: ["demote"], displayAllowed: false });
    expect(await scorer().scoreSku({ storeId, skuId: sku })).toMatchObject({ findings: [], actions: [] });
    await snap(storeId, c.id, pid, 70, hr(47));
    clock = hr(48);
    const r2 = await scorer().scoreSku({ storeId, skuId: sku });
    expect(r2.actions).toEqual(["pause_sku"]);
    expect((await events("price_enforcement.applied")).some((e) => e.payload.action === "pause_sku")).toBe(true);
    await snap(storeId, c.id, pid, 95, hr(49));
    clock = hr(50);
    await scorer().scoreSku({ storeId, skuId: sku });
    expect((await q<{ status: string }>("SELECT status FROM price_findings WHERE store_id = $1 AND rule = 'parity_breach'", [storeId]))[0]?.status).toBe("resolved");
    expect((await q<{ status: string }>("SELECT status FROM enforcement_actions WHERE store_id = $1 AND action = 'demote'", [storeId]))[0]?.status).toBe("lifted");
    clock = T0;
  });
  it("fake reference corrected, ladder sanctions at 3 violations and suspends with human review at 6; resolves when the claim is dropped", async () => {
    clock = T0;
    const { storeId } = await seedStore();
    const skus: string[] = [];
    for (let i = 0; i < 6; i++) skus.push(await seedSku(storeId));
    const out = [];
    for (const s of skus) out.push(await scorer().scoreSku({ storeId, skuId: s, claimedReferenceMinor: 360n }));
    expect(out[0]).toMatchObject({ findings: ["fake_reference"], actions: ["autocorrect_display"], displayAllowed: true, vrpMinor: 100n });
    expect(out[1]?.actions).toEqual(["autocorrect_display"]);
    expect(out[2]?.actions).toEqual(["autocorrect_display", "lose_verified", "commission_surcharge", "block_drops"]);
    expect(out[2]?.displayAllowed).toBe(false);
    expect(out[5]?.actions).toContain("suspend_store");
    const susp = (await q<{ status: string; human_review_required: boolean }>("SELECT status, human_review_required FROM enforcement_actions WHERE store_id = $1 AND action = 'suspend_store'", [storeId]))[0];
    expect(susp).toEqual({ status: "pending_review", human_review_required: true });
    const ev = (await events("price_enforcement.applied")).find((e) => e.payload.action === "suspend_store");
    expect(ev?.payload.review_due_by).toBe("2026-10-08T09:00:00.000Z"); // Thu 1 Oct + 5 business days (Fri/Sat off)
    expect(out[5]?.trustScore).toBeLessThan(out[0]?.trustScore ?? 0);
    const none = await scorer().scoreSku({ storeId, skuId: skus[0] ?? "" });
    expect((await q<{ status: string }>("SELECT status FROM price_findings WHERE sku_id = $1", [skus[0]]))[0]?.status).toBe("resolved");
    expect(none.displayAllowed).toBe(false); // store-level sanctions (lose_verified) still hide the badge
  });
  it("a claimed reference with no verified evidence is a fake reference; an honest equal claim is not", async () => {
    clock = T0;
    const { storeId } = await seedStore();
    const sku = await seedSku(storeId);
    expect((await scorer().scoreSku({ storeId, skuId: sku, claimedReferenceMinor: 100n })).findings).toEqual([]);
    const launch = randomUUID();
    await raw.query("INSERT INTO price_events (id, sku_id, store_ref, market_id, currency, price_minor, valid_from, source) VALUES ($1,$2,$3,'EG','EGP',80,$4,'internal')", [randomUUID(), launch, storeId, day(-3)]);
    const r = await scorer().scoreSku({ storeId, skuId: launch, claimedReferenceMinor: 360n });
    expect(r).toMatchObject({ findings: ["fake_reference"], displayAllowed: false });
    expect((await q<{ claim_type: string }>("SELECT claim_type FROM price_claims WHERE sku_id = $1", [launch]))[0]?.claim_type).toBe("launch_price");
  });
  it("disconnecting the channel removes every % off for the store until reconnected", async () => {
    clock = T0;
    const { storeId } = await seedStore();
    const c = await seedConn(storeId, "disconnected");
    const sku = await seedSku(storeId);
    expect(await scorer().scoreSku({ storeId, skuId: sku })).toMatchObject({ displayAllowed: false, reason: "channel_disconnected", findings: ["channel_disconnected"], actions: ["remove_all_pct"] });
    await raw.query("UPDATE channel_connections SET status = 'active' WHERE id = $1", [c.id]);
    expect((await scorer().scoreSku({ storeId, skuId: sku })).displayAllowed).toBe(true);
    expect((await q<{ status: string }>("SELECT status FROM enforcement_actions WHERE store_id = $1 AND action = 'remove_all_pct'", [storeId]))[0]?.status).toBe("lifted");
  });
  it("anomalies (ping-pong, sudden pre-event discount) are recorded as info findings without enforcement", async () => {
    clock = T0;
    const { storeId } = await seedStore();
    const sku = randomUUID();
    const prices = [100, 150, 100, 150, 100];
    for (const [i, p] of prices.entries()) await raw.query("INSERT INTO price_events (id, sku_id, store_ref, market_id, currency, price_minor, valid_from, valid_to, source) VALUES ($1,$2,$3,'EG','EGP',$4,$5,$6,'internal')", [randomUUID(), sku, storeId, p, hr(-24 * (5 - i)), i === prices.length - 1 ? null : hr(-24 * (4 - i))]);
    const r = await scorer().scoreSku({ storeId, skuId: sku, megaEvents: [{ startsAt: day(2) }], sellThroughPct: 5 });
    expect(r.findings).toContain("ping_pong");
    expect(r.actions.every((a) => a !== "demote")).toBe(true);
  });
  it("enforcement_actions is append-only, even for the worker", async () => {
    const { storeId } = await seedStore();
    const sku = await seedSku(storeId);
    await scorer().scoreSku({ storeId, skuId: sku, claimedReferenceMinor: 360n });
    await expect(raw.query("UPDATE enforcement_actions SET action = 'pause_sku' WHERE store_id = $1", [storeId])).rejects.toThrow(/append-only/);
    await expect(raw.query("DELETE FROM enforcement_actions WHERE store_id = $1", [storeId])).rejects.toThrow(/append-only/);
    await expect(raw.query("TRUNCATE enforcement_actions")).rejects.toThrow(/append-only/);
    await raw.query("UPDATE enforcement_actions SET status = 'lifted' WHERE store_id = $1", [storeId]);
  });
});

describe("AppealService", () => {
  const mk = () => { const e = env(); return new AppealService(e, new ClaimScorer(e)); };
  it("validates, is idempotent, isolates tenants and routes suspensions and bare documents to Ops", async () => {
    clock = T0;
    const a = await seedStore();
    const b = await seedStore();
    const sku = await seedSku(a.storeId);
    await new ClaimScorer(env()).scoreSku({ storeId: a.storeId, skuId: sku, claimedReferenceMinor: 360n });
    const f = (await q<{ id: string }>("SELECT id FROM price_findings WHERE store_id = $1", [a.storeId]))[0]?.id ?? "";
    const conn = await seedConn(a.storeId);
    const key = randomUUID();
    const svc = mk();
    await expect(svc.submit({ storeId: a.storeId, userId: a.userId, findingId: f, idempotencyKey: key })).rejects.toMatchObject({ code: "invalid" });
    await expect(svc.submit({ storeId: b.storeId, userId: b.userId, findingId: f, idempotencyKey: randomUUID(), evidenceMediaId: randomUUID() })).rejects.toMatchObject({ code: "not_found" });
    const pending = await seedConn(a.storeId, "pending", "feed", "p.");
    await expect(svc.submit({ storeId: a.storeId, userId: a.userId, findingId: f, idempotencyKey: randomUUID(), connectionId: pending.id })).rejects.toMatchObject({ code: "unverified" });
    const r1 = await svc.submit({ storeId: a.storeId, userId: a.userId, findingId: f, idempotencyKey: key, connectionId: conn.id, claimedReferenceMinor: 100n });
    expect(r1.status).toBe("pending_rescore");
    expect(await svc.submit({ storeId: a.storeId, userId: a.userId, findingId: f, idempotencyKey: key, connectionId: conn.id })).toEqual(r1);
    expect((await svc.submit({ storeId: a.storeId, userId: a.userId, findingId: f, idempotencyKey: randomUUID(), evidenceMediaId: randomUUID() })).status).toBe("ops_queue");
    expect(await svc.processPending()).toEqual({ upheld: 1, rejected: 0 }); // claimed reference now equals the verified one
    expect((await q<{ status: string }>("SELECT status FROM price_findings WHERE id = $1", [f]))[0]?.status).toBe("upheld");
    expect((await events("price_appeal.resolved")).length).toBeGreaterThan(0);
    // a finding with a pending human review goes to the Ops queue
    const c = await seedStore();
    const skus: string[] = [];
    for (let i = 0; i < 6; i++) skus.push(await seedSku(c.storeId));
    for (const s of skus) await new ClaimScorer(env()).scoreSku({ storeId: c.storeId, skuId: s, claimedReferenceMinor: 360n });
    const cf = (await q<{ finding_id: string }>("SELECT finding_id FROM enforcement_actions WHERE store_id = $1 AND action = 'suspend_store'", [c.storeId]))[0]?.finding_id ?? "";
    const cc = await seedConn(c.storeId);
    expect((await svc.submit({ storeId: c.storeId, userId: c.userId, findingId: cf, idempotencyKey: randomUUID(), connectionId: cc.id })).status).toBe("ops_queue");
  });
  it("rejects an appeal whose evidence still shows the breach and upholds once the seller fixed it", async () => {
    clock = T0;
    const a = await seedStore();
    const c = await seedConn(a.storeId);
    const sku = await seedSku(a.storeId);
    const pid = await seedProduct(a.storeId, c.id);
    await snap(a.storeId, c.id, pid, 70, day(-45));
    await snap(a.storeId, c.id, pid, 70, hr(-1));
    await insertMatch(a.storeId, sku, pid);
    await new ClaimScorer(env()).scoreSku({ storeId: a.storeId, skuId: sku });
    const f = (await q<{ id: string }>("SELECT id FROM price_findings WHERE store_id = $1 AND rule = 'parity_breach'", [a.storeId]))[0]?.id ?? "";
    const svc = mk();
    await svc.submit({ storeId: a.storeId, userId: a.userId, findingId: f, idempotencyKey: randomUUID(), connectionId: c.id });
    expect(await svc.processPending()).toEqual({ upheld: 0, rejected: 1 });
    await svc.submit({ storeId: a.storeId, userId: a.userId, findingId: f, idempotencyKey: randomUUID(), connectionId: c.id });
    await snap(a.storeId, c.id, pid, 95, hr(0.5));
    clock = hr(1);
    expect(await svc.processPending()).toEqual({ upheld: 1, rejected: 0 });
    clock = T0;
  });
  it("a store-level finding is rejected until a re-score resolves it", async () => {
    clock = T0;
    const a = await seedStore();
    await seedConn(a.storeId, "disconnected");
    const sku = await seedSku(a.storeId);
    await new ClaimScorer(env()).scoreSku({ storeId: a.storeId, skuId: sku });
    const f = (await q<{ id: string }>("SELECT id FROM price_findings WHERE store_id = $1 AND rule = 'channel_disconnected'", [a.storeId]))[0]?.id ?? "";
    const c2 = await seedConn(a.storeId, "pending", "feed", "p.");
    await raw.query("UPDATE channel_connections SET status = 'active', verified_at = $2 WHERE id = $1", [c2.id, T0]);
    const svc = mk();
    await svc.submit({ storeId: a.storeId, userId: a.userId, findingId: f, idempotencyKey: randomUUID(), connectionId: c2.id });
    expect(await svc.processPending()).toEqual({ upheld: 0, rejected: 1 });
  });
});
const events = async (type: string) => q<{ payload: Record<string, unknown> }>("SELECT payload FROM outbox_events WHERE event_type = $1", [type]);
