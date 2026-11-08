import { randomUUID } from "node:crypto";
import { withDbContext } from "@outlet/db";
import type { SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AppealService, ClaimScorer, ClaimedReferenceService, DAY_MS, InMemorySlotStore, MatchingService, PriceEvidencePublic, SharedDomainRateLimiter, SnapshotIngestor,
  assertSafeTarget, isPublicIp, makeEnv, makeWatchEnv, readLiveClaim, safeFetch,
} from "../src/index.js";
import type { ExternalItem, FetchRequest, FetchResponse, ListingFingerprintPort, MatchStage } from "../src/index.js";

const T0 = new Date("2026-10-01T09:00:00.000Z");
const MARKET = "EG";
const PUB = "93.184.216.34";
let raw: SqlClient;
let close: () => Promise<void>;
let clock = T0;
let crawlerKilled = false;
const dnsMap: Record<string, string[]> = {};
const day = (n: number): Date => new Date(T0.getTime() + n * DAY_MS);
const hr = (n: number): Date => new Date(T0.getTime() + n * 3_600_000);
const env = () => makeWatchEnv({ app: roleClient(raw, "outlet_app"), worker: roleClient(raw, "outlet_worker"), marketId: MARKET, now: () => clock, killSwitch: { isKilled: () => Promise.resolve(false) }, crawlerKilled: () => Promise.resolve(crawlerKilled) });
const q = async <R extends object>(sql: string, p: unknown[] = []): Promise<R[]> => (await raw.query<R>(sql, p)).rows;
const asApp = <T>(storeId: string, fn: (tx: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<T>): Promise<T> =>
  withDbContext(roleClient(raw, "outlet_app"), { kind: "store", marketId: MARKET, storeId }, fn);

const seedStore = async (): Promise<{ storeId: string; userId: string }> => {
  const sellerId = randomUUID();
  const storeId = randomUUID();
  await raw.query("INSERT INTO sellers (id, home_market_id, market_id, legal_type) VALUES ($1, 'EG', 'EG', 'company')", [sellerId]);
  await raw.query("INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, kind, ships_from_country) VALUES ($1, $2, 'EG', $3, 'متجر', 'local', 'EG')", [storeId, sellerId, `s-${storeId.slice(0, 8)}`]);
  return { storeId, userId: randomUUID() };
};
const seedSku = async (storeId: string, cut = 80): Promise<string> => {
  const sku = randomUUID();
  await raw.query("INSERT INTO price_events (id, sku_id, store_ref, market_id, currency, price_minor, valid_from, valid_to, source) VALUES ($1,$2,$3,'EG','EGP',100,$4,$5,'internal')", [randomUUID(), sku, storeId, day(-60), day(-10)]);
  await raw.query("INSERT INTO price_events (id, sku_id, store_ref, market_id, currency, price_minor, valid_from, valid_to, source) VALUES ($1,$2,$3,'EG','EGP',$5,$4,NULL,'internal')", [randomUUID(), sku, storeId, day(-10), cut]);
  return sku;
};
const seedConn = async (storeId: string, status = "active", type = "feed", prefix = "", tier = "normal"): Promise<{ id: string; domain: string }> => {
  const id = randomUUID();
  const domain = `${prefix}${storeId.slice(0, 8)}.example.com`;
  dnsMap[domain] = [PUB];
  await raw.query(
    "INSERT INTO channel_connections (id, store_id, market_id, type, domain, base_url, verify_method, status, verified_at, next_check_at, risk_tier) VALUES ($1,$2,'EG',$3,$4,$5,'oauth',$6,$7,$7,$8)",
    [id, storeId, type, domain, `https://${domain}/f.json`, status, status === "pending" ? null : T0, tier],
  );
  return { id, domain };
};
const seedProduct = async (storeId: string, connId: string): Promise<string> => {
  const id = randomUUID();
  await raw.query("INSERT INTO external_products (id, connection_id, store_id, market_id, external_ref) VALUES ($1,$2,$3,'EG',$4)", [id, connId, storeId, randomUUID()]);
  return id;
};
const snap = (storeId: string, connId: string, pid: string, price: number, at: Date, currency = "EGP") =>
  raw.query("INSERT INTO channel_snapshots (id, fetched_at, connection_id, external_product_id, store_id, market_id, price_minor, currency, in_stock, method) VALUES ($1,$2,$3,$4,$5,'EG',$6,$7,true,'api')", [randomUUID(), at, connId, pid, storeId, price, currency]);
const insertMatch = async (storeId: string, sku: string, pid: string, status = "auto", conf = 9500): Promise<string> => {
  const id = randomUUID();
  await raw.query("INSERT INTO product_matches (id, sku_id, store_id, market_id, external_product_id, method, confidence_bp, model_version, status) VALUES ($1,$2,$3,'EG',$4,'gtin',$5,'v1',$6)", [id, sku, storeId, pid, conf, status]);
  return id;
};
const events = async (type: string) => q<{ payload: Record<string, unknown> }>("SELECT payload FROM outbox_events WHERE event_type = $1", [type]);
const findingStatus = async (storeId: string, rule: string): Promise<string | undefined> => (await q<{ status: string }>("SELECT status FROM price_findings WHERE store_id = $1 AND rule = $2", [storeId, rule]))[0]?.status;
const scorer = (fp?: ListingFingerprintPort) => new ClaimScorer(env(), undefined, fp);

beforeAll(async () => {
  ({ client: raw, close } = await createTestClient());
});
afterAll(async () => {
  await close();
});

describe("A1 findings only resolve when their rule was evaluated", () => {
  it("a price-event re-score (no claim passed) keeps a fake_reference finding open; only an explicit null clears it", async () => {
    clock = T0;
    const { storeId, userId } = await seedStore();
    const sku = await seedSku(storeId);
    await scorer().scoreSku({ storeId, skuId: sku, claimedReferenceMinor: 360n });
    expect(await findingStatus(storeId, "fake_reference")).toBe("open");
    const again = await scorer().scoreSku({ storeId, skuId: sku }); // what a price.changed re-score looks like
    expect(await findingStatus(storeId, "fake_reference")).toBe("open");
    expect(again.displayAllowed).toBe(true);
    expect((await q("SELECT 1 FROM sku_claimed_reference WHERE sku_id = $1", [sku])).length).toBe(1);
    await scorer().scoreSku({ storeId, skuId: sku, claimedReferenceMinor: null });
    expect(await findingStatus(storeId, "fake_reference")).toBe("resolved");
    // the Seller Center path stores the claim without scoring
    const svc = new ClaimedReferenceService(env());
    await svc.set(storeId, userId, sku, 500n);
    await expect(svc.set(storeId, userId, sku, 0n)).rejects.toMatchObject({ code: "invalid" });
    await scorer().scoreSku({ storeId, skuId: sku });
    expect(await findingStatus(storeId, "fake_reference")).toBeDefined();
    await svc.clear(storeId, userId, sku);
    expect((await q("SELECT 1 FROM sku_claimed_reference WHERE sku_id = $1", [sku])).length).toBe(0);
  });
  it("an appeal re-score with a null claimed reference keeps the finding (rejected, back to open); a corrected claim upholds it", async () => {
    clock = T0;
    const a = await seedStore();
    const sku = await seedSku(a.storeId);
    const conn = await seedConn(a.storeId);
    await scorer().scoreSku({ storeId: a.storeId, skuId: sku, claimedReferenceMinor: 360n });
    const f = (await q<{ id: string }>("SELECT id FROM price_findings WHERE store_id = $1 AND rule = 'fake_reference'", [a.storeId]))[0]?.id ?? "";
    const svc = new AppealService(env(), scorer());
    await svc.submit({ storeId: a.storeId, userId: a.userId, findingId: f, idempotencyKey: randomUUID(), connectionId: conn.id });
    expect(await findingStatus(a.storeId, "fake_reference")).toBe("appealed");
    expect(await svc.processPending()).toEqual({ upheld: 0, rejected: 1 });
    expect(await findingStatus(a.storeId, "fake_reference")).toBe("open");
    await svc.submit({ storeId: a.storeId, userId: a.userId, findingId: f, idempotencyKey: randomUUID(), connectionId: conn.id, claimedReferenceMinor: 100n });
    expect(await svc.processPending()).toEqual({ upheld: 1, rejected: 0 });
    expect(await findingStatus(a.storeId, "fake_reference")).toBe("upheld");
  });
  it("parity and sudden-discount findings are not resolved by a pass that could not evaluate them", async () => {
    clock = T0;
    const { storeId } = await seedStore();
    const c = await seedConn(storeId);
    const sku = await seedSku(storeId);
    const pid = await seedProduct(storeId, c.id);
    await snap(storeId, c.id, pid, 70, day(-45));
    await snap(storeId, c.id, pid, 70, hr(-1));
    await insertMatch(storeId, sku, pid);
    await scorer().scoreSku({ storeId, skuId: sku });
    expect(await findingStatus(storeId, "parity_breach")).toBe("open");
    crawlerKilled = true; // external evidence not read: parity was not evaluated
    await scorer().scoreSku({ storeId, skuId: sku });
    crawlerKilled = false;
    expect(await findingStatus(storeId, "parity_breach")).toBe("open");
    // sudden_discount needs mega events; a re-score without them must keep it
    const s2 = await seedStore();
    const sku2 = randomUUID();
    for (const [i, p] of [100, 60].entries()) await raw.query("INSERT INTO price_events (id, sku_id, store_ref, market_id, currency, price_minor, valid_from, valid_to, source) VALUES ($1,$2,$3,'EG','EGP',$4,$5,$6,'internal')", [randomUUID(), sku2, s2.storeId, p, day(-3 + i), i === 0 ? day(-2) : null]);
    await scorer().scoreSku({ storeId: s2.storeId, skuId: sku2, megaEvents: [{ startsAt: day(2) }], sellThroughPct: 5 });
    expect(await findingStatus(s2.storeId, "sudden_discount")).toBe("open");
    await scorer().scoreSku({ storeId: s2.storeId, skuId: sku2 });
    expect(await findingStatus(s2.storeId, "sudden_discount")).toBe("open");
    await scorer().scoreSku({ storeId: s2.storeId, skuId: sku2, megaEvents: [], sellThroughPct: 5 });
    expect(await findingStatus(s2.storeId, "sudden_discount")).toBe("resolved");
  });
  it("stale external evidence does not turn an honest persisted claim into a fake_reference", async () => {
    clock = T0;
    const { storeId } = await seedStore();
    const c = await seedConn(storeId);
    const sku = await seedSku(storeId);
    const pid = await seedProduct(storeId, c.id);
    await snap(storeId, c.id, pid, 90, day(-45));
    await snap(storeId, c.id, pid, 90, hr(-71));
    await insertMatch(storeId, sku, pid);
    await scorer().scoreSku({ storeId, skuId: sku, claimedReferenceMinor: 90n });
    clock = hr(5);
    expect(await scorer().scoreSku({ storeId, skuId: sku })).toMatchObject({ reason: "stale_external", findings: [] });
    expect(await findingStatus(storeId, "fake_reference")).toBeUndefined();
    clock = T0;
  });
});

describe("A2 currency", () => {
  it("a USD snapshot never changes an EGP VRP or raises parity; ingest drops foreign-currency items", async () => {
    clock = T0;
    const { storeId } = await seedStore();
    const c = await seedConn(storeId);
    const sku = await seedSku(storeId);
    const pid = await seedProduct(storeId, c.id);
    await snap(storeId, c.id, pid, 90, day(-45));
    await snap(storeId, c.id, pid, 90, hr(-1));
    await snap(storeId, c.id, pid, 10, day(-40), "USD");
    await snap(storeId, c.id, pid, 10, hr(-1), "USD"); // would be a parity breach and a VRP of 10 if it were read as EGP
    await insertMatch(storeId, sku, pid);
    const r = await scorer().scoreSku({ storeId, skuId: sku });
    expect(r).toMatchObject({ vrpMinor: 90n, findings: [] });
    expect(await findingStatus(storeId, "parity_breach")).toBeUndefined();
    const sleeps: number[] = [];
    const item: ExternalItem = { externalRef: "p1", priceMinor: 10n, currency: "USD", inStock: true };
    const ing = new SnapshotIngestor(env(), { fetch: { fetch: () => Promise.resolve({ status: 200, items: [item, { ...item, externalRef: "p2", currency: "EGP" }] }) }, dns: { resolve: (h) => Promise.resolve(dnsMap[h] ?? []) }, robots: { allowed: () => Promise.resolve(true) }, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); }, random: () => 0 });
    const c2 = await seedConn(storeId, "active", "feed", "u.");
    await ing.syncOne({ id: c2.id, store_id: storeId, type: "feed", domain: c2.domain, base_url: `https://${c2.domain}/f.json`, risk_tier: "normal" });
    expect((await q<{ currency: string }>("SELECT currency FROM channel_snapshots WHERE connection_id = $1", [c2.id])).map((x) => x.currency)).toEqual(["EGP"]);
  });
});

describe("A3 72 h sweeper and shopper read path", () => {
  it("a dead channel degrades the claim to plain: the reader at once, the claim at the next sweep", async () => {
    clock = T0;
    const { storeId } = await seedStore();
    const c = await seedConn(storeId);
    const sku = await seedSku(storeId);
    const pid = await seedProduct(storeId, c.id);
    await snap(storeId, c.id, pid, 90, day(-45));
    await snap(storeId, c.id, pid, 90, T0);
    await insertMatch(storeId, sku, pid);
    expect(await scorer().scoreSku({ storeId, skuId: sku })).toMatchObject({ displayAllowed: true, vrpMinor: 90n });
    const until = (await q<{ valid_until: Date }>("SELECT valid_until FROM price_claims WHERE sku_id = $1 AND status = 'active'", [sku]))[0]?.valid_until;
    expect(until?.getTime()).toBe(hr(72).getTime());
    expect((await scorer().resweepExpiredClaims(hr(72))).rescored).toBeGreaterThanOrEqual(1); // valid_until <= now: re-scored, still fresh at exactly 72 h (the sweep is market-wide)
    const live72 = await readLiveClaim(raw, sku, MARKET, hr(72));
    expect(live72).toMatchObject({ displayAllowed: true, expired: false });
    clock = hr(73);
    const live = await readLiveClaim(raw, sku, MARKET, clock);
    expect(live).toMatchObject({ exists: true, displayAllowed: false, expired: true });
    const e = makeEnv({ client: raw, marketId: MARKET, killSwitch: { isKilled: () => Promise.resolve(false) }, now: () => clock });
    expect((await new PriceEvidencePublic(e).get(sku))?.discountPct).toBeNull();
    expect((await scorer().resweepExpiredClaims()).rescored).toBeGreaterThanOrEqual(1);
    expect(await q("SELECT display_allowed, reason FROM price_claims WHERE sku_id = $1 AND status = 'active'", [sku])).toEqual([{ display_allowed: false, reason: "stale_external" }]);
    expect((await q<{ valid_until: Date | null }>("SELECT valid_until FROM price_claims WHERE sku_id = $1 AND status = 'active'", [sku]))[0]?.valid_until).toBeNull(); // degraded claims carry no valid_until: nothing to loop on
    clock = T0;
  });
  it("a live claim with an external-lowered VRP tightens the shopper evidence; no claim means internal evidence", async () => {
    clock = T0;
    const { storeId } = await seedStore();
    const c = await seedConn(storeId);
    const sku = await seedSku(storeId);
    const pid = await seedProduct(storeId, c.id);
    await snap(storeId, c.id, pid, 90, day(-45));
    await snap(storeId, c.id, pid, 90, hr(-1));
    await insertMatch(storeId, sku, pid);
    const e = makeEnv({ client: raw, marketId: MARKET, killSwitch: { isKilled: () => Promise.resolve(false) }, now: () => clock });
    expect((await new PriceEvidencePublic(e).get(sku))?.discountPct).toBe(20);
    await scorer().scoreSku({ storeId, skuId: sku });
    expect((await new PriceEvidencePublic(e).get(sku))?.discountPct).toBe(11);
    expect(await readLiveClaim(raw, randomUUID(), MARKET, clock)).toMatchObject({ exists: false });
  });
});

describe("A4 product_matches at the database layer", () => {
  it("a seller can decide only an uncertain match; a rejected sub-tau match returns when new evidence reaches tau", async () => {
    clock = T0;
    const { storeId, userId } = await seedStore();
    const c = await seedConn(storeId);
    const sku = await seedSku(storeId);
    const [p1, p2] = [await seedProduct(storeId, c.id), await seedProduct(storeId, c.id)];
    const auto = await insertMatch(storeId, sku, p1, "auto", 9500);
    await expect(asApp(storeId, (tx) => tx.query("UPDATE product_matches SET status = 'rejected' WHERE id = $1", [auto]))).rejects.toThrow(/may only confirm or reject/);
    const unsure = await insertMatch(storeId, sku, p2, "needs_confirmation", 5000);
    await expect(asApp(storeId, (tx) => tx.query("UPDATE product_matches SET status = 'auto' WHERE id = $1", [unsure]))).rejects.toThrow(/may only confirm or reject/);
    await expect(asApp(storeId, (tx) => tx.query("UPDATE product_matches SET confidence_bp = 10000 WHERE id = $1", [unsure]))).rejects.toThrow();
    const svc = new MatchingService(env(), []);
    await svc.reject(storeId, userId, unsure);
    await expect(asApp(storeId, (tx) => tx.query("UPDATE product_matches SET status = 'seller_confirmed' WHERE id = $1", [unsure]))).rejects.toThrow(/may only confirm or reject/);
    const stage = (conf: number): MatchStage => ({ method: "embedding", modelVersion: "m2", find: () => Promise.resolve({ skuId: sku, confidenceBp: conf }) });
    expect(await new MatchingService(env(), [stage(6000)]).matchProduct(p2)).toBe("kept"); // still sub-tau: the rejection stands
    expect((await q<{ status: string }>("SELECT status FROM product_matches WHERE id = $1", [unsure]))[0]?.status).toBe("rejected");
    expect(await new MatchingService(env(), [stage(9800)]).matchProduct(p2)).toBe("auto"); // new evidence at tau: re-proposed as auto
    expect((await q<{ status: string; confirmed_by: string | null }>("SELECT status, confirmed_by FROM product_matches WHERE id = $1", [unsure]))[0]).toEqual({ status: "auto", confirmed_by: null });
  });
});

describe("A5 per-connection evidence", () => {
  it("disconnecting one matched channel raises channel_disconnected even when another channel is active", async () => {
    clock = T0;
    const { storeId } = await seedStore();
    await seedConn(storeId, "active", "feed", "ok.");
    const c = await seedConn(storeId, "active", "feed", "gone.");
    const sku = await seedSku(storeId);
    const pid = await seedProduct(storeId, c.id);
    await snap(storeId, c.id, pid, 90, day(-45));
    await snap(storeId, c.id, pid, 90, hr(-1));
    await insertMatch(storeId, sku, pid);
    expect(await scorer().scoreSku({ storeId, skuId: sku })).toMatchObject({ displayAllowed: true });
    await raw.query("UPDATE channel_connections SET status = 'disconnected' WHERE id = $1", [c.id]);
    expect(await scorer().scoreSku({ storeId, skuId: sku })).toMatchObject({ displayAllowed: false, reason: "channel_disconnected", findings: ["channel_disconnected"] });
  });
  it("a failed connection is stale evidence at once: the claim goes plain and the trust score notes it", async () => {
    clock = T0;
    const { storeId } = await seedStore();
    const c = await seedConn(storeId);
    const sku = await seedSku(storeId);
    const pid = await seedProduct(storeId, c.id);
    await snap(storeId, c.id, pid, 90, day(-45));
    await snap(storeId, c.id, pid, 90, hr(-1));
    await insertMatch(storeId, sku, pid);
    const ok = await scorer().scoreSku({ storeId, skuId: sku });
    await raw.query("UPDATE channel_connections SET status = 'failed' WHERE id = $1", [c.id]);
    const r = await scorer().scoreSku({ storeId, skuId: sku });
    expect(r).toMatchObject({ displayAllowed: false, vrpMinor: null, reason: "stale_external" });
    expect(r.trustScore).toBeLessThan(ok.trustScore);
  });
  it("three failed runs (each with 3 backed-off attempts) mark the connection failed; a good run recovers it", async () => {
    clock = T0;
    const { storeId } = await seedStore();
    const c = await seedConn(storeId);
    await raw.query("UPDATE channel_connections SET next_check_at = '2100-01-01' WHERE id <> $1", [c.id]);
    const mk = (fail: boolean, sleeps: number[]) => new SnapshotIngestor(env(), {
      fetch: { fetch: () => (fail ? Promise.reject(new Error("down")) : Promise.resolve({ status: 200, items: [] })) },
      dns: { resolve: (h) => Promise.resolve(dnsMap[h] ?? []) }, robots: { allowed: () => Promise.resolve(true) }, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); }, random: () => 0,
    });
    const due = { id: c.id, store_id: storeId, type: "feed", domain: c.domain, base_url: `https://${c.domain}/f.json`, risk_tier: "normal" as const };
    const sleeps: number[] = [];
    const row = async () => (await q<{ status: string; consecutive_failures: number }>("SELECT status, consecutive_failures FROM channel_connections WHERE id = $1", [c.id]))[0];
    expect(await mk(true, sleeps).syncOne(due)).toBe("failed");
    expect(sleeps.filter((s) => s === 1000 || s === 2000).length).toBe(2); // 3 attempts, 2 backoffs
    expect(await row()).toEqual({ status: "active", consecutive_failures: 1 });
    await mk(true, sleeps).syncOne(due);
    expect((await row())?.status).toBe("active");
    await mk(true, sleeps).syncOne(due);
    expect(await row()).toEqual({ status: "failed", consecutive_failures: 3 });
    await raw.query("UPDATE channel_connections SET next_check_at = $2 WHERE id = $1", [c.id, T0]);
    expect((await mk(false, sleeps).runDue()).synced).toBe(1); // failed connections are retried
    expect(await row()).toEqual({ status: "active", consecutive_failures: 0 });
  });
});

describe("A6 seller-writable columns on channel_connections", () => {
  it("outlet_app may update verification and schedule state but not risk_tier, domain, base_url or the failure counter", async () => {
    const { storeId } = await seedStore();
    const c = await seedConn(storeId, "pending");
    for (const col of ["risk_tier = 'trusted'", "domain = 'evil.example.com'", "base_url = 'https://evil.example.com/'", "consecutive_failures = 0", "webhook_secret_ref = 'kms:x'"]) {
      await expect(asApp(storeId, (tx) => tx.query(`UPDATE channel_connections SET ${col} WHERE id = $1`, [c.id])), col).rejects.toThrow(/permission denied/);
    }
    await asApp(storeId, (tx) => tx.query("UPDATE channel_connections SET status = 'disconnected', updated_at = now() WHERE id = $1", [c.id]));
    await expect(asApp(storeId, (tx) => tx.query("INSERT INTO channel_connections (id, store_id, market_id, type, domain, base_url, verify_method, risk_tier) VALUES ($1,$2,'EG','feed','r.example.com','https://r.example.com/','file','trusted')", [randomUUID(), storeId]))).rejects.toThrow(/permission denied/);
  });
});

describe("A7 politeness before every HTTP call", () => {
  const item: ExternalItem = { externalRef: "p1", priceMinor: 90n, currency: "EGP", inStock: true };
  it("a redirect hop reserves its own slot and robots.txt is checked for the redirected path", async () => {
    clock = T0;
    const { storeId } = await seedStore();
    const c = await seedConn(storeId, "active", "website");
    const due = { id: c.id, store_id: storeId, type: "website", domain: c.domain, base_url: `https://${c.domain}/a`, risk_tier: "normal" as const };
    const sleeps: number[] = [];
    const robotsPaths: string[] = [];
    const calls: string[] = [];
    const run = (allowB: boolean) => new SnapshotIngestor(env(), {
      fetch: { fetch: (r: FetchRequest): Promise<FetchResponse> => { calls.push(r.url); return Promise.resolve(r.url.endsWith("/a") ? { status: 302, location: "/b", items: [] } : { status: 200, items: [item] }); } },
      dns: { resolve: (h) => Promise.resolve(dnsMap[h] ?? []) },
      robots: { allowed: (_d, p) => { robotsPaths.push(p); return Promise.resolve(p !== "/b" || allowB); } },
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); }, random: () => 0,
    }).syncOne(due);
    expect(await run(true)).toBe("synced");
    expect(robotsPaths).toEqual(["/a", "/b"]);
    expect(sleeps).toEqual([5000]); // hop 2 waited a fresh 5 s slot on the frozen clock
    calls.length = 0;
    expect(await run(false)).toBe("skipped"); // /b is disallowed: the first hop was sent, the redirect target never is
    expect(calls.length).toBe(1);
  });
  it("the limiter is a port: a shared (Redis-shaped) store paces two workers through one slot sequence", async () => {
    const store = new InMemorySlotStore();
    const w1 = new SharedDomainRateLimiter(store, 5000);
    const w2 = new SharedDomainRateLimiter(store, 5000);
    expect([await w1.reserve("d.com", 1000), await w2.reserve("d.com", 1000), await w1.reserve("d.com", 1000), await w2.reserve("other.com", 1000)]).toEqual([0, 5000, 10_000, 0]);
    expect(await w1.reserve("d.com", 100_000)).toBe(0);
  });
});

describe("A8 SSRF ranges and the adapter pinning contract", () => {
  it("6to4, Teredo and discard-only prefixes are not public", () => {
    for (const ip of ["2002:5d b8:d822::1".replace(" ", ""), "2002::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001::1", "100::1", "100::ffff:1:2:3", "2001:db8::1"]) expect(isPublicIp(ip), ip).toBe(false);
    for (const ip of ["2606:4700::1", "2001:4860:4860::8888", "100:0:0:1::1"]) expect(isPublicIp(ip), ip).toBe(true);
  });
  it("safeFetch hands the adapter the ONE validated address on every hop; a rebinding DNS answer cannot reach it", async () => {
    let resolves = 0;
    const dns = { resolve: () => Promise.resolve(++resolves === 1 ? [PUB] : ["10.0.0.1"]) };
    const connectedTo: { address: string; host: string }[] = [];
    // Reference adapter implementing the contract: connect to req.address, send Host from the URL, never resolve again.
    const adapter = { fetch: (r: FetchRequest): Promise<FetchResponse> => { connectedTo.push({ address: r.address, host: new URL(r.url).hostname }); return Promise.resolve({ status: 200, items: [] }); } };
    await safeFetch(adapter, "https://shop.example.com/f", { dns, allowedDomains: ["example.com"] }, { userAgent: "t", timeoutMs: 1 });
    expect(connectedTo).toEqual([{ address: PUB, host: "shop.example.com" }]);
    expect(resolves).toBe(1);
    await expect(assertSafeTarget("https://shop.example.com/", { dns, allowedDomains: ["example.com"] })).rejects.toMatchObject({ code: "unsafe_target" }); // the second answer is private
  });
});

describe("A9 appeal keys and Ops decisions", () => {
  const mk = () => { const e = env(); return new AppealService(e, new ClaimScorer(e)); };
  it("keys are unique per (store, key): another store may reuse one, the same key for a different finding is a 422-class error", async () => {
    clock = T0;
    const [a, b] = [await seedStore(), await seedStore()];
    const key = randomUUID();
    const fs: string[] = [];
    for (const s of [a, b]) {
      const sku = await seedSku(s.storeId);
      await scorer().scoreSku({ storeId: s.storeId, skuId: sku, claimedReferenceMinor: 360n });
      fs.push((await q<{ id: string }>("SELECT id FROM price_findings WHERE store_id = $1", [s.storeId]))[0]?.id ?? "");
    }
    const sku2 = await seedSku(a.storeId);
    await scorer().scoreSku({ storeId: a.storeId, skuId: sku2, claimedReferenceMinor: 360n });
    const f2 = (await q<{ id: string }>("SELECT id FROM price_findings WHERE sku_id = $1", [sku2]))[0]?.id ?? "";
    const svc = mk();
    const media = randomUUID();
    const ra = await svc.submit({ storeId: a.storeId, userId: a.userId, findingId: fs[0] ?? "", idempotencyKey: key, evidenceMediaId: media });
    const rb = await svc.submit({ storeId: b.storeId, userId: b.userId, findingId: fs[1] ?? "", idempotencyKey: key, evidenceMediaId: media });
    expect(rb.id).not.toBe(ra.id);
    await expect(svc.submit({ storeId: a.storeId, userId: a.userId, findingId: f2, idempotencyKey: key, evidenceMediaId: media })).rejects.toMatchObject({ code: "invalid" });
  });
  it("Ops decisions move the finding and the pending suspension; only queued appeals can be decided", async () => {
    clock = T0;
    const s = await seedStore();
    const skus: string[] = [];
    for (let i = 0; i < 6; i++) skus.push(await seedSku(s.storeId));
    for (const k of skus) await scorer().scoreSku({ storeId: s.storeId, skuId: k, claimedReferenceMinor: 360n });
    const fid = (await q<{ finding_id: string }>("SELECT finding_id FROM enforcement_actions WHERE store_id = $1 AND action = 'suspend_store'", [s.storeId]))[0]?.finding_id ?? "";
    const svc = mk();
    const admin = randomUUID();
    const ap1 = await svc.submit({ storeId: s.storeId, userId: s.userId, findingId: fid, idempotencyKey: randomUUID(), evidenceMediaId: randomUUID() });
    expect(ap1.status).toBe("ops_queue");
    expect((await q<{ status: string }>("SELECT status FROM price_findings WHERE id = $1", [fid]))[0]?.status).toBe("appealed");
    expect(await svc.processOpsDecision(admin, ap1.id, "rejected")).toEqual({ status: "rejected" });
    expect(await q("SELECT status, reviewed_by FROM enforcement_actions WHERE finding_id = $1 AND action = 'suspend_store'", [fid])).toEqual([{ status: "active", reviewed_by: admin }]);
    expect((await q<{ status: string }>("SELECT status FROM price_findings WHERE id = $1", [fid]))[0]?.status).toBe("open");
    await expect(svc.processOpsDecision(admin, ap1.id, "upheld")).rejects.toMatchObject({ code: "not_found" });
    const ap2 = await svc.submit({ storeId: s.storeId, userId: s.userId, findingId: fid, idempotencyKey: randomUUID(), evidenceMediaId: randomUUID() });
    expect(await svc.processOpsDecision(admin, ap2.id, "upheld")).toEqual({ status: "upheld" });
    expect((await q<{ status: string }>("SELECT status FROM price_findings WHERE id = $1", [fid]))[0]?.status).toBe("upheld");
    expect((await q<{ status: string }>("SELECT status FROM enforcement_actions WHERE finding_id = $1 AND action = 'suspend_store'", [fid]))[0]?.status).toBe("lifted");
    expect((await q<{ decided_by: string }>("SELECT decided_by FROM price_appeals WHERE id = $1", [ap2.id]))[0]?.decided_by).toBe(admin);
  });
});

describe("A10 detectors, risk tier, sanction expiry and payout hold", () => {
  const fp = (id: string, storeId: string, phash: number[], active = true) => ({ id, storeId, phash: Uint8Array.from(phash), brand: "b", color: "c", category: "k", active });
  it("duplicate_reset and image_reuse are wired behind the fingerprint port; an absent port or answer evaluates neither", async () => {
    clock = T0;
    const { storeId } = await seedStore();
    const other = await seedStore();
    const sku = await seedSku(storeId);
    const h = [1, 2, 3, 4, 5, 6, 7, 8];
    const port: ListingFingerprintPort = { forSku: () => Promise.resolve({ listing: fp("new", storeId, h), sameStore: [fp("old", storeId, h, false)], otherStores: [fp("x", other.storeId, h)] }) };
    expect([...(await scorer(port).scoreSku({ storeId, skuId: sku })).findings].sort()).toEqual(["duplicate_reset", "image_reuse"]);
    expect(await findingStatus(storeId, "duplicate_reset")).toBe("open");
    await scorer().scoreSku({ storeId, skuId: sku }); // no port: not evaluated, so not resolved
    expect(await findingStatus(storeId, "image_reuse")).toBe("open");
    const clean: ListingFingerprintPort = { forSku: () => Promise.resolve({ listing: fp("new", storeId, h), sameStore: [], otherStores: [] }) };
    await scorer(clean).scoreSku({ storeId, skuId: sku });
    expect(await findingStatus(storeId, "image_reuse")).toBe("resolved");
    const down: ListingFingerprintPort = { forSku: () => Promise.reject(new Error("index down")) };
    await scorer(down).scoreSku({ storeId, skuId: sku });
  });
  it("the trust tier drives risk_tier", async () => {
    clock = T0;
    const { storeId } = await seedStore();
    const c = await seedConn(storeId, "active", "feed", "", "watched");
    const sku = await seedSku(storeId);
    await scorer().scoreSku({ storeId, skuId: sku });
    expect((await q<{ risk_tier: string }>("SELECT risk_tier FROM channel_connections WHERE id = $1", [c.id]))[0]?.risk_tier).toBe("trusted");
  });
  it("sanctions expire after 30 days, the lift job expires them and re-scores what they hid; suspension emits payouts.hold_requested", async () => {
    clock = T0;
    const { storeId } = await seedStore();
    const skus: string[] = [];
    for (let i = 0; i < 6; i++) skus.push(await seedSku(storeId));
    for (const k of skus) await scorer().scoreSku({ storeId, skuId: k, claimedReferenceMinor: 360n });
    const lose = (await q<{ expires_at: Date }>("SELECT expires_at FROM enforcement_actions WHERE store_id = $1 AND action IN ('lose_verified', 'commission_surcharge')", [storeId]));
    expect(lose.length).toBeGreaterThanOrEqual(2);
    expect(lose.every((r) => r.expires_at.getTime() === day(30).getTime())).toBe(true);
    const hold = (await events("payouts.hold_requested")).filter((e) => e.payload.store_id === storeId);
    expect(hold.length).toBe(1);
    expect(hold[0]?.payload).toMatchObject({ reason: "price_enforcement_suspension", store_id: storeId });
    const r = await scorer().liftExpiredActions(day(31));
    expect(r.lifted).toBeGreaterThanOrEqual(2);
    expect((await q("SELECT 1 FROM enforcement_actions WHERE store_id = $1 AND action = 'lose_verified' AND status = 'expired'", [storeId])).length).toBeGreaterThan(0);
    expect(r.rescored).toBeGreaterThan(0);
    expect(await scorer().liftExpiredActions(day(31))).toEqual({ lifted: 0, rescored: 0 });
  });
});
