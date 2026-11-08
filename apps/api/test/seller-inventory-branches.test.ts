import type { Principal } from "@outlet/policy";
import { describe, expect, it } from "vitest";
import { SellerInventoryService } from "../src/modules/seller-inventory/seller-inventory-service.js";
import { S1, U1, fakeClient } from "./fake-sql.js";
import type { Script } from "./fake-sql.js";

const MARKET = "EG";
const LOC = "00000000-0000-4000-8000-0000000000c1";
const SKU = "00000000-0000-4000-8000-0000000000d1";
const staff = (roles: string[], storeIds = [S1]): Principal => ({ kind: "seller_staff", userId: U1, marketId: MARKET, storeIds, roles, scopes: [] });
const level = (o: object = {}) => ({ sku_id: SKU, location_id: LOC, seller_sku: "A", size_label: null, title_ar: "ت", on_hand: 10, committed: 4, version: 3, updated_at: new Date("2026-01-01T00:00:00Z"), ...o });

const make = (script: Script) => {
  const f = fakeClient(script);
  const calls: unknown[] = [];
  const svc = new SellerInventoryService({
    client: f.client, marketId: MARKET, newId: () => LOC, now: () => new Date("2026-01-01T00:00:00Z"),
    inventory: { adjustOnHand: (...a: unknown[]) => { calls.push(a); return Promise.resolve(undefined as never); } },
  });
  return { svc, calls, log: f.log };
};

describe("access control", () => {
  const { svc } = make(() => []);
  it("non seller-staff principals get 403, foreign stores 404, wrong roles 403", async () => {
    await expect(svc.list({ kind: "shopper", userId: U1, marketId: MARKET, roles: [], scopes: [] }, S1, { limit: 5 })).rejects.toMatchObject({ status: 403 });
    await expect(svc.list(staff(["owner"], ["00000000-0000-4000-8000-0000000000ff"]), S1, { limit: 5 })).rejects.toMatchObject({ status: 404 });
    await expect(svc.list(staff(["finance"]), S1, { limit: 5 })).rejects.toMatchObject({ status: 403 });
    await expect(svc.adjust(staff(["warehouse"]), S1, "k", { sku_id: SKU, delta: 1, reason: "received" })).rejects.toMatchObject({ status: 403 });
    await expect(svc.adjust(staff(["owner"], []), S1, "k", { sku_id: SKU, delta: 1, reason: "received" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("list", () => {
  it("maps levels (null location, low stock, floor at zero) and pages with a cursor", async () => {
    const NIL = "00000000-0000-0000-0000-000000000000";
    const { svc, log } = make((s) => (s.includes("FROM skus s") ? [level({ location_id: NIL, on_hand: 1, committed: 5 }), level({ sku_id: "z" })] : []));
    const page = await svc.list(staff(["warehouse"]), S1, { limit: 1, sku_id: SKU, location_id: LOC, cursor: Buffer.from(`${SKU}|${LOC}`).toString("base64url") });
    expect(page.items[0]).toMatchObject({ location_id: null, available: 0, low_stock: true, version: 3 });
    expect(page.next_cursor).not.toBeNull();
    expect(log.stmts.find((x) => x.sql.includes("FROM skus s"))?.params).toEqual([S1, SKU, LOC, SKU, LOC, 2]);
    const single = await make((s) => (s.includes("FROM skus s") ? [level()] : [])).svc.list(staff(["owner"]), S1, { limit: 5 });
    expect(single).toMatchObject({ next_cursor: null, items: [{ available: 6, low_stock: false }] });
    await expect(svc.list(staff(["owner"]), S1, { limit: 5, cursor: "%%" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("adjust", () => {
  const input = { sku_id: SKU, delta: 5, reason: "damage" } as const;
  const full = (over: Partial<Record<string, object[]>> = {}): Script => (s) => {
    if (s.includes("SELECT 1 FROM skus")) return over.sku ?? [{}];
    if (s.includes("SELECT 1 FROM inventory_locations")) return over.loc ?? [{}];
    if (s.includes("SELECT id FROM inventory_locations")) return over.def ?? [{ id: LOC }];
    if (s.includes("SELECT version FROM inventory_levels")) return over.ver ?? [{ version: 3 }];
    if (s.includes("FROM skus s")) return over.row ?? [level()];
    return [];
  };
  it("404 for a SKU the store does not own and for an unknown explicit location", async () => {
    await expect(make(full({ sku: [] })).svc.adjust(staff(["owner"]), S1, "k", input)).rejects.toMatchObject({ status: 404 });
    await expect(make(full({ loc: [] })).svc.adjust(staff(["owner"]), S1, "k", { ...input, location_id: LOC })).rejects.toMatchObject({ status: 404 });
  });
  it("uses the explicit location and maps reasons to sources", async () => {
    const t = make(full());
    const lvl = await t.svc.adjust(staff(["owner"]), S1, "key-1", { ...input, location_id: LOC });
    expect(lvl.version).toBe(3);
    expect(t.calls[0]).toMatchObject({ 1: { skuId: SKU, locationId: LOC, storeId: S1, delta: 5, idempotencyKey: "key-1", source: "write_off" } });
    await t.svc.adjust(staff(["owner"]), S1, "k2", { ...input, reason: "recount" });
    expect(t.calls[1]).toMatchObject({ 1: { source: "count" } });
  });
  it("falls back to the oldest location, or creates the default one", async () => {
    const t = make(full({ def: [] }));
    await t.svc.adjust(staff(["owner"]), S1, "k", input);
    expect(t.log.stmts.some((x) => x.sql.includes("INSERT INTO inventory_locations") && x.params[0] === LOC)).toBe(true);
    const u = make(full());
    await u.svc.adjust(staff(["owner"]), S1, "k", input);
    expect(u.log.stmts.some((x) => x.sql.includes("INSERT INTO inventory_locations"))).toBe(false);
  });
  it("optimistic lock: 409 on mismatch, ok on match, a missing level counts as version 0", async () => {
    await expect(make(full()).svc.adjust(staff(["owner"]), S1, "k", { ...input, expected_version: 2 })).rejects.toMatchObject({ status: 409, code: "version-conflict" });
    await expect(make(full()).svc.adjust(staff(["owner"]), S1, "k", { ...input, expected_version: 3 })).resolves.toBeDefined();
    await expect(make(full({ ver: [] })).svc.adjust(staff(["owner"]), S1, "k", { ...input, expected_version: 0 })).resolves.toBeDefined();
    await expect(make(full({ ver: [] })).svc.adjust(staff(["owner"]), S1, "k", { ...input, expected_version: 1 })).rejects.toMatchObject({ status: 409 });
  });
  it("404 if the level is not readable after the adjustment", async () => {
    await expect(make(full({ row: [] })).svc.adjust(staff(["owner"]), S1, "k", input)).rejects.toMatchObject({ status: 404 });
  });
});
