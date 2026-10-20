import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  GUEST_MERGE_LIMITS,
  planGuestBagMerge,
  type GuestBagLine,
  type GuestSkuStatus,
  type PlannedBagLine,
  type ServerBagLine,
} from "./guest-merge";

const ok: GuestSkuStatus = { kind: "ok", productId: "p" };
const allOk = (): GuestSkuStatus => ok;
const g = (skuId: string, qty: number, over: Partial<GuestBagLine> = {}): GuestBagLine => ({
  skuId,
  qty,
  savedForLater: false,
  addedAtMs: 1,
  ...over,
});
const s = (skuId: string, qty: number, state: ServerBagLine["state"] = "IN_BAG"): ServerBagLine => ({
  lineId: `line-${skuId}`,
  skuId,
  qty,
  state,
});
const qtyMap = (lines: readonly PlannedBagLine[]): Record<string, number> =>
  Object.fromEntries([...lines].sort((a, b) => (a.skuId < b.skuId ? -1 : 1)).map((l) => [l.skuId, l.qty]));
const asServer = (lines: readonly PlannedBagLine[]): ServerBagLine[] =>
  lines.map((l, i) => ({ lineId: l.existingLineId ?? `new-${i}`, skuId: l.skuId, qty: l.qty, state: l.state }));

describe("planGuestBagMerge: the quantity rule", () => {
  it("keeps the larger quantity, never the sum (guest 2, account 3 -> 3)", () => {
    const p = planGuestBagMerge([s("x", 3)], [g("x", 2)], allOk);
    expect(qtyMap(p.lines)).toEqual({ x: 3 });
    expect(p.outcomes).toEqual([{ skuId: "x", result: "unchanged", reason: null, qty: 3, previousQty: 3 }]);
  });
  it("raises the account line when the guest holds more (guest 5, account 3 -> 5) and reports it", () => {
    const p = planGuestBagMerge([s("x", 3)], [g("x", 5)], allOk);
    expect(qtyMap(p.lines)).toEqual({ x: 5 });
    expect(p.outcomes[0]).toMatchObject({ result: "qty_raised", qty: 5, previousQty: 3 });
    expect(p.lines[0]?.touched).toBe(true);
  });
  it("moves a saved server line back into the bag when the guest wants it now", () => {
    const p = planGuestBagMerge([s("x", 2, "SAVED_FOR_LATER")], [g("x", 2)], allOk);
    expect(p.lines[0]).toMatchObject({ state: "IN_BAG", qty: 2, touched: true });
    expect(p.outcomes[0]?.result).toBe("moved_to_bag");
  });
  it("does not reactivate a server line for a guest saved-for-later line", () => {
    const p = planGuestBagMerge([s("x", 2, "SAVED_FOR_LATER")], [g("x", 2, { savedForLater: true })], allOk);
    expect(p.lines[0]).toMatchObject({ state: "SAVED_FOR_LATER", touched: false });
  });
  it("merges duplicate guest SKU entries by the same rule", () => {
    const p = planGuestBagMerge([], [g("x", 2), g("x", 4, { savedForLater: true })], allOk);
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0]).toMatchObject({ qty: 4, state: "IN_BAG" });
    const q = planGuestBagMerge([], [g("x", 2, { savedForLater: true }), g("x", 1)], allOk);
    expect(q.lines[0]).toMatchObject({ qty: 2, state: "IN_BAG" });
  });
  it("clamps an out-of-range quantity to 10 and says so", () => {
    const p = planGuestBagMerge([], [g("x", 99)], allOk);
    expect(p.lines[0]?.qty).toBe(GUEST_MERGE_LIMITS.maxUnitsPerSku);
    expect(p.outcomes[0]?.result).toBe("limit_clamped");
  });
});

describe("planGuestBagMerge: availability, suspension and the line cap", () => {
  const status: Record<string, GuestSkuStatus> = {
    gone: { kind: "unknown" },
    closed: { kind: "store_suspended" },
    soldout: { kind: "unavailable", productId: "p-soldout" },
  };
  const statusOf = (sku: string): GuestSkuStatus => status[sku] ?? ok;

  it("does not add unknown, suspended-store or sold-out SKUs; only the sold-out product goes to Saved", () => {
    const p = planGuestBagMerge([], [g("gone", 1), g("closed", 1), g("soldout", 1), g("fine", 1)], statusOf);
    expect(p.lines.map((l) => l.skuId)).toEqual(["fine"]);
    expect(p.outcomes.map((o) => [o.skuId, o.result, o.reason])).toEqual([
      ["closed", "store_suspended", null],
      ["fine", "added", null],
      ["gone", "unavailable", "unavailable"],
      ["soldout", "unavailable", "unavailable"],
    ]);
    expect(p.toSaved).toEqual([{ productId: "p-soldout", skuId: "soldout", reason: "unavailable" }]);
  });
  it("leaves an existing server line alone when the guest copy is sold out", () => {
    const p = planGuestBagMerge([s("soldout", 2)], [g("soldout", 5)], statusOf);
    expect(p.lines[0]).toMatchObject({ qty: 2, touched: false });
  });
  it("the server lines win the cap: the 51st line moves to Saved with over_cap", () => {
    const server = Array.from({ length: 49 }, (_, i) => s(`s${String(i).padStart(2, "0")}`, 1));
    const p = planGuestBagMerge(server, [g("a", 1, { addedAtMs: 1 }), g("b", 1, { addedAtMs: 2 })], allOk);
    expect(p.lines).toHaveLength(50);
    expect(p.outcomes.map((o) => [o.skuId, o.result, o.reason])).toEqual([
      ["a", "added", null],
      ["b", "moved_to_saved", "over_cap"],
    ]);
    expect(p.toSaved).toEqual([{ productId: "p", skuId: "b", reason: "over_cap" }]);
  });
  it("still merges quantities into existing lines when the bag is full", () => {
    const server = Array.from({ length: 50 }, (_, i) => s(`s${i}`, 1));
    const p = planGuestBagMerge(server, [g("s3", 4)], allOk);
    expect(p.lines).toHaveLength(50);
    expect(p.lines.find((l) => l.skuId === "s3")?.qty).toBe(4);
  });
});

const skuArb = fc.constantFrom(...Array.from({ length: 12 }, (_, i) => `sku-${i}`));
const guestLineArb = fc.record({
  skuId: skuArb,
  qty: fc.integer({ min: 1, max: 10 }),
  savedForLater: fc.boolean(),
  addedAtMs: fc.integer({ min: 0, max: 1000 }),
});
const serverArb = fc
  .uniqueArray(fc.record({ skuId: skuArb, qty: fc.integer({ min: 1, max: 10 }), state: fc.constantFrom("IN_BAG" as const, "SAVED_FOR_LATER" as const) }), {
    selector: (l) => l.skuId,
    maxLength: 12,
  })
  .map((ls) => ls.map((l, i) => ({ lineId: `line-${i}`, ...l })));

describe("planGuestBagMerge: properties", () => {
  const statusArb = fc.dictionary(skuArb, fc.constantFrom("ok", "unavailable", "store_suspended", "unknown"));
  const toStatus = (m: Record<string, string>) => (sku: string): GuestSkuStatus => {
    const k = m[sku] ?? "ok";
    return k === "ok" || k === "unavailable" ? { kind: k, productId: `p-${sku}` } : ({ kind: k } as GuestSkuStatus);
  };

  it("never exceeds 50 lines or 10 units, even from an already-full bag of many guest lines", () => {
    const big = fc.array(fc.record({ skuId: fc.uuid(), qty: fc.integer({ min: 1, max: 40 }), savedForLater: fc.boolean(), addedAtMs: fc.integer({ min: 0, max: 100 }) }), { maxLength: 120 });
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 50 }), big, (n, guestLines) => {
        const server = Array.from({ length: n }, (_, i) => s(`srv-${i}`, 1 + (i % 10)));
        const p = planGuestBagMerge(server, guestLines, allOk);
        expect(p.lines.length).toBeLessThanOrEqual(GUEST_MERGE_LIMITS.maxBagLines);
        for (const l of p.lines) {
          expect(l.qty).toBeGreaterThanOrEqual(1);
          expect(l.qty).toBeLessThanOrEqual(10);
        }
        // Server lines are never dropped and never lowered.
        for (const sl of server) expect((p.lines.find((l) => l.skuId === sl.skuId)?.qty ?? 0)).toBeGreaterThanOrEqual(sl.qty);
      }),
    );
  });

  it("larger-quantity rule: every shared SKU ends at max(server, guest)", () => {
    fc.assert(
      fc.property(serverArb, fc.array(guestLineArb, { maxLength: 20 }), (server, guestLines) => {
        const p = planGuestBagMerge(server, guestLines, allOk);
        const maxGuest = new Map<string, number>();
        for (const l of guestLines) maxGuest.set(l.skuId, Math.max(maxGuest.get(l.skuId) ?? 0, l.qty));
        for (const l of p.lines) {
          const sv = server.find((x) => x.skuId === l.skuId)?.qty ?? 0;
          expect(l.qty).toBe(Math.max(sv, maxGuest.get(l.skuId) ?? 0));
        }
      }),
    );
  });

  it("idempotent: merging the same guest bag twice equals merging it once", () => {
    fc.assert(
      fc.property(serverArb, fc.array(guestLineArb, { maxLength: 20 }), statusArb, (server, guestLines, st) => {
        const once = planGuestBagMerge(server, guestLines, toStatus(st));
        const twice = planGuestBagMerge(asServer(once.lines), guestLines, toStatus(st));
        expect(qtyMap(twice.lines)).toEqual(qtyMap(once.lines));
        expect(twice.lines.map((l) => [l.skuId, l.state]).sort()).toEqual(once.lines.map((l) => [l.skuId, l.state]).sort());
        expect(twice.lines.some((l) => l.touched && l.existingLineId !== null)).toBe(false);
      }),
    );
  });

  it("commutative below the cap: two guest merges give the same quantities in either order", () => {
    fc.assert(
      fc.property(serverArb, fc.array(guestLineArb, { maxLength: 8 }), fc.array(guestLineArb, { maxLength: 8 }), (server, a, b) => {
        const ab = planGuestBagMerge(asServer(planGuestBagMerge(server, a, allOk).lines), b, allOk);
        const ba = planGuestBagMerge(asServer(planGuestBagMerge(server, b, allOk).lines), a, allOk);
        // 12 distinct SKUs at most: the 50-line cap cannot interfere, so order must not matter.
        expect(qtyMap(ab.lines)).toEqual(qtyMap(ba.lines));
        expect(ab.lines.map((l) => [l.skuId, l.state]).sort()).toEqual(ba.lines.map((l) => [l.skuId, l.state]).sort());
      }),
    );
  });

  it("does not depend on the order of the guest lines", () => {
    fc.assert(
      fc.property(serverArb, fc.array(guestLineArb, { maxLength: 20 }), (server, guestLines) => {
        const a = planGuestBagMerge(server, guestLines, allOk);
        const b = planGuestBagMerge(server, [...guestLines].reverse(), allOk);
        expect(qtyMap(a.lines)).toEqual(qtyMap(b.lines));
      }),
    );
  });
});
