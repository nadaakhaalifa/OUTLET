import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TTL_POLICIES,
  MAX_RESERVATION_LINES,
  POOL_CAP,
  StockModel,
  displayableStock,
  planReservation,
  planStockSync,
  rebalanceDelta,
  selectPolicy,
  targetPoolRows,
  type PaymentMethod,
  type ReservePlan,
  type ReservePlanContext,
  type ReserveRequestLine,
} from "./index";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const STANDARD = U(501);
const FAWRY = U(502);
const DROP_POOL = U(503);
const LOC = U(900);
const STORE = U(800);
const ctx: ReservePlanContext = {
  policies: DEFAULT_TTL_POLICIES,
  standardPoolId: STANDARD,
  fawryPoolId: FAWRY,
  dropPoolIds: new Map([[U(77), DROP_POOL]]),
};
const line = (n: number, qty = 1, dropId: string | null = null): ReserveRequestLine => ({
  skuId: U(n),
  locationId: LOC,
  storeId: STORE,
  qty,
  dropId,
});
const planOrThrow = (method: PaymentMethod, lines: ReserveRequestLine[]): ReservePlan => {
  const r = planReservation(method, lines, ctx);
  if (!r.ok) throw new Error(`plan failed: ${r.error.code}`);
  return r.plan;
};
const mkModel = (cap?: number): StockModel => {
  let n = 100_000;
  return new StockModel({ newUnitId: () => U((n += 1)), ...(cap === undefined ? {} : { poolCap: cap }) });
};
const seed = (m: StockModel, sku: number, qty: number, pool = STANDARD): void => {
  const r = m.applySync({
    skuId: U(sku), locationId: LOC, poolId: pool, storeId: STORE, mode: "set", quantity: qty, reason: "received",
    idempotencyKey: `seed-${sku}-${pool}-${qty}`, actorType: "system", actorId: "t", nowMs: 0,
  });
  if (r.status !== "applied") throw new Error("seed failed");
};

describe("ttl policy (ADR-0011)", () => {
  it.each([
    ["CARD", 600, "STANDARD"],
    ["APPLE_PAY", 600, "STANDARD"],
    ["COD", 600, "STANDARD"],
    ["BNPL", 900, "STANDARD"],
    ["WALLET", 1800, "STANDARD"],
    ["INSTAPAY", 1800, "STANDARD"],
    ["FAWRY", 86_400, "FAWRY"],
  ] as const)("%s holds %i s on %s", (method, ttl, pool) => {
    const plan = planOrThrow(method, [line(1)]);
    expect(plan.ttlSeconds).toBe(ttl);
    expect(plan.poolKind).toBe(pool);
  });

  it("uses the highest policy version and fails closed without a policy", () => {
    const first = DEFAULT_TTL_POLICIES[0];
    if (first === undefined) throw new Error("no default policy");
    const newer = { ...first, version: 2, ttlSeconds: 120 };
    expect(selectPolicy("CARD", [...DEFAULT_TTL_POLICIES, newer])?.ttlSeconds).toBe(120);
    expect(selectPolicy("CARD", [])).toBeNull();
    const r = planReservation("CARD", [line(1)], { ...ctx, policies: [] });
    expect(r).toEqual({ ok: false, error: { code: "no_ttl_policy" } });
  });
});

describe("planReservation", () => {
  it("sorts lines by sku so every transaction locks in the same order", () => {
    const plan = planOrThrow("CARD", [line(9), line(2), line(5)]);
    expect(plan.lines.map((l) => l.skuId)).toEqual([U(2), U(5), U(9)]);
  });

  it("is order independent: same fingerprint for any permutation", () => {
    fc.assert(
      fc.property(fc.shuffledSubarray([1, 2, 3, 4, 5, 6], { minLength: 1 }), (skus) => {
        const a = planOrThrow("CARD", skus.map((s) => line(s)));
        const b = planOrThrow("CARD", [...skus].reverse().map((s) => line(s)));
        expect(a.fingerprint).toBe(b.fingerprint);
      }),
    );
  });

  it("rejects bad quantities, duplicates, oversize requests and Fawry for drop SKUs", () => {
    expect(planReservation("CARD", [], ctx)).toEqual({ ok: false, error: { code: "empty_request" } });
    expect(planReservation("CARD", [line(1, 0)], ctx)).toMatchObject({ ok: false, error: { code: "invalid_quantity" } });
    expect(planReservation("CARD", [line(1, 1.5)], ctx)).toMatchObject({ ok: false, error: { code: "invalid_quantity" } });
    expect(planReservation("CARD", [line(1, 11)], ctx)).toMatchObject({ ok: false, error: { code: "quantity_over_limit" } });
    expect(planReservation("FAWRY", [line(1, 3)], ctx)).toMatchObject({ ok: false, error: { code: "quantity_over_limit" } });
    expect(planReservation("CARD", [line(1), line(1)], ctx)).toMatchObject({ ok: false, error: { code: "duplicate_sku" } });
    expect(planReservation("FAWRY", [line(1, 1, U(77))], ctx)).toMatchObject({
      ok: false,
      error: { code: "drop_sku_not_allowed_for_fawry" },
    });
    expect(planReservation("CARD", [line(1, 1, U(78))], ctx)).toMatchObject({ ok: false, error: { code: "unknown_drop_pool" } });
    const many = Array.from({ length: MAX_RESERVATION_LINES + 1 }, (_, i) => line(i + 1));
    expect(planReservation("CARD", many, ctx)).toEqual({ ok: false, error: { code: "too_many_lines" } });
  });

  it("routes drop SKUs to their own pool and Fawry to the Fawry pool", () => {
    expect(planOrThrow("CARD", [line(1, 1, U(77))]).lines[0]?.poolId).toBe(DROP_POOL);
    expect(planOrThrow("FAWRY", [line(1)]).lines[0]?.poolId).toBe(FAWRY);
    expect(planOrThrow("CARD", [line(1)]).lines[0]?.poolId).toBe(STANDARD);
  });
});

describe("pool maths", () => {
  it("caps at 1000 and never goes negative", () => {
    expect(targetPoolRows(5000, 0, 0)).toBe(POOL_CAP);
    expect(targetPoolRows(10, 4, 3)).toBe(3);
    expect(targetPoolRows(3, 4, 0)).toBe(0);
    expect(rebalanceDelta(10, 4)).toEqual({ insert: 6, remove: 0 });
    expect(rebalanceDelta(2, 4)).toEqual({ insert: 0, remove: 2 });
  });

  it("shows real stock only at 5 or fewer and never zero", () => {
    expect(displayableStock(5, 0, 0)).toBe(5);
    expect(displayableStock(6, 0, 0)).toBeNull();
    expect(displayableStock(3, 3, 0)).toBeNull();
    expect(displayableStock(10, 4, 3)).toBe(3);
  });
});

describe("planStockSync", () => {
  const base = { onHand: 10, committed: 4, reserved: 3, syncVersion: 7, sourceVersion: 20 };
  it("applies set and adjust and flags oversell on decrease", () => {
    expect(planStockSync(base, { mode: "set", quantity: 5 })).toMatchObject({ kind: "apply", newOnHand: 5, oversoldUnits: 2, newSyncVersion: 8 });
    expect(planStockSync(base, { mode: "adjust", quantity: 5 })).toMatchObject({ kind: "apply", newOnHand: 15, oversoldUnits: 0 });
    expect(planStockSync(base, { mode: "adjust", quantity: -11 })).toEqual({ kind: "negative", wouldBe: -1 });
  });
  it("guards versions", () => {
    expect(planStockSync(base, { mode: "set", quantity: 1, sourceVersion: 20 })).toEqual({ kind: "stale", currentSourceVersion: 20 });
    expect(planStockSync(base, { mode: "set", quantity: 1, sourceVersion: 19 })).toMatchObject({ kind: "stale" });
    expect(planStockSync(base, { mode: "set", quantity: 8, sourceVersion: 21 })).toMatchObject({ kind: "apply" });
    expect(planStockSync(base, { mode: "set", quantity: 8, expectedVersion: 6 })).toEqual({ kind: "version_conflict", currentVersion: 7 });
  });
  it("creates a level from nothing", () => {
    expect(planStockSync(null, { mode: "set", quantity: 3 })).toMatchObject({ kind: "apply", newOnHand: 3, newSyncVersion: 1 });
    expect(planStockSync(null, { mode: "adjust", quantity: -1 })).toMatchObject({ kind: "negative" });
  });
});

describe("StockModel scenarios", () => {
  it("reserves, claims, and is idempotent per order group", () => {
    const m = mkModel();
    seed(m, 1, 5);
    const plan = planOrThrow("CARD", [line(1, 2)]);
    const r = m.reserve({ reservationId: U(1000), orderGroupId: U(2000), userId: U(3), plan, nowMs: 1000 });
    expect(r).toMatchObject({ status: "reserved", replayed: false, expiresAtMs: 1000 + 600_000 });
    expect(m.reserve({ reservationId: U(1001), orderGroupId: U(2000), userId: U(3), plan, nowMs: 2000 })).toMatchObject({
      status: "reserved",
      replayed: true,
      reservationId: U(1000),
    });
    const other = planOrThrow("CARD", [line(1, 3)]);
    expect(m.reserve({ reservationId: U(1002), orderGroupId: U(2000), userId: U(3), plan: other, nowMs: 2000 })).toEqual({ status: "conflict" });
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ onHand: 5, reserved: 2, available: 3 });
    expect(m.claim(U(2000), 3000)).toEqual({ status: "claimed" });
    expect(m.claim(U(2000), 3001)).toEqual({ status: "already_claimed" });
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ committed: 2, reserved: 0, available: 3 });
    expect(m.checkInvariants()).toEqual([]);
  });

  it("R-2: unclaim returns CLAIMED units to AVAILABLE, is idempotent, and keeps the invariants", () => {
    const m = mkModel();
    seed(m, 1, 5);
    const plan = planOrThrow("CARD", [line(1, 2)]);
    m.reserve({ reservationId: U(1000), orderGroupId: U(2000), userId: U(3), plan, nowMs: 1000 });
    expect(m.claim(U(2000), 3000)).toEqual({ status: "claimed" });
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ committed: 2, available: 3 });
    expect(m.unclaim(U(2000), "payment_failed", 4000)).toEqual({ status: "unclaimed" });
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ onHand: 5, committed: 0, reserved: 0, available: 5 });
    expect(m.unclaim(U(2000), "payment_failed", 4001)).toMatchObject({ status: "noop" });
    expect(m.checkInvariants()).toEqual([]);
  });

  it("is all-or-nothing across SKUs and reports every shortfall", () => {
    const m = mkModel();
    seed(m, 1, 5);
    seed(m, 2, 1);
    seed(m, 3, 0);
    const plan = planOrThrow("CARD", [line(1, 2), line(2, 2), line(3, 1)]);
    const r = m.reserve({ reservationId: U(1000), orderGroupId: U(2000), userId: U(3), plan, nowMs: 0 });
    expect(r).toEqual({
      status: "insufficient",
      shortfalls: [
        { skuId: U(2), locationId: LOC, requested: 2, available: 1 },
        { skuId: U(3), locationId: LOC, requested: 1, available: 0 },
      ],
    });
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ reserved: 0, available: 5 });
    expect(m.reservationStatus(U(2000))).toBeNull();
  });

  it("sweeps expired reservations back to the pool and a late payment claims if stock remains", () => {
    const m = mkModel();
    seed(m, 1, 2);
    const plan = planOrThrow("CARD", [line(1, 2)]);
    m.reserve({ reservationId: U(1000), orderGroupId: U(2000), userId: U(3), plan, nowMs: 0 });
    expect(m.sweepExpired(599_999)).toEqual({ expiredReservations: 0, releasedUnits: 0 });
    expect(m.sweepExpired(600_000)).toEqual({ expiredReservations: 1, releasedUnits: 2 });
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ reserved: 0, available: 2 });
    expect(m.claim(U(2000), 700_000)).toEqual({ status: "claimed_late" });
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ committed: 2, available: 0 });
    expect(m.checkInvariants()).toEqual([]);
  });

  it("late claim fails with shortfall when someone else took the stock", () => {
    const m = mkModel();
    seed(m, 1, 1);
    m.reserve({ reservationId: U(1000), orderGroupId: U(2000), userId: U(3), plan: planOrThrow("CARD", [line(1)]), nowMs: 0 });
    m.sweepExpired(600_000);
    m.reserve({ reservationId: U(1001), orderGroupId: U(2001), userId: U(4), plan: planOrThrow("CARD", [line(1)]), nowMs: 600_001 });
    expect(m.claim(U(2000), 600_002)).toEqual({
      status: "unavailable",
      shortfalls: [{ skuId: U(1), locationId: LOC, requested: 1, available: 0 }],
    });
    expect(m.claim(U(2001), 600_003)).toEqual({ status: "claimed" });
    expect(m.checkInvariants()).toEqual([]);
  });

  it("release is a no-op unless ACTIVE", () => {
    const m = mkModel();
    seed(m, 1, 2);
    m.reserve({ reservationId: U(1000), orderGroupId: U(2000), userId: U(3), plan: planOrThrow("CARD", [line(1)]), nowMs: 0 });
    expect(m.release(U(2000), "payment_failed", 5)).toEqual({ status: "released" });
    expect(m.release(U(2000), "payment_failed", 6)).toEqual({ status: "noop", reservationStatus: "RELEASED" });
    expect(m.release(U(9999), "cancelled", 6)).toEqual({ status: "not_found" });
  });

  it("caps the materialised pool at the cap and tops up from the unmaterialised stock", () => {
    const m = mkModel(3);
    seed(m, 1, 10);
    expect(m.availableRows(U(1), LOC, STANDARD)).toBe(3);
    for (let i = 0; i < 10; i += 1) {
      const r = m.reserve({ reservationId: U(1000 + i), orderGroupId: U(2000 + i), userId: U(3), plan: planOrThrow("CARD", [line(1)]), nowMs: 0 });
      expect(r.status).toBe("reserved");
    }
    expect(m.reserve({ reservationId: U(1100), orderGroupId: U(2100), userId: U(3), plan: planOrThrow("CARD", [line(1)]), nowMs: 0 }).status).toBe("insufficient");
    expect(m.checkInvariants()).toEqual([]);
  });

  it("negative seller adjustment honours reserved orders and records an oversell penalty", () => {
    const m = mkModel();
    seed(m, 1, 5);
    m.reserve({ reservationId: U(1000), orderGroupId: U(2000), userId: U(3), plan: planOrThrow("CARD", [line(1, 4)]), nowMs: 0 });
    const r = m.applySync({
      skuId: U(1), locationId: LOC, poolId: STANDARD, storeId: STORE, mode: "set", quantity: 1, reason: "damaged",
      idempotencyKey: "k-damage", actorType: "seller", actorId: "s", nowMs: 10,
    });
    expect(r).toMatchObject({ status: "applied", oversoldUnits: 3 });
    expect(m.oversellRecords).toHaveLength(1);
    expect(m.events.at(-1)?.type).toBe("inventory.oversold");
    // reserved units survive; nothing new can be reserved
    expect(m.reserve({ reservationId: U(1001), orderGroupId: U(2001), userId: U(3), plan: planOrThrow("CARD", [line(1)]), nowMs: 11 }).status).toBe("insufficient");
    expect(m.claim(U(2000), 12)).toEqual({ status: "claimed" });
    expect(m.checkInvariants({ allowOversold: true })).toEqual([]);
  });

  it("sync is idempotent by key and rejects stale channel versions", () => {
    const m = mkModel();
    const cmd = {
      skuId: U(1), locationId: LOC, poolId: STANDARD, storeId: STORE, mode: "adjust" as const, quantity: 4,
      reason: "channel_sync" as const, idempotencyKey: "k1", sourceVersion: 5, actorType: "channel" as const, actorId: "c", nowMs: 0,
    };
    expect(m.applySync(cmd)).toMatchObject({ status: "applied", replayed: false, level: { onHand: 4 } });
    expect(m.applySync(cmd)).toMatchObject({ status: "applied", replayed: true, level: { onHand: 4 } });
    expect(m.applySync({ ...cmd, idempotencyKey: "k2", sourceVersion: 5 })).toEqual({ status: "stale", currentSourceVersion: 5 });
    expect(m.applySync({ ...cmd, idempotencyKey: "k3", sourceVersion: 6 })).toMatchObject({ status: "applied", level: { onHand: 8, syncVersion: 2 } });
  });

  it("moves free stock into the Fawry pool and Fawry reservations never touch STANDARD", () => {
    const m = mkModel();
    seed(m, 1, 5);
    expect(m.transferBetweenPools({ skuId: U(1), locationId: LOC, fromPoolId: STANDARD, toPoolId: FAWRY, storeId: STORE, qty: 6, idempotencyKey: "t0", nowMs: 0 })).toEqual({ status: "insufficient", free: 5 });
    expect(m.transferBetweenPools({ skuId: U(1), locationId: LOC, fromPoolId: STANDARD, toPoolId: FAWRY, storeId: STORE, qty: 1, idempotencyKey: "t1", nowMs: 0 })).toEqual({ status: "transferred", replayed: false });
    expect(m.transferBetweenPools({ skuId: U(1), locationId: LOC, fromPoolId: STANDARD, toPoolId: FAWRY, storeId: STORE, qty: 1, idempotencyKey: "t1", nowMs: 0 })).toEqual({ status: "transferred", replayed: true });
    const f = planOrThrow("FAWRY", [line(1, 2)]);
    expect(m.reserve({ reservationId: U(1000), orderGroupId: U(2000), userId: U(3), plan: f, nowMs: 0 }).status).toBe("insufficient");
    expect(m.reserve({ reservationId: U(1001), orderGroupId: U(2001), userId: U(3), plan: planOrThrow("FAWRY", [line(1, 1)]), nowMs: 0 }).status).toBe("reserved");
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ onHand: 4, available: 4 });
    expect(m.checkInvariants()).toEqual([]);
  });
});

describe("StockModel properties", () => {
  type Op =
    | { t: "reserve"; og: number; skus: number[]; qty: number; method: PaymentMethod }
    | { t: "claim"; og: number }
    | { t: "release"; og: number }
    | { t: "sweep"; advance: number }
    | { t: "sync"; sku: number; mode: "set" | "adjust"; q: number }
    | { t: "rebalance"; sku: number };

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({
      t: fc.constant("reserve" as const),
      og: fc.integer({ min: 0, max: 14 }),
      skus: fc.uniqueArray(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 3 }),
      qty: fc.integer({ min: 1, max: 3 }),
      method: fc.constantFrom<PaymentMethod>("CARD", "COD", "WALLET", "FAWRY", "BNPL"),
    }),
    fc.record({ t: fc.constant("claim" as const), og: fc.integer({ min: 0, max: 14 }) }),
    fc.record({ t: fc.constant("release" as const), og: fc.integer({ min: 0, max: 14 }) }),
    fc.record({ t: fc.constant("sweep" as const), advance: fc.integer({ min: 0, max: 1_000_000 }) }),
    fc.record({ t: fc.constant("rebalance" as const), sku: fc.integer({ min: 1, max: 3 }) }),
  );

  it("never oversells and keeps every invariant under random operations (no seller decreases)", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 60 }), fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 3, maxLength: 3 }), fc.integer({ min: 1, max: 5 }), (ops, stocks, cap) => {
        const m = mkModel(cap);
        stocks.forEach((s, i) => seed(m, i + 1, s));
        let now = 0;
        for (const op of ops) {
          now += 1000;
          switch (op.t) {
            case "reserve": {
              const r = planReservation(op.method, op.skus.map((s) => line(s, op.qty)), ctx);
              if (r.ok) m.reserve({ reservationId: U(5000 + op.og), orderGroupId: U(6000 + op.og), userId: U(3), plan: r.plan, nowMs: now });
              break;
            }
            case "claim":
              m.claim(U(6000 + op.og), now);
              break;
            case "release":
              m.release(U(6000 + op.og), "cancelled", now);
              break;
            case "sweep":
              now += op.advance;
              m.sweepExpired(now);
              break;
            case "rebalance":
              m.rebalance(U(op.sku), LOC, STANDARD);
              break;
            case "sync":
              break;
          }
          expect(m.checkInvariants()).toEqual([]);
        }
        // claimed units across all SKUs never exceed what was stocked
        for (let i = 1; i <= 3; i += 1) {
          const lv = m.level(U(i), LOC, STANDARD);
          expect(lv?.committed ?? 0).toBeLessThanOrEqual(stocks[i - 1] ?? 0);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("available rows never exceed free stock even with seller decreases", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(
          fc.record({ t: fc.constant("reserve" as const), og: fc.integer({ min: 0, max: 9 }) }),
          fc.record({ t: fc.constant("claim" as const), og: fc.integer({ min: 0, max: 9 }) }),
          fc.record({ t: fc.constant("release" as const), og: fc.integer({ min: 0, max: 9 }) }),
          fc.record({ t: fc.constant("set" as const), q: fc.integer({ min: 0, max: 8 }) }),
        ), { maxLength: 50 }),
        (ops) => {
          const m = mkModel(4);
          seed(m, 1, 6);
          let v = 0;
          for (const op of ops) {
            if (op.t === "reserve") m.reserve({ reservationId: U(5000 + op.og), orderGroupId: U(6000 + op.og), userId: U(3), plan: planOrThrow("CARD", [line(1)]), nowMs: 0 });
            if (op.t === "claim") m.claim(U(6000 + op.og), 1);
            if (op.t === "release") m.release(U(6000 + op.og), "cancelled", 1);
            if (op.t === "set") {
              v += 1;
              m.applySync({ skuId: U(1), locationId: LOC, poolId: STANDARD, storeId: STORE, mode: "set", quantity: op.q, reason: "recount", idempotencyKey: `s${v}`, actorType: "seller", actorId: "s", nowMs: 1 });
            }
            expect(m.checkInvariants({ allowOversold: true })).toEqual([]);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
