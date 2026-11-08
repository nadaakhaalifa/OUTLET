import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { countQueries } from "../src/testing.js";
import { CartService, pgInventoryAvailability } from "../src/index.js";
import type { AvailabilityPort } from "../src/index.js";
import { buildWorld, errorCode, staffOf } from "./fixtures.js";
import type { World } from "./fixtures.js";

let w: World | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});
const world = async (...a: Parameters<typeof buildWorld>): Promise<World> => (w = await buildWorld(...a));
const key = (): string => randomUUID();

describe("add, merge, limits", () => {
  it("adds with the live price, merges qty, and keeps the first price_at_add", async () => {
    const x = await world();
    const s = await x.seedSku(x.storeA, 50_000);
    const r1 = await x.svc.addLine(x.userA, { skuId: s.skuId, qty: 2 }, key());
    expect(r1).toMatchObject({ qty: 2, merged: false });
    await x.setPrice(s, 40_000);
    const r2 = await x.svc.addLine(x.userA, { skuId: s.skuId, qty: 3 }, key());
    expect(r2).toMatchObject({ lineId: r1.lineId, qty: 5, merged: true });
    const v = await x.svc.get(x.userA);
    expect(v.groups).toHaveLength(1);
    const lv = v.groups[0]?.lines[0];
    expect(lv?.line.priceAtAddMinor).toBe(50_000n);
    expect(lv?.state).toBe("price_dropped");
    expect(v.itemsSubtotal.amountMinor).toBe(200_000n);
    expect(v.version).toBeGreaterThan(1);
  });

  it("enforces 10 units per sku, 50 lines, qty range and unknown skus", async () => {
    const x = await world();
    const s = await x.seedSku(x.storeA, 1_000);
    await x.svc.addLine(x.userA, { skuId: s.skuId, qty: 8 }, key());
    expect(await errorCode(x.svc.addLine(x.userA, { skuId: s.skuId, qty: 3 }, key()))).toBe("qty_limit");
    expect(await errorCode(x.svc.addLine(x.userA, { skuId: s.skuId, qty: 0 }, key()))).toBe("invalid_qty");
    expect(await errorCode(x.svc.addLine(x.userA, { skuId: randomUUID(), qty: 1 }, key()))).toBe("not_found");
    for (let i = 0; i < 49; i++) await x.svc.addLine(x.userA, { skuId: (await x.seedSku(x.storeA, 100)).skuId, qty: 1 }, key());
    expect(await errorCode(x.svc.addLine(x.userA, { skuId: (await x.seedSku(x.storeA, 100)).skuId, qty: 1 }, key()))).toBe("line_limit");
  });

  it("refuses an item whose listing is sold out", async () => {
    const x = await world();
    const s = await x.seedSku(x.storeA, 1_000);
    await x.setListingStatus(s, "SOLD_OUT");
    expect(await errorCode(x.svc.addLine(x.userA, { skuId: s.skuId, qty: 1 }, key()))).toBe("unavailable");
  });
});

describe("idempotency and outbox", () => {
  it("replays the same key without merging twice; a different body under the same key is a conflict", async () => {
    const x = await world();
    const s = await x.seedSku(x.storeA, 1_000);
    const k = key();
    const a = await x.svc.addLine(x.userA, { skuId: s.skuId, qty: 2 }, k);
    const b = await x.svc.addLine(x.userA, { skuId: s.skuId, qty: 2 }, k);
    expect(b).toEqual(a);
    expect((await x.svc.get(x.userA)).groups[0]?.lines[0]?.line.qty).toBe(2);
    expect(await errorCode(x.svc.addLine(x.userA, { skuId: s.skuId, qty: 4 }, k))).toBe("idempotency_conflict");
    expect((await x.events()).filter((e) => e.type === "cart.line_added")).toHaveLength(1);
  });

  it("a rejected add leaves no event and no line (outbox is in the same transaction)", async () => {
    const x = await world();
    const s = await x.seedSku(x.storeA, 1_000);
    await x.svc.addLine(x.userA, { skuId: s.skuId, qty: 9 }, key());
    await errorCode(x.svc.addLine(x.userA, { skuId: s.skuId, qty: 5 }, key()));
    expect((await x.events()).filter((e) => e.type === "cart.line_added")).toHaveLength(1);
  });

  it("emits free_delivery_unlocked only when the add crosses the store threshold (1,950 + 60 EGP)", async () => {
    const x = await world();
    const big = await x.seedSku(x.storeA, 195_000);
    const small = await x.seedSku(x.storeA, 6_000);
    await x.svc.addLine(x.userA, { skuId: big.skuId, qty: 1 }, key());
    expect((await x.events()).some((e) => e.type === "cart.free_delivery_unlocked")).toBe(false);
    await x.svc.addLine(x.userA, { skuId: small.skuId, qty: 1 }, key());
    const ev = (await x.events()).filter((e) => e.type === "cart.free_delivery_unlocked");
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({ store_id: x.storeA, threshold_minor: "200000" });
    const g = (await x.svc.get(x.userA)).groups[0];
    expect(g?.freeDelivery).toMatchObject({ unlocked: true, remainingMinor: 0n });
    await x.svc.addLine(x.userA, { skuId: small.skuId, qty: 1 }, key());
    expect((await x.events()).filter((e) => e.type === "cart.free_delivery_unlocked")).toHaveLength(1);
    const b = await x.seedSku(x.storeB, 210_000);
    await x.svc.addLine(x.userA, { skuId: b.skuId, qty: 1 }, key());
    const groups = (await x.svc.get(x.userA)).groups;
    expect(groups.map((g) => g.freeDelivery.unlocked)).toEqual([true, true]);
  });
});

describe("user isolation", () => {
  it("user B cannot see, change or remove user A's cart", async () => {
    const x = await world();
    const s = await x.seedSku(x.storeA, 1_000);
    const { lineId } = await x.svc.addLine(x.userA, { skuId: s.skuId, qty: 1 }, key());
    expect((await x.svc.get(x.userB)).groups).toHaveLength(0);
    expect(await errorCode(x.svc.updateQty(x.userB, lineId, 2))).toBe("not_found");
    expect(await errorCode(x.svc.removeLine(x.userB, lineId))).toBe("not_found");
    await x.svc.clear(x.userB);
    expect((await x.svc.get(x.userA)).groups[0]?.lines).toHaveLength(1);
    const raw = await x.app.query<{ n: string }>("SELECT count(*)::text AS n FROM cart_lines");
    expect(raw.rows[0]?.n).toBe("0"); // no context at all: nothing visible
  });

  it("each user owns one active cart per market", async () => {
    const x = await world();
    const s = await x.seedSku(x.storeA, 1_000);
    await x.svc.addLine(x.userA, { skuId: s.skuId, qty: 1 }, key());
    await x.svc.addLine(x.userB, { skuId: s.skuId, qty: 2 }, key());
    const carts = await x.raw.query<{ n: string }>("SELECT count(*)::text AS n FROM carts");
    expect(carts.rows[0]?.n).toBe("2");
    await expect(x.raw.query("INSERT INTO carts (id, user_id, market_id, currency) VALUES ($1,$2,'EG','EGP')", [randomUUID(), x.userA])).rejects.toThrow();
  });
});

describe("update, remove, clear", () => {
  it("updates qty within range, removes a line and clears the bag", async () => {
    const x = await world();
    const s = await x.seedSku(x.storeA, 1_000);
    const t = await x.seedSku(x.storeB, 2_000);
    const a = await x.svc.addLine(x.userA, { skuId: s.skuId, qty: 1 }, key());
    await x.svc.addLine(x.userA, { skuId: t.skuId, qty: 1 }, key());
    await x.svc.updateQty(x.userA, a.lineId, 10);
    expect(await errorCode(x.svc.updateQty(x.userA, a.lineId, 11))).toBe("invalid_qty");
    expect((await x.svc.get(x.userA)).groups[0]?.lines[0]?.line.qty).toBe(10);
    await x.svc.removeLine(x.userA, a.lineId);
    expect((await x.svc.get(x.userA)).groups).toHaveLength(1);
    await x.svc.clear(x.userA);
    expect((await x.svc.get(x.userA)).groups).toHaveLength(0);
    await x.svc.clear(x.userA);
  });

  it("an empty bag is a valid view without creating a cart", async () => {
    const x = await world();
    const v = await x.svc.get(x.userA);
    expect(v).toMatchObject({ id: null, groups: [], notices: [] });
    expect((await x.raw.query("SELECT 1 FROM carts")).rows).toHaveLength(0);
  });
});

describe("states against live data", () => {
  it("shows price drop and rise honestly, and the notices", async () => {
    const x = await world();
    const s = await x.seedSku(x.storeA, 10_000);
    const t = await x.seedSku(x.storeA, 10_000);
    await x.svc.addLine(x.userA, { skuId: s.skuId, qty: 1 }, key());
    await x.svc.addLine(x.userA, { skuId: t.skuId, qty: 1 }, key());
    await x.setPrice(s, 8_000);
    await x.setPrice(t, 12_000);
    const v = await x.svc.get(x.userA);
    expect(v.groups[0]?.lines.map((l) => l.state)).toEqual(["price_dropped", "price_rose"]);
    expect(v.notices.map((n) => n.code)).toEqual(["price_dropped", "price_rose"]);
    expect(v.itemsSubtotal.amountMinor).toBe(20_000n);
  });

  it("an item whose inventory level is 0 becomes unavailable; checkout continues with the rest", async () => {
    const x = await world({ availability: "inventory" });
    const s = await x.seedSku(x.storeA, 10_000, 3);
    const t = await x.seedSku(x.storeA, 5_000, 3);
    await x.svc.addLine(x.userA, { skuId: s.skuId, qty: 1 }, key());
    await x.svc.addLine(x.userA, { skuId: t.skuId, qty: 1 }, key());
    await x.setStock(s, 0);
    const v = await x.svc.get(x.userA);
    expect(v.groups[0]?.lines.map((l) => l.state)).toEqual(["unavailable", "ok"]);
    expect(v.itemsSubtotal.amountMinor).toBe(5_000n);
  });

  it("a sold-out listing is unavailable, a paused store locks the group and refreshPrices emits line_unavailable once", async () => {
    const x = await world();
    const s = await x.seedSku(x.storeA, 10_000);
    const t = await x.seedSku(x.storeB, 5_000);
    await x.svc.addLine(x.userA, { skuId: s.skuId, qty: 1 }, key());
    await x.svc.addLine(x.userA, { skuId: t.skuId, qty: 1 }, key());
    await x.setListingStatus(s, "SOLD_OUT");
    await x.suspendStore(x.storeB);
    const v = await x.svc.refreshPrices(x.userA);
    expect(v.groups.map((g) => [g.locked, g.lines[0]?.state])).toEqual([[false, "unavailable"], [true, "store_locked"]]);
    expect(v.notices.map((n) => n.code)).toEqual(["unavailable", "store_suspended"]);
    expect(v.itemsSubtotal.amountMinor).toBe(0n);
    await x.svc.refreshPrices(x.userA);
    expect((await x.events()).filter((e) => e.type === "cart.line_unavailable")).toHaveLength(2);
  });
});

describe("thresholds", () => {
  it("defaults to EGP 2,000, honours a per-store row set by the store owner, and denies others", async () => {
    const x = await world();
    expect(await x.svc.thresholdFor(x.storeA)).toBe(200_000n);
    await x.svc.setThreshold(staffOf(x.storeA), x.storeA, 50_000n);
    expect(await x.svc.thresholdFor(x.storeA)).toBe(50_000n);
    await x.svc.setThreshold(staffOf(x.storeA), x.storeA, 60_000n);
    expect(await x.svc.thresholdFor(x.storeA)).toBe(60_000n);
    expect(await x.svc.thresholdFor(x.storeB)).toBe(200_000n);
    expect(await errorCode(x.svc.setThreshold(staffOf(x.storeA), x.storeB, 1n))).toBe("not_found");
    expect(await errorCode(x.svc.setThreshold(staffOf(x.storeA, ["catalog"]), x.storeA, 1n))).toBe("forbidden");
    expect(await errorCode(x.svc.setThreshold(staffOf(x.storeA), x.storeA, -1n))).toBe("invalid_qty");
    const s = await x.seedSku(x.storeA, 70_000);
    await x.svc.addLine(x.userA, { skuId: s.skuId, qty: 1 }, key());
    expect((await x.svc.get(x.userA)).groups[0]?.freeDelivery).toMatchObject({ thresholdMinor: 60_000n, unlocked: true });
  });

  it("the admin default is configurable", async () => {
    const x = await world({ defaultThresholdMinor: 1_000n });
    const s = await x.seedSku(x.storeA, 1_500);
    await x.svc.addLine(x.userA, { skuId: s.skuId, qty: 1 }, key());
    expect((await x.svc.get(x.userA)).groups[0]?.freeDelivery.unlocked).toBe(true);
    expect(new CartService(x.deps)).toBeInstanceOf(CartService);
  });
});

describe("query counts", () => {
  const stub: AvailabilityPort = { availableSkus: (q) => Promise.resolve(new Set([...q.skuIdsByStore.values()].flat())) };

  it("get is 3 statements regardless of lines and stores (stock check behind a port)", async () => {
    const x = await world({ availability: stub });
    const counts: number[] = [];
    for (let i = 0; i < 3; i++) {
      for (const store of [x.storeA, x.storeB]) await x.svc.addLine(x.userA, { skuId: (await x.seedSku(store, 1_000)).skuId, qty: 1 }, key());
      const r = await countQueries(x.app, (c) => new CartService({ ...x.deps, client: c }).get(x.userA));
      counts.push(r.count);
      expect(r.result.groups.flatMap((g) => g.lines)).toHaveLength((i + 1) * 2);
    }
    expect(counts).toEqual([3, 3, 3]);
  });

  it("the inventory adapter costs one statement per store, not per line", async () => {
    const x = await world({ availability: "inventory" });
    for (let i = 0; i < 4; i++) await x.svc.addLine(x.userA, { skuId: (await x.seedSku(x.storeA, 1_000)).skuId, qty: 1 }, key());
    await x.svc.addLine(x.userA, { skuId: (await x.seedSku(x.storeB, 1_000)).skuId, qty: 1 }, key());
    const r = await countQueries(x.app, (c) => new CartService({ ...x.deps, client: c, availability: pgInventoryAvailability(c, "EG") }).get(x.userA));
    expect(r.count).toBe(3 + 2);
  });

  it("an empty bag costs one statement", async () => {
    const x = await world();
    const r = await countQueries(x.app, (c) => new CartService({ ...x.deps, client: c }).get(x.userA));
    expect(r.count).toBe(1);
  });
});
