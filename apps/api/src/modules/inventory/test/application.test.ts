import { beforeEach, describe, expect, it } from "vitest";
import { FAWRY_POOL_ID, InMemoryInventoryStore, InMemorySkuDirectory, STANDARD_POOL_ID } from "../adapters/in-memory";
import { DROP_1, DROP_POOL_1, LOC_A, SKU_A1, SKU_A2, STORE_A, STORE_B, U, USER_1 } from "./fixtures";
import { ClaimReservation, ReleaseReservation, SweepExpiredReservations } from "../application/lifecycle";
import { ReserveStock } from "../application/reserve-stock";
import { SyncSellerStock } from "../application/sync-stock";
import { TransferBetweenPools } from "../application/transfer-pool";

class Clock {
  constructor(public ms = 1_800_000_000_000) {}
  nowMs(): number {
    return this.ms;
  }
}

let n = 0;
const newId = (): string => U(0x50000 + (n += 1));

interface Ctx {
  clock: Clock;
  store: InMemoryInventoryStore;
  dir: InMemorySkuDirectory;
  reserve: ReserveStock;
  claim: ClaimReservation;
  release: ReleaseReservation;
  sweep: SweepExpiredReservations;
  sync: SyncSellerStock;
  transfer: TransferBetweenPools;
}

const setup = (): Ctx => {
  const clock = new Clock();
  const store = new InMemoryInventoryStore(newId);
  const dir = new InMemorySkuDirectory();
  dir.register(SKU_A1, { storeId: STORE_A, locationId: LOC_A, dropId: null });
  dir.register(SKU_A2, { storeId: STORE_A, locationId: LOC_A, dropId: DROP_1 });
  store.registerDropPool(DROP_1, DROP_POOL_1);
  return {
    clock,
    store,
    dir,
    reserve: new ReserveStock(store, dir, clock, { newId }),
    claim: new ClaimReservation(store, clock),
    release: new ReleaseReservation(store, clock),
    sweep: new SweepExpiredReservations(store, clock),
    sync: new SyncSellerStock(store, dir, clock, STANDARD_POOL_ID),
    transfer: new TransferBetweenPools(store, dir, clock, { standard: STANDARD_POOL_ID, fawry: FAWRY_POOL_ID }),
  };
};

let c: Ctx;
beforeEach(() => {
  c = setup();
});

const stock = async (sku: string, qty: number, key: string): Promise<void> => {
  const r = await c.sync.execute({
    skuId: sku,
    actorStoreIds: [STORE_A],
    actorId: "seller-1",
    actorType: "seller",
    mode: "set",
    quantity: qty,
    reason: "received",
    idempotencyKey: key,
  });
  expect(r.kind).toBe("applied");
};

const og = (k: number): string => U(0x7000 + k);

describe("ReserveStock", () => {
  it.each([
    ["CARD", 600],
    ["WALLET", 1800],
    ["BNPL", 900],
    ["COD", 600],
  ] as const)("holds %s for %i s", async (paymentMethod, secs) => {
    await stock(SKU_A1, 5, "s1");
    const r = await c.reserve.execute({ orderGroupId: og(1), userId: USER_1, paymentMethod, lines: [{ skuId: SKU_A1, qty: 1 }] });
    expect(r).toMatchObject({ kind: "reserved", replayed: false });
    if (r.kind === "reserved") expect(Date.parse(r.expiresAt)).toBe(c.clock.ms + secs * 1000);
  });

  it("Fawry draws from the Fawry pool for 24 h and never from STANDARD", async () => {
    await stock(SKU_A1, 4, "s1");
    expect((await c.reserve.execute({ orderGroupId: og(1), userId: USER_1, paymentMethod: "FAWRY", lines: [{ skuId: SKU_A1, qty: 1 }] })).kind).toBe("insufficient");
    expect(await c.transfer.execute({ skuId: SKU_A1, toPool: "FAWRY", qty: 2, idempotencyKey: "t1" })).toEqual({ status: "transferred", replayed: false });
    const r = await c.reserve.execute({ orderGroupId: og(2), userId: USER_1, paymentMethod: "FAWRY", lines: [{ skuId: SKU_A1, qty: 1 }] });
    expect(r.kind).toBe("reserved");
    if (r.kind === "reserved") expect(Date.parse(r.expiresAt)).toBe(c.clock.ms + 86_400_000);
    expect(c.store.model.level(SKU_A1, LOC_A, FAWRY_POOL_ID)).toMatchObject({ onHand: 2, reserved: 1 });
    expect(c.store.model.level(SKU_A1, LOC_A, STANDARD_POOL_ID)).toMatchObject({ onHand: 2, reserved: 0 });
  });

  it("refuses a drop SKU for Fawry and serves it from the drop pool otherwise", async () => {
    expect(await c.reserve.execute({ orderGroupId: og(1), userId: USER_1, paymentMethod: "FAWRY", lines: [{ skuId: SKU_A2, qty: 1 }] })).toEqual({
      kind: "invalid",
      code: "drop_sku_not_allowed_for_fawry",
      skuId: SKU_A2,
    });
    // drop pool stock arrives by pool-level sync; seed through the model for the test
    c.store.model.applySync({ skuId: SKU_A2, locationId: LOC_A, poolId: DROP_POOL_1, storeId: STORE_A, mode: "set", quantity: 3, reason: "received", idempotencyKey: "d", actorType: "system", actorId: "x", nowMs: 0 });
    expect((await c.reserve.execute({ orderGroupId: og(2), userId: USER_1, paymentMethod: "CARD", lines: [{ skuId: SKU_A2, qty: 2 }] })).kind).toBe("reserved");
    expect(c.store.model.level(SKU_A2, LOC_A, DROP_POOL_1)).toMatchObject({ reserved: 2, available: 1 });
  });

  it("reports unknown SKUs, bad input and shortfalls without holding anything", async () => {
    await stock(SKU_A1, 1, "s1");
    expect(await c.reserve.execute({ orderGroupId: og(1), userId: USER_1, paymentMethod: "CARD", lines: [{ skuId: U(0xbad), qty: 1 }] })).toEqual({
      kind: "invalid",
      code: "unknown_sku",
      skuId: U(0xbad),
    });
    expect((await c.reserve.execute({ orderGroupId: "nope", userId: USER_1, paymentMethod: "CARD", lines: [] })).kind).toBe("invalid");
    const r = await c.reserve.execute({ orderGroupId: og(2), userId: USER_1, paymentMethod: "CARD", lines: [{ skuId: SKU_A1, qty: 2 }] });
    expect(r).toMatchObject({ kind: "insufficient", shortfalls: [{ skuId: SKU_A1, requested: 2, available: 1 }] });
    expect(c.store.model.level(SKU_A1, LOC_A, STANDARD_POOL_ID)).toMatchObject({ reserved: 0, available: 1 });
  });

  it("one reservation per order group: replay returns it, different lines conflict", async () => {
    await stock(SKU_A1, 5, "s1");
    const a = await c.reserve.execute({ orderGroupId: og(1), userId: USER_1, paymentMethod: "CARD", lines: [{ skuId: SKU_A1, qty: 2 }] });
    const b = await c.reserve.execute({ orderGroupId: og(1), userId: USER_1, paymentMethod: "CARD", lines: [{ skuId: SKU_A1, qty: 2 }] });
    expect(a.kind).toBe("reserved");
    expect(b).toMatchObject({ kind: "reserved", replayed: true });
    if (a.kind === "reserved" && b.kind === "reserved") expect(b.reservationId).toBe(a.reservationId);
    expect((await c.reserve.execute({ orderGroupId: og(1), userId: USER_1, paymentMethod: "CARD", lines: [{ skuId: SKU_A1, qty: 3 }] })).kind).toBe("conflict");
    expect(c.store.model.level(SKU_A1, LOC_A, STANDARD_POOL_ID)).toMatchObject({ reserved: 2 });
  });
});

describe("claim, release, sweep", () => {
  it("claims, then is idempotent", async () => {
    await stock(SKU_A1, 3, "s1");
    await c.reserve.execute({ orderGroupId: og(1), userId: USER_1, paymentMethod: "CARD", lines: [{ skuId: SKU_A1, qty: 2 }] });
    expect(await c.claim.execute({ orderGroupId: og(1) })).toEqual({ status: "claimed" });
    expect(await c.claim.execute({ orderGroupId: og(1) })).toEqual({ status: "already_claimed" });
    expect(await c.claim.execute({ orderGroupId: og(99) })).toEqual({ status: "not_found" });
    expect(await c.claim.execute({ orderGroupId: "bad" })).toEqual({ status: "invalid_input" });
    expect(c.store.events.filter((e) => e.type === "inventory.claimed")).toHaveLength(1);
  });

  it("release after claim is a no-op: claimed stock is never returned by a payment-failure compensation", async () => {
    await stock(SKU_A1, 3, "s1");
    await c.reserve.execute({ orderGroupId: og(1), userId: USER_1, paymentMethod: "CARD", lines: [{ skuId: SKU_A1, qty: 1 }] });
    await c.claim.execute({ orderGroupId: og(1) });
    expect(await c.release.execute({ orderGroupId: og(1) }, "payment_failed")).toEqual({ status: "noop", reservationStatus: "CLAIMED" });
    expect(c.store.model.level(SKU_A1, LOC_A, STANDARD_POOL_ID)).toMatchObject({ committed: 1, available: 2 });
  });

  it("expiry returns stock; a late payment auto-claims if stock remains, else reports unavailable", async () => {
    await stock(SKU_A1, 1, "s1");
    await c.reserve.execute({ orderGroupId: og(1), userId: USER_1, paymentMethod: "CARD", lines: [{ skuId: SKU_A1, qty: 1 }] });
    c.clock.ms += 600_000;
    expect(await c.sweep.execute()).toEqual({ expiredReservations: 1, releasedUnits: 1 });
    // someone else takes the unit before the late payment arrives
    await c.reserve.execute({ orderGroupId: og(2), userId: USER_1, paymentMethod: "CARD", lines: [{ skuId: SKU_A1, qty: 1 }] });
    expect(await c.claim.execute({ orderGroupId: og(1) })).toMatchObject({ status: "unavailable" });
    await c.release.execute({ orderGroupId: og(2) }, "cancelled");
    expect(await c.claim.execute({ orderGroupId: og(1) })).toEqual({ status: "claimed_late" });
  });
});

describe("SyncSellerStock", () => {
  it("is idempotent, version guarded, and never lets one tenant touch another's SKU", async () => {
    await stock(SKU_A1, 5, "s1");
    const base = { skuId: SKU_A1, actorStoreIds: [STORE_A], actorId: "s", actorType: "seller" as const, reason: "recount" as const };
    const again = await c.sync.execute({ ...base, mode: "set", quantity: 5, idempotencyKey: "s1" });
    expect(again).toMatchObject({ kind: "applied", replayed: true });
    expect(await c.sync.execute({ ...base, mode: "set", quantity: 6, idempotencyKey: "s2", expectedVersion: 0 })).toEqual({ kind: "version_conflict", currentVersion: 1 });
    expect(await c.sync.execute({ ...base, actorStoreIds: [STORE_B], mode: "set", quantity: 6, idempotencyKey: "s3" })).toEqual({ kind: "not_found" });
    expect(await c.sync.execute({ ...base, mode: "adjust", quantity: -6, idempotencyKey: "s4" })).toEqual({ kind: "negative", wouldBe: -1 });
    expect(await c.sync.execute({ ...base, mode: "adjust", quantity: 0, idempotencyKey: "s5" })).toEqual({ kind: "invalid_input" });
  });

  it("channel sync ignores a stale source version", async () => {
    const base = { skuId: SKU_A1, actorStoreIds: [STORE_A], actorId: "shopify", actorType: "channel" as const, reason: "channel_sync" as const, mode: "set" as const };
    expect((await c.sync.execute({ ...base, quantity: 9, idempotencyKey: "c1", sourceVersion: 10 })).kind).toBe("applied");
    expect(await c.sync.execute({ ...base, quantity: 3, idempotencyKey: "c2", sourceVersion: 9 })).toEqual({ kind: "stale", currentSourceVersion: 10 });
    expect(c.store.model.level(SKU_A1, LOC_A, STANDARD_POOL_ID)?.onHand).toBe(9);
  });
});
