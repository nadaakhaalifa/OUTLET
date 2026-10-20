import { describe, expect, it } from "vitest";
import { API_KEY, KMS_REF, LOGIN, PUBLIC_IP, SKU, STORE_A, STORE_B, TARGET_A, TARGET_B, TOKEN_REF, createOdooHarness, seedCatalog } from "./harness";

const synced = async (h: ReturnType<typeof createOdooHarness>, id: string) => {
  const r = await h.sync.execute(id);
  if (r.kind !== "synced") throw new Error(`expected synced, got ${r.kind}${"code" in r ? `:${r.code}` : ""}`);
  return r.summary;
};

describe("connect", () => {
  it("authenticates once, stores no secret, and sends only placeholders upstream", async () => {
    const h = createOdooHarness();
    const id = await h.connectA();
    const cfg = await h.store.getConfig(id);
    expect(cfg).toMatchObject({ storeId: STORE_A, targetId: TARGET_A, database: "haul_prod", uid: 7 });
    const blob = JSON.stringify([cfg, [...h.directory.channels.values()].map((c) => ({ ...c, tokenRef: "x" })), [...h.metrics.counters]]);
    expect(blob).not.toContain(API_KEY);
    expect(blob).not.toContain(LOGIN);
    for (const s of h.server.seen) {
      expect(s.rawBody).not.toContain(API_KEY);
      expect(s.rawBody).not.toContain(LOGIN);
      expect(s.rawBody).toContain("__ODOO_API_KEY__");
      expect(s.url).toBe("https://odoo.shop-a.com/jsonrpc");
      expect(s.pinnedAddress).toBe(PUBLIC_IP);
    }
  });

  it("refuses a wrong API key and creates no channel", async () => {
    const h = createOdooHarness();
    h.server.secrets.set(TOKEN_REF, { login: LOGIN, apiKey: "rotated-away-key" });
    const bad = await h.connect.execute({ storeId: STORE_A, targetId: TARGET_A, database: "haul_prod", tokenRef: TOKEN_REF, kmsKeyRef: KMS_REF, pricelistId: null, stockLocationId: null, pollIntervalSeconds: 900 });
    expect(bad).toEqual({ kind: "failed", code: "auth_failed" });
    expect(h.server.badAuthCount).toBeGreaterThan(0);
  });

  it("requires a verified target of the same store, an existing secret and valid references", async () => {
    const h = createOdooHarness();
    const base = { storeId: STORE_A, database: "haul_prod", tokenRef: TOKEN_REF, kmsKeyRef: KMS_REF, pricelistId: null, stockLocationId: null, pollIntervalSeconds: 900 };
    expect((await h.connect.execute({ ...base, targetId: TARGET_B })).kind).toBe("target_required");
    expect((await h.connect.execute({ ...base, targetId: "00000000-0000-4000-b000-0000000000ff" })).kind).toBe("target_required");
    expect((await h.connect.execute({ ...base, targetId: TARGET_A, tokenRef: "vault://missing/x" })).kind).toBe("secret_missing");
    expect((await h.connect.execute({ ...base, targetId: TARGET_A, tokenRef: "bad ref" })).kind).toBe("invalid_ref");
    expect(h.server.seen).toHaveLength(0);
    h.flags.on = false;
    expect((await h.connect.execute({ ...base, targetId: TARGET_A })).kind).toBe("disabled");
    expect(h.server.seen).toHaveLength(0);
  });
});

describe("poll: stock and price", () => {
  it("syncs available stock (internal locations, minus Odoo reservations) and prices; unmapped skipped", async () => {
    const h = createOdooHarness();
    seedCatalog(h);
    const id = await h.connectA();
    const s = await synced(h, id);
    expect(s).toMatchObject({ products: 3, unmapped: 1, stockApplied: 2, pricesRecorded: 2, rejected: 0, truncated: false });
    // 10 - 3 reserved + 4 = 11 (the customer-location quant is ignored); 2.7 floors to 2.
    expect(h.stock.qty.get(SKU(1))).toBe(11);
    expect(h.stock.qty.get(SKU(2))).toBe(2);
    expect(h.stock.calls[0]).toMatchObject({ storeId: STORE_A, actorId: `odoo:${id}` });
    expect(h.stock.calls[0]?.sourceVersion).toBe(Math.floor(Date.UTC(2026, 9, 6, 10, 0, 0) / 1000));
    const byKey = new Map(h.prices.calls.map((c) => [c.skuId, c]));
    expect(byKey.get(SKU(1))?.priceAmount).toBe(150_000n);
    expect(byKey.get(SKU(2))?.priceAmount).toBe(79_950n);
    expect(byKey.get(SKU(99))).toBeUndefined();
    const cfg = await h.store.getConfig(id);
    expect(cfg).toMatchObject({ breakerFailures: 0, lastErrorCode: null });
    expect(cfg?.lastPolledAtMs).not.toBeNull();
  });

  it("a second poll with nothing changed writes nothing; a newer quant version applies once", async () => {
    const h = createOdooHarness();
    seedCatalog(h);
    const id = await h.connectA();
    await synced(h, id);
    const stockCalls = h.stock.calls.length;
    const priceCalls = h.prices.calls.length;
    h.clock.advance(1_000_000);
    const again = await synced(h, id);
    expect(again).toMatchObject({ stockApplied: 0, pricesRecorded: 0 });
    expect(h.stock.calls).toHaveLength(stockCalls);
    expect(h.prices.calls).toHaveLength(priceCalls);

    const q = h.server.quants[0];
    if (q === undefined) throw new Error("seed");
    q.quantity = 20;
    q.write_date = "2026-10-10 10:00:00";
    h.clock.advance(1_000_000);
    const third = await synced(h, id);
    expect(third.stockApplied).toBe(1);
    expect(h.stock.qty.get(SKU(1))).toBe(21);
  });

  it("an older source version is reported stale and never lowers newer stock", async () => {
    const h = createOdooHarness();
    seedCatalog(h);
    const id = await h.connectA();
    await synced(h, id);
    h.stock.versions.set(SKU(1), Number.MAX_SAFE_INTEGER);
    const q = h.server.quants[0];
    if (q === undefined) throw new Error("seed");
    q.quantity = 1;
    q.write_date = "2026-10-11 10:00:00";
    h.clock.advance(1_000_000);
    const s = await synced(h, id);
    expect(s.stockStale).toBe(1);
    expect(h.stock.qty.get(SKU(1))).toBe(11);
  });

  it("uses a fixed EGP pricelist item (variant before template) and never derives a was price", async () => {
    const h = createOdooHarness();
    seedCatalog(h);
    h.server.pricelists.set(5, { currency: "EGP" });
    h.server.items = [
      { pricelist_id: 5, product_id: 101, product_tmpl_id: false, fixed_price: 1200, min_quantity: 0, date_start: false, date_end: false, write_date: "2026-10-08 08:00:00" },
      { pricelist_id: 5, product_id: false, product_tmpl_id: 12, fixed_price: 700, min_quantity: 1, date_start: false, date_end: false, write_date: "2026-10-08 08:00:00" },
      { pricelist_id: 5, product_id: false, product_tmpl_id: 12, fixed_price: 600, min_quantity: 10, date_start: false, date_end: false, write_date: "2026-10-08 08:00:00" },
      { pricelist_id: 5, product_id: 102, product_tmpl_id: false, fixed_price: 1, min_quantity: 0, date_start: "2025-01-01 00:00:00", date_end: "2025-02-01 00:00:00", write_date: "2026-10-08 08:00:00" },
    ];
    const id = await h.connectA({ pricelistId: 5 });
    await synced(h, id);
    const byKey = new Map(h.prices.calls.map((c) => [c.skuId, c]));
    expect(byKey.get(SKU(1))?.priceAmount).toBe(120_000n);
    // Variant item is expired and the 600 item needs qty 10: the template item at 700 wins.
    expect(byKey.get(SKU(2))?.priceAmount).toBe(70_000n);
    for (const c of h.prices.calls) expect(Object.keys(c).sort()).toEqual(["idempotencyKey", "priceAmount", "skuId", "storeId", "validFromMs"]);
  });

  it("refuses a non-EGP pricelist and prices with more than 2 decimals", async () => {
    const h = createOdooHarness();
    seedCatalog(h);
    h.server.pricelists.set(6, { currency: "USD" });
    const id = await h.connectA({ pricelistId: 6 });
    const r = await h.sync.execute(id);
    expect(r).toEqual({ kind: "failed", code: "currency_unsupported" });
    expect(h.stock.calls).toHaveLength(0);
    expect(h.prices.calls).toHaveLength(0);

    const h2 = createOdooHarness();
    seedCatalog(h2);
    const p = h2.server.products[0];
    if (p === undefined) throw new Error("seed");
    p.list_price = 10.005;
    const id2 = await h2.connectA();
    await synced(h2, id2);
    expect(h2.prices.calls.find((c) => c.skuId === SKU(1))).toBeUndefined();
  });

  it("one SKU's price sink failure does not stop the others", async () => {
    const h = createOdooHarness();
    seedCatalog(h);
    h.prices.owners.set(SKU(1), STORE_B);
    const id = await h.connectA();
    const s = await synced(h, id);
    expect(s.rejected).toBe(1);
    expect(s.pricesRecorded).toBe(1);
  });
});

describe("SSRF, politeness, breaker, kill switch", () => {
  it("makes no request when the host resolves to a private address", async () => {
    const h = createOdooHarness();
    seedCatalog(h);
    const id = await h.connectA();
    const before = h.server.seen.length;
    h.dns.set("odoo.shop-a.com", ["10.0.0.5"]);
    const r = await h.sync.execute(id);
    expect(r).toEqual({ kind: "failed", code: "dns_rebinding" });
    expect(h.server.seen).toHaveLength(before);
  });

  it("detects rebinding after the call (second answer private, or connected address differs)", async () => {
    const h = createOdooHarness();
    seedCatalog(h);
    const id = await h.connectA();
    h.dns.set("odoo.shop-a.com", [PUBLIC_IP], ["127.0.0.1"]);
    expect(await h.sync.execute(id)).toEqual({ kind: "failed", code: "dns_rebinding" });
    expect(h.stock.calls).toHaveLength(0);

    const h2 = createOdooHarness();
    seedCatalog(h2);
    const id2 = await h2.connectA();
    h2.server.connectedAddressOverride = "169.254.169.254";
    expect(await h2.sync.execute(id2)).toEqual({ kind: "failed", code: "dns_rebinding" });
  });

  it("refuses redirects, garbage, truncated bodies, RPC errors and HTTP errors", async () => {
    for (const [mode, code] of [
      ["redirect", "redirect_refused"],
      ["garbage", "bad_response"],
      ["truncated", "size_exceeded"],
      ["rpc_error", "rpc_error"],
      ["http500", "http_error"],
      ["throw", "network_error"],
    ] as const) {
      const h = createOdooHarness();
      seedCatalog(h);
      const id = await h.connectA();
      h.server.mode = mode;
      expect(await h.sync.execute(id)).toEqual({ kind: "failed", code });
      expect((await h.store.getConfig(id))?.lastErrorCode).toBe(code);
    }
  });

  it("a channel can only call the verified domain of its own store (target of another store is refused)", async () => {
    const h = createOdooHarness();
    seedCatalog(h);
    const id = await h.connectA();
    const cfg = await h.store.getConfig(id);
    if (cfg === null) throw new Error("cfg");
    await h.store.updateConfig(cfg);
    // Re-point the stored config at store B's target: the directory refuses, nothing is sent.
    await h.store.insertConfig({ ...cfg, channelId: "00000000-0000-4000-d000-000000000001", targetId: TARGET_B });
    h.directory.channels.set("00000000-0000-4000-d000-000000000001", { id: "00000000-0000-4000-d000-000000000001", storeId: STORE_A, kind: "odoo", status: "active", tokenRef: TOKEN_REF, kmsKeyRef: KMS_REF });
    const before = h.server.seen.length;
    const r = await h.sync.execute("00000000-0000-4000-d000-000000000001");
    expect(r).toEqual({ kind: "failed", code: "ssrf_refused" });
    expect(h.server.seen).toHaveLength(before);
  });

  it("spaces requests to the same domain by at least 5 seconds", async () => {
    const h = createOdooHarness();
    seedCatalog(h);
    h.server.pricelists.set(5, { currency: "EGP" });
    const id = await h.connectA({ pricelistId: 5 });
    await synced(h, id);
    const t = h.egress.times;
    expect(t.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < t.length; i += 1) expect((t[i] ?? 0) - (t[i - 1] ?? 0)).toBeGreaterThanOrEqual(5_000);
  });

  it("opens the breaker after repeated failures, then refuses until the cool-off", async () => {
    const h = createOdooHarness();
    seedCatalog(h);
    const id = await h.connectA();
    h.server.mode = "http500";
    for (let i = 0; i < 5; i += 1) {
      h.clock.advance(60_000);
      expect((await h.sync.execute(id)).kind).toBe("failed");
    }
    const before = h.server.seen.length;
    expect((await h.sync.execute(id)).kind).toBe("breaker_open");
    expect(h.server.seen).toHaveLength(before);
    h.server.mode = "ok";
    h.clock.advance(6 * 3_600_000 + 1);
    expect((await h.sync.execute(id)).kind).toBe("synced");
    expect(await h.store.getConfig(id)).toMatchObject({ breakerFailures: 0, breakerOpenedAtMs: null });
  });

  it("the kill switch stops every poll before any request", async () => {
    const h = createOdooHarness();
    seedCatalog(h);
    const id = await h.connectA();
    const before = h.server.seen.length;
    h.flags.on = false;
    expect(await h.sync.execute(id)).toEqual({ kind: "disabled" });
    expect(await h.batch.execute()).toEqual({ polled: 1, failed: 0 });
    expect(h.server.seen).toHaveLength(before);
  });

  it("batch polls only due channels", async () => {
    const h = createOdooHarness();
    seedCatalog(h);
    const id = await h.connectA({ pollIntervalSeconds: 600 });
    expect((await h.batch.execute()).polled).toBe(1);
    expect((await h.batch.execute()).polled).toBe(0);
    h.clock.advance(601_000);
    expect((await h.batch.execute()).polled).toBe(1);
    expect(await h.store.getConfig(id)).not.toBeNull();
  });
});

describe("tenant isolation and lifecycle", () => {
  it("another store cannot test or disconnect a channel (not_found), and disconnect stops polling", async () => {
    const h = createOdooHarness();
    seedCatalog(h);
    const id = await h.connectA();
    expect(await h.test.execute(STORE_B, id)).toEqual({ kind: "not_found" });
    expect(await h.disconnect.execute(STORE_B, id)).toEqual({ kind: "not_found" });
    expect(await h.test.execute(STORE_A, id)).toEqual({ kind: "ok" });
    expect(await h.disconnect.execute(STORE_A, id)).toEqual({ kind: "disconnected" });
    const before = h.server.seen.length;
    expect(await h.sync.execute(id)).toEqual({ kind: "inactive" });
    expect(await h.test.execute(STORE_A, id)).toEqual({ kind: "inactive" });
    expect(h.server.seen).toHaveLength(before);
  });

  it("a SKU code of another store is never resolved for this store's channel", async () => {
    const h = createOdooHarness();
    seedCatalog(h);
    const id = await h.connectA();
    await synced(h, id);
    expect(h.stock.calls.every((c) => c.skuId !== SKU(99))).toBe(true);
    expect(h.prices.calls.every((c) => c.skuId !== SKU(99))).toBe(true);
  });
});
