import { describe, expect, it } from "vitest";
import {
  DEFAULT_TTL_POLICIES,
  MAX_RESERVATION_LINES,
  POOL_CAP,
  StockModel,
  displayableStock,
  planReservation,
  planStockSync,
  selectPolicy,
  type PaymentMethod,
  type ReservePlan,
  type ReservePlanContext,
  type ReserveRequestLine,
} from "./index";
import { holdReasonFor } from "./ttl-policy";

// Spec rules (docs/specs/inventory.md, ADR-0005, ADR-0011): TTL boundaries, pool cap, Fawry separation,
// claim/unclaim idempotency, exact outbox events and invariant detection.
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const STANDARD = U(501);
const FAWRY = U(502);
const LOC = U(900);
const STORE = U(800);
const ctx: ReservePlanContext = {
  policies: DEFAULT_TTL_POLICIES,
  standardPoolId: STANDARD,
  fawryPoolId: FAWRY,
  dropPoolIds: new Map(),
};
const line = (n: number, qty = 1): ReserveRequestLine => ({ skuId: U(n), locationId: LOC, storeId: STORE, qty, dropId: null });
const plan = (method: PaymentMethod, lines: ReserveRequestLine[]): ReservePlan => {
  const r = planReservation(method, lines, ctx);
  if (!r.ok) throw new Error(`plan failed: ${r.error.code}`);
  return r.plan;
};
const mk = (opts: { cap?: number; fawry?: boolean; ids?: () => string } = {}): StockModel => {
  let n = 100_000;
  return new StockModel({
    newUnitId: opts.ids ?? (() => U((n += 1))),
    ...(opts.cap === undefined ? {} : { poolCap: opts.cap }),
    ...(opts.fawry === true ? { fawryPoolId: FAWRY } : {}),
  });
};
let k = 0;
const sync = (
  m: StockModel,
  sku: number,
  quantity: number,
  extra: { pool?: string; mode?: "set" | "adjust"; expectedVersion?: number; sourceVersion?: number; key?: string; nowMs?: number } = {},
) =>
  m.applySync({
    skuId: U(sku),
    locationId: LOC,
    poolId: extra.pool ?? STANDARD,
    storeId: STORE,
    mode: extra.mode ?? "set",
    quantity,
    reason: "received",
    idempotencyKey: extra.key ?? `k${(k += 1)}`,
    actorType: "system",
    actorId: "t",
    nowMs: extra.nowMs ?? 0,
    ...(extra.expectedVersion === undefined ? {} : { expectedVersion: extra.expectedVersion }),
    ...(extra.sourceVersion === undefined ? {} : { sourceVersion: extra.sourceVersion }),
  });
const reserve = (m: StockModel, n: number, og: number, p: ReservePlan, nowMs = 0) =>
  m.reserve({ reservationId: U(1000 + n), orderGroupId: U(2000 + og), userId: U(3), plan: p, nowMs });

interface Priv {
  levels: Map<string, { onHand: number; committed: number }>;
  units: Map<string, { id: string; key: string; state: string; reservationId: string | null }>;
  reservations: Map<string, { status: string }>;
}
const priv = (m: StockModel): Priv => m as unknown as Priv;
const KEY = (sku: number, pool = STANDARD): string => `${U(sku)}|${LOC}|${pool}`;

describe("ttl policy table (ADR-0011)", () => {
  it("is exactly the approved defaults", () => {
    expect(DEFAULT_TTL_POLICIES.map((p) => [p.paymentMethod, p.ttlSeconds, p.extensionSeconds, p.poolKind, p.maxQtyPerLine, p.version])).toEqual([
      ["CARD", 600, 300, "STANDARD", null, 1],
      ["APPLE_PAY", 600, 300, "STANDARD", null, 1],
      ["MEEZA", 600, 300, "STANDARD", null, 1],
      ["COD", 600, 0, "STANDARD", null, 1],
      ["WALLET", 1800, 0, "STANDARD", null, 1],
      ["INSTAPAY", 1800, 0, "STANDARD", null, 1],
      ["BNPL", 900, 0, "STANDARD", null, 1],
      ["FAWRY", 86_400, 0, "FAWRY", 2, 1],
    ]);
    expect(DEFAULT_TTL_POLICIES.map((p) => p.id)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `00000000-0000-4000-8000-00000000060${n}`),
    );
  });
  it("maps every method to its hold reason", () => {
    expect(holdReasonFor("CARD")).toBe("CARD_WINDOW");
    expect(holdReasonFor("APPLE_PAY")).toBe("CARD_WINDOW");
    expect(holdReasonFor("MEEZA")).toBe("CARD_WINDOW");
    expect(holdReasonFor("COD")).toBe("COD");
    expect(holdReasonFor("WALLET")).toBe("WALLET_WINDOW");
    expect(holdReasonFor("INSTAPAY")).toBe("INSTAPAY_WINDOW");
    expect(holdReasonFor("BNPL")).toBe("BNPL_WINDOW");
    expect(holdReasonFor("FAWRY")).toBe("FAWRY_WINDOW");
  });
  it("selectPolicy keeps the first of equal versions, prefers higher, ignores other methods", () => {
    const base = DEFAULT_TTL_POLICIES[0];
    if (base === undefined) throw new Error("policy");
    const a = { ...base, id: "a", ttlSeconds: 1 };
    const b = { ...base, id: "b", ttlSeconds: 2 };
    const c = { ...base, id: "c", version: 0, ttlSeconds: 3 };
    expect(selectPolicy("CARD", [a, b, c])?.id).toBe("a");
    expect(selectPolicy("CARD", [c, a])?.id).toBe("a");
    expect(selectPolicy("COD", [a, b])).toBeNull();
  });
});

describe("planReservation exact output", () => {
  it("carries ttl, policy, pool kind, hold reason and a canonical fingerprint", () => {
    const p = plan("FAWRY", [line(2, 2), line(1)]);
    expect(p).toEqual({
      lines: [
        { skuId: U(1), locationId: LOC, poolId: FAWRY, storeId: STORE, qty: 1 },
        { skuId: U(2), locationId: LOC, poolId: FAWRY, storeId: STORE, qty: 2 },
      ],
      ttlSeconds: 86_400,
      ttlPolicyId: "00000000-0000-4000-8000-000000000608",
      poolKind: "FAWRY",
      holdReason: "FAWRY_WINDOW",
      fingerprint: `${U(1)}:${LOC}:${FAWRY}:1,${U(2)}:${LOC}:${FAWRY}:2`,
    });
  });
  it("names the offending sku in line errors", () => {
    expect(planReservation("CARD", [line(7, 0)], ctx)).toEqual({ ok: false, error: { code: "invalid_quantity", skuId: U(7) } });
    expect(planReservation("CARD", [line(7, 11)], ctx)).toEqual({ ok: false, error: { code: "quantity_over_limit", skuId: U(7) } });
  });
  it("accepts exactly 50 lines, 10 units on cards and 2 on Fawry", () => {
    const fifty = Array.from({ length: MAX_RESERVATION_LINES }, (_, i) => line(i + 1));
    expect(planReservation("CARD", fifty, ctx).ok).toBe(true);
    expect(planReservation("CARD", [line(1, 10)], ctx).ok).toBe(true);
    expect(planReservation("FAWRY", [line(1, 2)], ctx).ok).toBe(true);
  });
  it("same sku at two locations is not a duplicate", () => {
    const other: ReserveRequestLine = { ...line(1), locationId: U(901) };
    expect(planReservation("CARD", [line(1), other], ctx).ok).toBe(true);
  });
});

describe("pool and sync maths boundaries", () => {
  it("displays real stock for exactly 1..5 free units only", () => {
    expect(displayableStock(1, 0, 0)).toBe(1);
    expect(displayableStock(0, 0, 0)).toBeNull();
    expect(displayableStock(6, 1, 0)).toBe(5);
    expect(displayableStock(6, 0, 0)).toBeNull();
    expect(displayableStock(2, 0, 3)).toBeNull();
  });
  it("sync: unchanged quantity is never an oversell, a source version on a fresh level applies", () => {
    const lv = { onHand: 3, committed: 4, reserved: 0, syncVersion: 1, sourceVersion: null };
    expect(planStockSync(lv, { mode: "set", quantity: 3 })).toMatchObject({ kind: "apply", delta: 0, oversoldUnits: 0 });
    expect(planStockSync(lv, { mode: "set", quantity: 2, sourceVersion: 1 })).toMatchObject({ kind: "apply", oversoldUnits: 2 });
    expect(planStockSync(lv, { mode: "set", quantity: 3, expectedVersion: 1 })).toMatchObject({ kind: "apply" });
    expect(planStockSync(lv, { mode: "adjust", quantity: 0.5 })).toEqual({ kind: "negative", wouldBe: 3.5 });
  });
});

describe("reserve, TTL and sweep", () => {
  it("emits one reserved event per line with the absolute expiry", () => {
    const m = mk();
    expect(m.events).toEqual([]);
    sync(m, 1, 5);
    sync(m, 2, 5);
    const p = plan("WALLET", [line(1, 2), line(2)]);
    expect(reserve(m, 1, 1, p, 1000)).toEqual({ status: "reserved", reservationId: U(1001), expiresAtMs: 1000 + 1_800_000, replayed: false });
    const iso = new Date(1000 + 1_800_000).toISOString();
    expect(m.events).toEqual([
      { type: "inventory.reserved", aggregateId: U(1001), payload: { reservation_id: U(1001), sku_id: U(1), quantity: 2, expires_at: iso }, headers: {} },
      { type: "inventory.reserved", aggregateId: U(1001), payload: { reservation_id: U(1001), sku_id: U(2), quantity: 1, expires_at: iso }, headers: {} },
    ]);
    expect(m.reservationStatus(U(2001))).toBe("ACTIVE");
    expect(m.reservationStatus(U(2999))).toBeNull();
    expect(m.level(U(99), LOC, STANDARD)).toBeNull();
  });
  it("reserves exactly the free quantity and reports the shortfall one unit above", () => {
    const m = mk();
    sync(m, 1, 3);
    expect(reserve(m, 1, 1, plan("CARD", [line(1, 4)]))).toEqual({
      status: "insufficient",
      shortfalls: [{ skuId: U(1), locationId: LOC, requested: 4, available: 3 }],
    });
    expect(m.reservationStatus(U(2001))).toBeNull();
    expect(reserve(m, 2, 2, plan("CARD", [line(1, 3)])).status).toBe("reserved");
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ reserved: 3, available: 0 });
    expect(m.checkInvariants()).toEqual([]);
  });
  it("replenishes the capped pool on demand", () => {
    const m = mk({ cap: 2 });
    sync(m, 1, 5);
    expect(m.availableRows(U(1), LOC, STANDARD)).toBe(2);
    expect(reserve(m, 1, 1, plan("CARD", [line(1, 2)])).status).toBe("reserved");
    expect(m.availableRows(U(1), LOC, STANDARD)).toBe(0);
    expect(reserve(m, 2, 2, plan("CARD", [line(1, 2)])).status).toBe("reserved");
    expect(reserve(m, 3, 3, plan("CARD", [line(1, 2)]))).toMatchObject({ status: "insufficient", shortfalls: [{ requested: 2, available: 1 }] });
    expect(m.checkInvariants()).toEqual([]);
  });
  it("never materialises more than 1000 rows (pool cap)", () => {
    const m = mk();
    sync(m, 1, 1500);
    expect(m.availableRows(U(1), LOC, STANDARD)).toBe(POOL_CAP);
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ onHand: 1500, available: 1500 });
    expect(m.checkInvariants()).toEqual([]);
  });
  it("rebalance restores missing rows and trims the highest ids", () => {
    let c = 1000;
    const m = mk({ ids: () => U((c -= 1)) });
    sync(m, 1, 3);
    priv(m).units.clear();
    expect(m.rebalance(U(1), LOC, STANDARD)).toBe(3);
    expect(m.availableRows(U(1), LOC, STANDARD)).toBe(3);
    expect(m.rebalance(U(99), LOC, STANDARD)).toBe(0);
    expect(reserve(m, 1, 1, plan("CARD", [line(1)])).status).toBe("reserved");
    const reservedIds = [...priv(m).units.values()].filter((u) => u.state === "RESERVED").map((u) => u.id);
    const lowest = [...priv(m).units.keys()].sort()[0];
    expect(reservedIds).toEqual([lowest]);
    sync(m, 1, 2);
    const left = [...priv(m).units.values()].filter((u) => u.state === "AVAILABLE").map((u) => u.id);
    expect(left).toEqual([[...priv(m).units.keys()].sort()[1]]);
  });
  it("TTL boundary: swept at exactly expiry, not one millisecond before", () => {
    const m = mk();
    sync(m, 1, 5);
    reserve(m, 1, 1, plan("CARD", [line(1, 2)]), 1000);
    const exp = 1000 + 600_000;
    expect(m.sweepExpired(exp - 1)).toEqual({ expiredReservations: 0, releasedUnits: 0 });
    expect(m.reservationStatus(U(2001))).toBe("ACTIVE");
    expect(m.sweepExpired(exp)).toEqual({ expiredReservations: 1, releasedUnits: 2 });
    expect(m.reservationStatus(U(2001))).toBe("EXPIRED");
    expect(m.events.at(-1)).toEqual({
      type: "inventory.released",
      aggregateId: U(1001),
      payload: { reservation_id: U(1001), sku_id: U(1), quantity: 2, reason: "expired" },
      headers: {},
    });
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ reserved: 0, available: 5 });
    expect(m.sweepExpired(exp + 1)).toEqual({ expiredReservations: 0, releasedUnits: 0 });
    expect(m.checkInvariants()).toEqual([]);
  });
  it("does not sweep claimed or released reservations", () => {
    const m = mk();
    sync(m, 1, 5);
    reserve(m, 1, 1, plan("CARD", [line(1)]));
    reserve(m, 2, 2, plan("CARD", [line(1)]));
    m.claim(U(2001), 5);
    m.release(U(2002), "cancelled", 5);
    expect(m.sweepExpired(10_000_000)).toEqual({ expiredReservations: 0, releasedUnits: 0 });
    expect(m.checkInvariants()).toEqual([]);
  });
  it("sweeps oldest expiry first, then by id, within the batch", () => {
    const m = mk();
    sync(m, 1, 9);
    reserve(m, 5, 5, plan("WALLET", [line(1)]), 0); // expires 1_800_000
    reserve(m, 3, 3, plan("CARD", [line(1)]), 0); // expires 600_000
    reserve(m, 2, 2, plan("CARD", [line(1)]), 0); // expires 600_000
    expect(m.sweepExpired(5_000_000, 1)).toEqual({ expiredReservations: 1, releasedUnits: 1 });
    expect(m.reservationStatus(U(2002))).toBe("EXPIRED");
    expect(m.reservationStatus(U(2003))).toBe("ACTIVE");
    m.sweepExpired(5_000_000, 1);
    expect(m.reservationStatus(U(2003))).toBe("EXPIRED");
    expect(m.reservationStatus(U(2005))).toBe("ACTIVE");
    expect(m.sweepExpired(5_000_000)).toEqual({ expiredReservations: 1, releasedUnits: 1 });
  });
  it("a closed order group replays as closed with its final status", () => {
    const m = mk();
    sync(m, 1, 5);
    const p = plan("CARD", [line(1)]);
    reserve(m, 1, 1, p);
    m.release(U(2001), "abandoned", 1);
    expect(reserve(m, 2, 1, p)).toEqual({ status: "closed", reservationStatus: "RELEASED" });
    reserve(m, 3, 3, p);
    m.sweepExpired(10_000_000);
    expect(reserve(m, 4, 3, p)).toEqual({ status: "closed", reservationStatus: "EXPIRED" });
  });
});

describe("claim, release and unclaim", () => {
  it("claim commits only its own units, stamps the level and emits non-late events", () => {
    const m = mk();
    sync(m, 1, 5);
    reserve(m, 1, 1, plan("CARD", [line(1, 2)]));
    reserve(m, 2, 2, plan("CARD", [line(1, 1)]));
    expect(m.claim(U(2001), 7777)).toEqual({ status: "claimed" });
    expect(m.reservationStatus(U(2001))).toBe("CLAIMED");
    expect(m.reservationStatus(U(2002))).toBe("ACTIVE");
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ committed: 2, reserved: 1, available: 2, updatedAtMs: 7777 });
    expect(m.events.at(-1)).toEqual({
      type: "inventory.claimed",
      aggregateId: U(1001),
      payload: { reservation_id: U(1001), sku_id: U(1), quantity: 2, order_group_id: U(2001) },
      headers: { late: false },
    });
    expect(m.checkInvariants()).toEqual([]);
  });
  it("unknown order groups are not_found everywhere", () => {
    const m = mk();
    expect(m.claim(U(1), 0)).toEqual({ status: "not_found" });
    expect(m.release(U(1), "cancelled", 0)).toEqual({ status: "not_found" });
    expect(m.unclaim(U(1), "cancelled", 0)).toEqual({ status: "not_found" });
  });
  it("release is idempotent and only works on ACTIVE; it leaves other reservations alone", () => {
    const m = mk();
    sync(m, 1, 5);
    reserve(m, 1, 1, plan("CARD", [line(1)]));
    reserve(m, 2, 2, plan("CARD", [line(1, 2)]));
    expect(m.release(U(2001), "payment_failed", 3)).toEqual({ status: "released" });
    expect(m.events.at(-1)).toEqual({
      type: "inventory.released",
      aggregateId: U(1001),
      payload: { reservation_id: U(1001), sku_id: U(1), quantity: 1, reason: "payment_failed" },
      headers: {},
    });
    expect(m.release(U(2001), "payment_failed", 4)).toEqual({ status: "noop", reservationStatus: "RELEASED" });
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ reserved: 2, available: 3 });
    expect(m.claim(U(2002), 5)).toEqual({ status: "claimed" });
    expect(m.release(U(2002), "cancelled", 6)).toEqual({ status: "noop", reservationStatus: "CLAIMED" });
    expect(m.checkInvariants()).toEqual([]);
  });
  it("unclaim only undoes its own claim, floors nothing wrongly and is idempotent", () => {
    const m = mk();
    sync(m, 1, 6);
    reserve(m, 1, 1, plan("CARD", [line(1, 2)]));
    reserve(m, 2, 2, plan("CARD", [line(1, 2)]));
    expect(m.unclaim(U(2001), "cancelled", 1)).toEqual({ status: "noop", reservationStatus: "ACTIVE" });
    m.claim(U(2001), 2);
    m.claim(U(2002), 2);
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ committed: 4 });
    expect(m.unclaim(U(2001), "payment_failed", 9000)).toEqual({ status: "unclaimed" });
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ committed: 2, available: 4, updatedAtMs: 9000 });
    expect(m.reservationStatus(U(2001))).toBe("RELEASED");
    expect(m.events.at(-1)).toEqual({
      type: "inventory.released",
      aggregateId: U(1001),
      payload: { reservation_id: U(1001), sku_id: U(1), quantity: 2, reason: "payment_failed" },
      headers: { unclaimed: true },
    });
    expect(m.unclaim(U(2001), "payment_failed", 9001)).toEqual({ status: "noop", reservationStatus: "RELEASED" });
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ committed: 2 });
    expect(m.checkInvariants()).toEqual([]);
  });
  it("late claim takes free stock after expiry and marks the event late", () => {
    const m = mk();
    sync(m, 1, 5);
    reserve(m, 1, 1, plan("CARD", [line(1, 2)]));
    m.sweepExpired(10_000_000);
    expect(m.claim(U(2001), 20_000_000)).toEqual({ status: "claimed_late" });
    expect(m.reservationStatus(U(2001))).toBe("CLAIMED");
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ committed: 2, available: 3 });
    expect(m.events.at(-1)).toMatchObject({ type: "inventory.claimed", headers: { late: true } });
    expect(m.claim(U(2001), 20_000_001)).toEqual({ status: "already_claimed" });
    expect(m.checkInvariants()).toEqual([]);
  });
  it("late claim after a release also works, and replenishes a depleted pool", () => {
    const m = mk({ cap: 2 });
    sync(m, 1, 5);
    reserve(m, 1, 1, plan("CARD", [line(1, 2)]));
    m.release(U(2001), "abandoned", 1);
    for (const [id, u] of priv(m).units) if (u.state === "AVAILABLE") priv(m).units.delete(id);
    expect(m.claim(U(2001), 2)).toEqual({ status: "claimed_late" });
    expect(m.checkInvariants()).toEqual([]);
  });
  it("late claim with no stock left is unavailable, reports shortfalls and changes nothing", () => {
    const m = mk();
    sync(m, 1, 2);
    reserve(m, 1, 1, plan("CARD", [line(1, 2)]));
    m.sweepExpired(10_000_000);
    reserve(m, 2, 2, plan("CARD", [line(1, 2)]), 10_000_000);
    expect(m.claim(U(2001), 10_000_001)).toEqual({
      status: "unavailable",
      shortfalls: [{ skuId: U(1), locationId: LOC, requested: 2, available: 0 }],
    });
    expect(m.reservationStatus(U(2001))).toBe("EXPIRED");
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ committed: 0, reserved: 2 });
    expect(m.checkInvariants()).toEqual([]);
  });
});

describe("seller stock sync through the model", () => {
  it("replays an applied key without re-applying it", () => {
    const m = mk();
    const first = sync(m, 1, 5, { key: "same" });
    expect(first).toMatchObject({ status: "applied", replayed: false, oversoldUnits: 0 });
    const again = sync(m, 1, 9, { key: "same" });
    expect(again).toMatchObject({ status: "applied", replayed: true });
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ onHand: 5, syncVersion: 1 });
  });
  it("guards source versions (equal is stale) and remembers them across unversioned writes", () => {
    const m = mk();
    sync(m, 1, 5, { sourceVersion: 5 });
    expect(sync(m, 1, 6, { sourceVersion: 5 })).toEqual({ status: "stale", currentSourceVersion: 5 });
    sync(m, 1, 7);
    expect(sync(m, 1, 8, { sourceVersion: 5 })).toEqual({ status: "stale", currentSourceVersion: 5 });
    expect(sync(m, 1, 8, { sourceVersion: 6 }).status).toBe("applied");
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ onHand: 8 });
  });
  it("guards the expected version and rejects negatives", () => {
    const m = mk();
    sync(m, 1, 5);
    expect(sync(m, 1, 6, { expectedVersion: 7 })).toEqual({ status: "version_conflict", currentVersion: 1 });
    expect(sync(m, 1, 6, { expectedVersion: 1 }).status).toBe("applied");
    expect(sync(m, 1, -7, { mode: "adjust" })).toEqual({ status: "negative", wouldBe: -1 });
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ onHand: 6, syncVersion: 2, updatedAtMs: 0 });
  });
  it("records and announces an oversell when promised units exceed the new stock", () => {
    const m = mk();
    sync(m, 1, 5);
    reserve(m, 1, 1, plan("CARD", [line(1, 2)]));
    m.claim(U(2001), 1);
    reserve(m, 2, 2, plan("CARD", [line(1, 2)]));
    const r = sync(m, 1, 1, { nowMs: 50 });
    expect(r).toMatchObject({ status: "applied", oversoldUnits: 3, level: { onHand: 1, committed: 2, reserved: 2, available: 0 } });
    expect(m.oversellRecords).toEqual([{ skuId: U(1), locationId: LOC, poolId: STANDARD, shortfall: 3, syncVersion: 2 }]);
    expect(m.events.at(-1)).toEqual({
      type: "inventory.oversold",
      aggregateId: U(1),
      payload: { sku_id: U(1), shortfall_units: 3 },
      headers: {},
    });
    expect(m.checkInvariants({ allowOversold: true })).toEqual([]);
    expect(m.checkInvariants()).toEqual([`${KEY(1)}: oversold`]);
  });
  it("seller set is the physical total across pools: Fawry on_hand is subtracted", () => {
    const m = mk({ fawry: true });
    sync(m, 1, 10, { pool: FAWRY });
    expect(sync(m, 1, 25)).toMatchObject({ status: "applied", level: { onHand: 15 } });
    expect(sync(m, 1, 4)).toMatchObject({ level: { onHand: 0 } });
    expect(sync(m, 1, 3, { mode: "adjust" })).toMatchObject({ level: { onHand: 3 } });
    expect(sync(m, 1, 12, { pool: FAWRY })).toMatchObject({ level: { onHand: 12 } });
    expect(sync(m, 2, 7)).toMatchObject({ level: { onHand: 7 } });
  });
  it("without a configured Fawry pool nothing is subtracted", () => {
    const m = mk();
    sync(m, 1, 10, { pool: FAWRY });
    expect(sync(m, 1, 25)).toMatchObject({ level: { onHand: 25 } });
  });
});

describe("pool transfer (Fawry allocation)", () => {
  const xfer = (m: StockModel, qty: number, key: string, from = STANDARD, to = FAWRY, nowMs = 5) =>
    m.transferBetweenPools({ skuId: U(1), locationId: LOC, fromPoolId: from, toPoolId: to, storeId: STORE, qty, idempotencyKey: key, nowMs });
  it("rejects non-positive quantities and same-pool moves", () => {
    const m = mk();
    sync(m, 1, 5);
    expect(xfer(m, 0, "a")).toEqual({ status: "invalid" });
    expect(xfer(m, 1, "b", STANDARD, STANDARD)).toEqual({ status: "invalid" });
    expect(xfer(m, 1, "c")).toEqual({ status: "transferred", replayed: false });
  });
  it("needs a source level and enough free units (exactly free is allowed)", () => {
    const m = mk();
    expect(xfer(m, 1, "a")).toEqual({ status: "insufficient", free: 0 });
    sync(m, 1, 5);
    reserve(m, 1, 1, plan("CARD", [line(1, 1)]));
    reserve(m, 2, 2, plan("CARD", [line(1, 1)]));
    m.claim(U(2001), 1);
    expect(xfer(m, 4, "b")).toEqual({ status: "insufficient", free: 3 });
    expect(xfer(m, 3, "c")).toEqual({ status: "transferred", replayed: false });
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ onHand: 2, committed: 1, reserved: 1, available: 0 });
    expect(m.level(U(1), LOC, FAWRY)).toMatchObject({ onHand: 3, available: 3, updatedAtMs: 5 });
    expect(m.checkInvariants()).toEqual([]);
  });
  it("reports zero free for an oversold source and is idempotent per key", () => {
    const m = mk();
    sync(m, 1, 3);
    reserve(m, 1, 1, plan("CARD", [line(1, 3)]));
    m.claim(U(2001), 1);
    sync(m, 1, 1);
    expect(xfer(m, 1, "a")).toEqual({ status: "insufficient", free: 0 });
    sync(m, 1, 9);
    expect(xfer(m, 2, "b")).toEqual({ status: "transferred", replayed: false });
    expect(xfer(m, 2, "b")).toEqual({ status: "transferred", replayed: true });
    expect(m.level(U(1), LOC, FAWRY)).toMatchObject({ onHand: 2 });
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ onHand: 7 });
  });
  it("Fawry stock is a separate pool: a Fawry reservation cannot drain the standard pool", () => {
    const m = mk();
    sync(m, 1, 5);
    expect(reserve(m, 1, 1, plan("FAWRY", [line(1, 1)]))).toMatchObject({ status: "insufficient" });
    xfer(m, 2, "a");
    expect(reserve(m, 2, 2, plan("FAWRY", [line(1, 2)])).status).toBe("reserved");
    expect(m.level(U(1), LOC, STANDARD)).toMatchObject({ onHand: 3, reserved: 0 });
    expect(m.level(U(1), LOC, FAWRY)).toMatchObject({ onHand: 2, reserved: 2 });
  });
});

describe("checkInvariants detects corruption", () => {
  const healthy = (cap?: number): StockModel => {
    const m = mk(cap === undefined ? {} : { cap });
    sync(m, 1, 4);
    reserve(m, 1, 1, plan("CARD", [line(1, 2)]));
    return m;
  };
  it("is clean on a healthy model", () => {
    expect(healthy().checkInvariants()).toEqual([]);
  });
  it("flags a pool above its cap", () => {
    const m = mk({ cap: 2 });
    sync(m, 1, 5);
    priv(m).units.set("x", { id: "x", key: KEY(1), state: "AVAILABLE", reservationId: null });
    expect(m.checkInvariants()).toEqual(expect.arrayContaining([`${KEY(1)}: pool above cap`]));
  });
  it("flags committed counters that disagree with claimed rows and rows beyond free stock", () => {
    const m = mk();
    sync(m, 1, 5);
    const lv = priv(m).levels.get(KEY(1));
    if (lv === undefined) throw new Error("level");
    lv.committed = 3;
    expect(m.checkInvariants()).toEqual([
      `${KEY(1)}: committed 3 != claimed rows 0`,
      `${KEY(1)}: available rows exceed free stock`,
    ]);
  });
  it("flags negative counters", () => {
    const m = mk();
    sync(m, 1, 0);
    const lv = priv(m).levels.get(KEY(1));
    if (lv === undefined) throw new Error("level");
    lv.onHand = -1;
    expect(m.checkInvariants({ allowOversold: true })).toEqual([`${KEY(1)}: negative counter`]);
    lv.onHand = 0;
    lv.committed = -1;
    expect(m.checkInvariants()).toEqual(expect.arrayContaining([`${KEY(1)}: negative counter`]));
  });
  it("flags active reservations whose units are wrong, even when only one unit is", () => {
    const m = healthy();
    const held = [...priv(m).units.values()].filter((u) => u.reservationId === U(1001));
    const first = held[0];
    if (first === undefined) throw new Error("unit");
    first.state = "AVAILABLE";
    expect(m.checkInvariants()).toEqual(expect.arrayContaining([`reservation ${U(1001)}: active but units do not match`]));
  });
  it("flags claimed reservations whose units are wrong", () => {
    const m = healthy();
    m.claim(U(2001), 1);
    const first = [...priv(m).units.values()].find((u) => u.reservationId === U(1001));
    if (first === undefined) throw new Error("unit");
    first.state = "AVAILABLE";
    expect(m.checkInvariants()).toEqual(expect.arrayContaining([`reservation ${U(1001)}: claimed but units do not match`]));
  });
  it("flags released and expired reservations that still hold units", () => {
    for (const [how, status] of [["release", "RELEASED"], ["expire", "EXPIRED"]] as const) {
      const m = healthy();
      if (how === "release") m.release(U(2001), "cancelled", 1);
      else m.sweepExpired(10_000_000);
      const u = [...priv(m).units.values()].find((x) => x.state === "AVAILABLE");
      if (u === undefined) throw new Error("unit");
      u.reservationId = U(1001);
      expect(m.checkInvariants()).toEqual(expect.arrayContaining([`reservation ${U(1001)}: ${status} but still holds units`]));
    }
  });
});
