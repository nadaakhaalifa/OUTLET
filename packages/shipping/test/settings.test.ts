import { afterEach, describe, expect, it } from "vitest";
import type { Principal } from "@outlet/policy";
import { buildWorld, errorCode, staffOf } from "./fixtures.js";
import type { World } from "./fixtures.js";

let w: World | undefined;
afterEach(async () => { await w?.close(); w = undefined; });
const world = async (): Promise<World> => (w = await buildWorld());
const ok = { freeThresholdOverrideMinor: 1_000n, allowedCouriers: ["alpha"], handlingDays: 2 };
const row = async (x: World, store: string) => (await x.raw.query<{ updated_by: string | null; free_threshold_override_minor: string | null; handling_days: number }>("SELECT updated_by, free_threshold_override_minor::text, handling_days FROM store_shipping_settings WHERE store_id = $1", [store])).rows[0];

describe("StoreShippingSettingsService", () => {
  it("get returns undefined when a store has never configured settings (override absent, not defaulted)", async () => {
    const x = await world();
    expect(await x.settings.get(staffOf(x.storeA), x.storeA)).toBeUndefined();
  });

  it("a null threshold override round-trips as null (distinct from zero) and is mirrored to the public projection", async () => {
    const x = await world();
    const s = staffOf(x.storeA);
    await x.settings.put(s, x.storeA, { ...ok, freeThresholdOverrideMinor: null });
    expect((await x.settings.get(s, x.storeA))?.freeThresholdOverrideMinor).toBeNull();
    await x.settings.put(s, x.storeA, { ...ok, freeThresholdOverrideMinor: 0n });
    expect((await x.settings.get(s, x.storeA))?.freeThresholdOverrideMinor).toBe(0n);
    const pub = await x.raw.query<{ free_threshold_override_minor: string | null }>("SELECT free_threshold_override_minor::text FROM shipping_public_store_settings WHERE store_ref = $1", [x.storeA]);
    expect(pub.rows[0]?.free_threshold_override_minor).toBe("0");
  });

  it("handling days accept the bounds 0 and 14 and reject -1, 15 and non-integers", async () => {
    const x = await world();
    const s = staffOf(x.storeA);
    for (const d of [0, 14]) { await x.settings.put(s, x.storeA, { ...ok, handlingDays: d }); expect((await x.settings.get(s, x.storeA))?.handlingDays).toBe(d); }
    for (const d of [-1, 15, 1.5]) expect(await errorCode(x.settings.put(s, x.storeA, { ...ok, handlingDays: d }))).toBe("INVALID_INPUT");
    expect((await x.settings.get(s, x.storeA))?.handlingDays).toBe(14);
  });

  it("courier list bounds: 20 entries pass, 21 fail; empty and 41-character names fail; wrong types fail", async () => {
    const x = await world();
    const s = staffOf(x.storeA);
    const list = (n: number): string[] => Array.from({ length: n }, (_, i) => `c${String(i)}`);
    await x.settings.put(s, x.storeA, { ...ok, allowedCouriers: list(20) });
    for (const bad of [list(21), [""], ["x".repeat(41)]]) expect(await errorCode(x.settings.put(s, x.storeA, { ...ok, allowedCouriers: bad }))).toBe("INVALID_INPUT");
    for (const raw of [null, "x", { ...ok, freeThresholdOverrideMinor: 5 }, { ...ok, allowedCouriers: "alpha" }, { allowedCouriers: [], handlingDays: 1 }]) expect(await errorCode(x.settings.put(s, x.storeA, raw))).toBe("INVALID_INPUT");
    expect((await x.settings.get(s, x.storeA))?.allowedCouriers).toHaveLength(20);
  });

  it("a principal with no user id still writes (updated_by NULL) and reads inside the store context", async () => {
    const x = await world();
    const anon: Principal = { ...staffOf(x.storeA) };
    delete (anon as { userId?: string }).userId;
    await x.settings.put(anon, x.storeA, ok);
    expect((await row(x, x.storeA))?.updated_by).toBeNull();
    expect(await x.settings.get(anon, x.storeA)).toMatchObject({ storeId: x.storeA, handlingDays: 2 });
  });

  it("a second put replaces the first (upsert) and records the actor", async () => {
    const x = await world();
    const s = staffOf(x.storeA);
    await x.settings.put(s, x.storeA, ok);
    await x.settings.put(s, x.storeA, { ...ok, handlingDays: 7, freeThresholdOverrideMinor: 9n });
    expect(await row(x, x.storeA)).toEqual({ updated_by: s.userId, free_threshold_override_minor: "9", handling_days: 7 });
    expect((await x.raw.query("SELECT 1 FROM store_shipping_settings WHERE store_id = $1", [x.storeA])).rows).toHaveLength(1);
  });

  it("negative authorization: shoppers, anonymous callers and other stores' staff are denied and nothing is written", async () => {
    const x = await world();
    const shopper: Principal = { kind: "shopper", userId: x.user, marketId: "EG", roles: [], scopes: [] };
    const anonymous: Principal = { kind: "anonymous", marketId: "EG", roles: [], scopes: [] };
    for (const who of [shopper, anonymous, staffOf(x.storeB)]) expect(["not_found", "forbidden"]).toContain(await errorCode(x.settings.put(who, x.storeA, ok)));
    expect(await row(x, x.storeA)).toBeUndefined();
  });

  it("negative authorization (read): the seller-private settings of a store with data are invisible to shoppers, anonymous callers and other stores' staff", async () => {
    const x = await world();
    await x.settings.put(staffOf(x.storeA), x.storeA, ok);
    const shopper: Principal = { kind: "shopper", userId: x.user, marketId: "EG", roles: [], scopes: [] };
    const anonymous: Principal = { kind: "anonymous", marketId: "EG", roles: [], scopes: [] };
    for (const who of [shopper, anonymous, staffOf(x.storeB)]) expect(["not_found", "forbidden"]).toContain(await errorCode(x.settings.get(who, x.storeA)));
  });
});
