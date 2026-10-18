import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CATEGORIES, COLOURS, MATERIALS, PATTERNS, selectOwned, type Attributes, type OwnedItem } from "./domain/attributes";
import { KIND_FORMALITY, SEASONS, SLOTS, ownedSlotsConsistent, planGap, type EventKind, type Season, type Slot } from "./domain/bridge";

const base: Attributes = { category: "top", palette: ["white"], pattern: "solid", formality: 2, seasons: ["all"], material: "cotton", modest: true };
const it$ = (id: string, over: Partial<Attributes>, at = 1): OwnedItem => ({ id, attributes: { ...base, ...over }, createdAtMs: at });
const ctx = { formality: 2, season: "all" as Season, modest: false };

describe("selectOwned", () => {
  it("picks the best fit per slot, then oldest, then lowest id", () => {
    const picks = selectOwned(
      [it$("b", { formality: 3 }), it$("a", { formality: 2 }, 5), it$("c", { formality: 2 }, 2), it$("d", { formality: 2 }, 2)],
      ctx,
    );
    expect(picks).toEqual([{ slot: "top", itemId: "c" }]);
  });

  it("never mixes a dress with a top or a bottom", () => {
    const wardrobe = [it$("t", { category: "top" }), it$("b", { category: "bottom" }), it$("d", { category: "dress" }), it$("s", { category: "shoes" })];
    const picks = selectOwned(wardrobe, ctx);
    const slots = picks.map((p) => p.slot);
    expect(ownedSlotsConsistent(slots)).toBe(true);
    expect(slots.includes("dress") && (slots.includes("top") || slots.includes("bottom"))).toBe(false);
    expect(slots).toContain("shoes");
  });

  it("prefers the template with the better fit, and a lone top does not displace a better dress", () => {
    const dressBetter = selectOwned([it$("t", { category: "top", formality: 3 }), it$("b", { category: "bottom", formality: 3 }), it$("d", { category: "dress", formality: 2 })], ctx);
    expect(dressBetter.map((p) => p.slot)).toEqual(["dress"]);
    const loneTop = selectOwned([it$("t", { category: "top", formality: 3 }), it$("d", { category: "dress", formality: 2 })], ctx);
    expect(loneTop.map((p) => p.slot)).toEqual(["dress"]);
  });

  it("skips outerwear, incomplete items, wrong formality, wrong season and (in modest mode) not-modest items", () => {
    const partial: OwnedItem = { id: "p", attributes: { category: "top" }, createdAtMs: 1 };
    expect(selectOwned([it$("o", { category: "outerwear" }), partial, it$("f", { formality: 4 }), it$("w", { seasons: ["winter"] })], { ...ctx, season: "summer" })).toEqual([]);
    expect(selectOwned([it$("n", { modest: false })], { ...ctx, modest: true })).toEqual([]);
    expect(selectOwned([it$("m", { modest: true })], { ...ctx, modest: true })).toEqual([{ slot: "top", itemId: "m" }]);
  });

  it("honours the shopper's selection", () => {
    const picks = selectOwned([it$("a", {}), it$("b", { category: "shoes" })], ctx, new Set(["b"]));
    expect(picks).toEqual([{ slot: "shoes", itemId: "b" }]);
  });
});

// ---- property: owned slots are zero cost and never count against the budget ------------------------

const attrs = fc.record({
  category: fc.constantFrom(...CATEGORIES),
  palette: fc.uniqueArray(fc.constantFrom(...COLOURS), { minLength: 1, maxLength: 3 }),
  pattern: fc.constantFrom(...PATTERNS),
  formality: fc.integer({ min: 0, max: 4 }),
  seasons: fc.uniqueArray(fc.constantFrom(...SEASONS), { minLength: 1, maxLength: 3 }),
  material: fc.constantFrom(...MATERIALS),
  modest: fc.boolean(),
});
const wardrobe = fc.array(attrs, { maxLength: 14 }).map((as) => as.map((a, i): OwnedItem => ({ id: `w${i}`, attributes: a, createdAtMs: i })));
const candidates = fc.array(
  fc.record({
    slot: fc.constantFrom(...SLOTS),
    price: fc.integer({ min: 1, max: 400_000 }),
    store: fc.integer({ min: 0, max: 5 }),
    formality: fc.integer({ min: 0, max: 4 }),
  }),
  { maxLength: 40 },
).map((cs) =>
  cs.map((c, i) => ({
    itemId: `c${i}`,
    storeId: `s${c.store}`,
    slot: c.slot as Slot,
    pricePiastres: BigInt(c.price),
    verifiedDiscountPct: 0,
    colors: ["black"],
    formality: c.formality,
    seasons: ["all" as Season],
    coverage: { sleeve: "long" as const, neckline: "high" as const, length: "maxi" as const },
    popularity: 100,
    inSize: true,
  })),
);

describe("complete from wardrobe: budget arithmetic (property)", () => {
  it("an outfit's total is the sum of what is bought, never above the budget, and owned items cost nothing", () => {
    fc.assert(
      fc.property(
        wardrobe,
        candidates,
        fc.option(fc.integer({ min: 0, max: 800_000 }), { nil: null }),
        fc.constantFrom<EventKind>("work", "wedding_guest", "date", "eid", "university", "travel", "custom"),
        fc.constantFrom(...SEASONS),
        fc.boolean(),
        fc.boolean(),
        (w, cs, budget, kind, season, modest, useMl) => {
          const picks = selectOwned(w, { formality: KIND_FORMALITY[kind], season, modest });
          expect(ownedSlotsConsistent(picks.map((p) => p.slot))).toBe(true);
          const plan = planGap({
            candidates: cs,
            ownedSlots: picks.map((p) => p.slot),
            budgetPiastres: budget === null ? null : BigInt(budget),
            kind,
            season,
            modest,
            useMl,
            styleVector: null,
            freeDeliveryThresholdPiastres: 200_000n,
            now: () => 0,
          });
          if (plan.kind !== "ok") return;
          const owned = new Set(picks.map((p) => p.slot));
          for (const o of plan.outfits) {
            const sum = o.items.reduce((s, i) => s + i.pricePiastres, 0n);
            expect(o.totalPiastres).toBe(sum);
            if (budget !== null) expect(sum <= BigInt(budget)).toBe(true);
            for (const i of o.items) {
              expect(owned.has(i.slot)).toBe(false);
              expect(i.itemId.startsWith("owned:")).toBe(false);
            }
            expect(o.ownedSlots).toEqual(SLOTS.filter((s) => owned.has(s)));
            if (o.ownedOnly) expect(o.totalPiastres).toBe(0n);
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});
