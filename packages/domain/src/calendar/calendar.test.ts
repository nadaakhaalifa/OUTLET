import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  KIND_FORMALITY,
  MIN_LEAD_DAYS,
  addDaysToDateKey,
  cairoLocalToUtc,
  cairoOffsetMinutes,
  cairoParts,
  canTransitionLink,
  capDecision,
  combineFeasibility,
  deferOutOfQuietHours,
  deliveryFeasibility,
  inQuietHours,
  isDateKey,
  isOwnedPlaceholder,
  isPast,
  outfitStatus,
  ownedCoversTemplate,
  ownedSlotsConsistent,
  planGap,
  planReminders,
  type GapInput,
} from "./index";
import { SLOTS, type Candidate, type Slot } from "../stylist/types";

const H = 3_600_000;
const D = 24 * H;

describe("cairo time", () => {
  it("resolves the offset from the tz database across the 2026 transitions", () => {
    // DST 2026: starts Friday 24 April 00:00, ends Thursday 29 October 24:00 local.
    expect(cairoOffsetMinutes(Date.UTC(2026, 0, 15, 12))).toBe(120);
    expect(cairoOffsetMinutes(Date.UTC(2026, 5, 15, 12))).toBe(180);
    expect(cairoOffsetMinutes(Date.UTC(2026, 3, 23, 21, 59))).toBe(120);
    expect(cairoOffsetMinutes(Date.UTC(2026, 3, 23, 22, 0))).toBe(180);
    expect(cairoOffsetMinutes(Date.UTC(2026, 9, 29, 20, 59))).toBe(180);
    expect(cairoOffsetMinutes(Date.UTC(2026, 9, 29, 21, 0))).toBe(120);
  });

  it("round trips local wall time around a transition", () => {
    for (const [key, min] of [["2026-04-23", 12 * 60], ["2026-04-25", 9 * 60], ["2026-10-29", 23 * 60], ["2026-10-31", 9 * 60]] as const) {
      const utc = cairoLocalToUtc(key, min);
      const p = cairoParts(utc);
      expect(p.dateKey).toBe(key);
      expect(p.minuteOfDay).toBe(min);
    }
  });

  it("resolves a skipped local time forward and an ambiguous one to the earlier instant", () => {
    // 24 April 2026 00:00 does not exist (clocks jump 00:00 -> 01:00).
    const gap = cairoLocalToUtc("2026-04-24", 30);
    expect(cairoParts(gap).dateKey).toBe("2026-04-24");
    expect(cairoParts(gap).minuteOfDay).toBe(90);
    // Local 23:30 on 29 October happens once (clock goes back at 24:00 to 23:00): earliest instant.
    const amb = cairoLocalToUtc("2026-10-29", 23 * 60 + 30);
    expect(cairoOffsetMinutes(amb)).toBe(180);
  });

  it("validates date keys and adds days", () => {
    expect(isDateKey("2026-02-28")).toBe(true);
    expect(isDateKey("2026-02-30")).toBe(false);
    expect(isDateKey("26-1-1")).toBe(false);
    expect(addDaysToDateKey("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDaysToDateKey("2026-01-01", -1)).toBe("2025-12-31");
    expect(() => addDaysToDateKey("nope", 1)).toThrow();
    expect(() => cairoLocalToUtc("nope", 1)).toThrow();
  });
});

describe("quiet hours and reminders", () => {
  const at = (key: string, hh: number, mm = 0): number => cairoLocalToUtc(key, hh * 60 + mm);

  it("defers a due reminder in quiet hours to 09:00 Cairo", () => {
    expect(inQuietHours(at("2026-06-10", 23, 30))).toBe(true);
    expect(inQuietHours(at("2026-06-10", 2))).toBe(true);
    expect(inQuietHours(at("2026-06-10", 9))).toBe(false);
    expect(inQuietHours(at("2026-06-10", 22, 59))).toBe(false);
    expect(deferOutOfQuietHours(at("2026-06-10", 23, 30))).toBe(at("2026-06-11", 9));
    expect(deferOutOfQuietHours(at("2026-06-10", 3))).toBe(at("2026-06-10", 9));
    const noon = at("2026-06-10", 12);
    expect(deferOutOfQuietHours(noon)).toBe(noon);
  });

  it("plans 7 day and 1 day reminders at the event's local time and skips past ones", () => {
    const starts = at("2026-06-20", 18);
    const plan = planReminders({ startsAtMs: starts, nowMs: at("2026-06-01", 8) });
    expect(plan.map((p) => p.offsetDays)).toEqual([7, 1]);
    expect(plan[0]?.dueAtMs).toBe(at("2026-06-13", 18));
    expect(plan[1]?.dueAtMs).toBe(at("2026-06-19", 18));
    const near = planReminders({ startsAtMs: starts, nowMs: at("2026-06-17", 8) });
    expect(near.map((p) => p.offsetDays)).toEqual([1]);
    expect(planReminders({ startsAtMs: starts, nowMs: starts + 1 })).toEqual([]);
  });

  it("defers an event at 02:00 local out of quiet hours but never past the event", () => {
    const starts = at("2026-06-20", 2);
    const plan = planReminders({ startsAtMs: starts, nowMs: at("2026-06-01", 8) });
    // 1 day before is 02:00 on the 19th: deferred to 09:00, still before the event.
    expect(plan.find((p) => p.offsetDays === 1)?.dueAtMs).toBe(at("2026-06-19", 9));
    const tight = planReminders({ startsAtMs: at("2026-06-20", 0, 30), nowMs: at("2026-06-18", 20), offsetsDays: [0] });
    expect(tight).toEqual([]);
  });

  it("keeps the local hour across the DST change", () => {
    const starts = at("2026-04-28", 18);
    const plan = planReminders({ startsAtMs: starts, nowMs: at("2026-04-01", 8) });
    const seven = plan.find((p) => p.offsetDays === 7);
    expect(seven).toBeDefined();
    expect(cairoParts(seven?.dueAtMs ?? 0).minuteOfDay).toBe(18 * 60);
    expect(cairoParts(seven?.dueAtMs ?? 0).dateKey).toBe("2026-04-21");
  });

  it("enforces the daily and weekly caps by deferring to 09:00 the next day", () => {
    const now = at("2026-06-10", 12);
    expect(capDecision([], now)).toEqual({ kind: "send" });
    expect(capDecision([now - H], now)).toEqual({ kind: "send" });
    expect(capDecision([now - 2 * H, now - H], now)).toEqual({ kind: "defer", untilMs: at("2026-06-11", 9) });
    const week = [1, 2, 3, 4, 5, 6].map((d) => now - d * D);
    expect(capDecision(week, now, { perDay: 5, perWeek: 6 })).toEqual({ kind: "defer", untilMs: at("2026-06-11", 9) });
    expect(capDecision(week.slice(0, 5), now, { perDay: 5, perWeek: 6 })).toEqual({ kind: "send" });
  });
});

describe("delivery feasibility", () => {
  const start = cairoLocalToUtc("2026-06-20", 18 * 60);
  it("flags may_not_arrive for p80 4 days with the event in 3 days, with a cutoff date and no promise", () => {
    const now = start - 3 * D;
    const f = deliveryFeasibility({ nowMs: now, startsAtMs: start, p80Days: 4 });
    expect(f.status).toBe("may_not_arrive");
    expect(f.orderByDateKey).toBe(addDaysToDateKey("2026-06-20", -(4 + MIN_LEAD_DAYS)));
    expect(f.guaranteed).toBe(false);
  });
  it("is ok with enough lead time, still without a guarantee", () => {
    const f = deliveryFeasibility({ nowMs: start - 10 * D, startsAtMs: start, p80Days: 2 });
    expect(f.status).toBe("ok");
    expect(f.guaranteed).toBe(false);
  });
  it("the last order day itself is still ok and the next day is late", () => {
    const cutoff = cairoLocalToUtc(addDaysToDateKey("2026-06-20", -(3 + MIN_LEAD_DAYS)), 20 * 60);
    expect(deliveryFeasibility({ nowMs: cutoff, startsAtMs: start, p80Days: 3 }).status).toBe("ok");
    expect(deliveryFeasibility({ nowMs: cutoff + D, startsAtMs: start, p80Days: 3 }).status).toBe("may_not_arrive");
  });
  it("is unknown without courier data and rounds fractional days up", () => {
    expect(deliveryFeasibility({ nowMs: start - D, startsAtMs: start, p80Days: null }).status).toBe("unknown");
    expect(deliveryFeasibility({ nowMs: start - D, startsAtMs: start, p80Days: -1 }).status).toBe("unknown");
    expect(deliveryFeasibility({ nowMs: start - D, startsAtMs: start, p80Days: Number.NaN }).status).toBe("unknown");
    const a = deliveryFeasibility({ nowMs: start - 5 * D, startsAtMs: start, p80Days: 2.2 });
    expect(a.orderByDateKey).toBe(addDaysToDateKey("2026-06-20", -(3 + MIN_LEAD_DAYS)));
  });
  it("combines worst case", () => {
    const ok = deliveryFeasibility({ nowMs: start - 10 * D, startsAtMs: start, p80Days: 2 });
    const late = deliveryFeasibility({ nowMs: start - 3 * D, startsAtMs: start, p80Days: 4 });
    const unk = deliveryFeasibility({ nowMs: start, startsAtMs: start, p80Days: null });
    expect(combineFeasibility([ok, late, unk]).status).toBe("may_not_arrive");
    expect(combineFeasibility([ok, unk]).status).toBe("unknown");
    expect(combineFeasibility([ok]).status).toBe("ok");
    expect(combineFeasibility([]).status).toBe("unknown");
    expect(combineFeasibility([ok, ok]).guaranteed).toBe(false);
  });
});

const cand = (id: string, slot: Slot, egp: number, over: Partial<Candidate> = {}): Candidate => ({
  itemId: id,
  storeId: `s${(id.length + egp) % 4}`,
  slot,
  pricePiastres: BigInt(egp) * 100n,
  verifiedDiscountPct: 0,
  colors: ["black"],
  formality: 2,
  seasons: ["all"],
  coverage: { sleeve: "long", neckline: "high", length: "maxi" },
  popularity: 500,
  inSize: true,
  ...over,
});

const catalog = (): Candidate[] => SLOTS.flatMap((slot) => [0, 1, 2, 3].map((i) => cand(`${slot}-${i}`, slot, 100 + i * 120, { storeId: `s${i % 3}`, popularity: 300 + i * 50 })));

const base = (over: Partial<GapInput> = {}): GapInput => ({
  candidates: catalog(),
  ownedSlots: [],
  budgetPiastres: 200_000n,
  kind: "work",
  season: "all",
  modest: false,
  useMl: true,
  styleVector: null,
  freeDeliveryThresholdPiastres: 200_000n,
  ...over,
});

describe("owned slots", () => {
  it("accepts subsets of one template and rejects a dress with a top", () => {
    expect(ownedSlotsConsistent([])).toBe(true);
    expect(ownedSlotsConsistent(["shoes", "bag"])).toBe(true);
    expect(ownedSlotsConsistent(["dress", "shoes"])).toBe(true);
    expect(ownedSlotsConsistent(["dress", "top"])).toBe(false);
    expect(ownedSlotsConsistent(["dress", "bottom"])).toBe(false);
    expect(ownedCoversTemplate(["top", "bottom", "shoes", "bag", "accessory"])).toBe(true);
    expect(ownedCoversTemplate(["dress", "shoes", "bag", "accessory"])).toBe(true);
    expect(ownedCoversTemplate(["dress", "shoes"])).toBe(false);
  });
});

describe("planGap", () => {
  it("lists only items for the missing slots and prices only those", () => {
    const r = planGap(base({ ownedSlots: ["shoes", "bag"] }));
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.outfits.length).toBeGreaterThan(0);
    for (const o of r.outfits) {
      expect(o.items.some((i) => i.slot === "shoes" || i.slot === "bag")).toBe(false);
      expect(o.items.some((i) => isOwnedPlaceholder(i.itemId))).toBe(false);
      expect(o.totalPiastres).toBe(o.items.reduce((s, i) => s + i.pricePiastres, 0n));
      expect(o.ownedSlots).toEqual(["shoes", "bag"]);
      expect(o.ownedOnly).toBe(false);
    }
  });

  it("returns an owned-only outfit with no purchases when the shopper owns everything", () => {
    const r = planGap(base({ ownedSlots: ["dress", "shoes", "bag", "accessory"], useMl: false }));
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.outfits).toHaveLength(1);
    expect(r.outfits[0]?.ownedOnly).toBe(true);
    expect(r.outfits[0]?.items).toEqual([]);
    expect(r.outfits[0]?.totalPiastres).toBe(0n);
    expect(r.outfits[0]?.source).toBe("rules");
  });

  it("rejects inconsistent owned slots", () => {
    expect(planGap(base({ ownedSlots: ["dress", "top"] })).kind).toBe("invalid_owned_slots");
  });

  it("uses the rules fallback when ML is off and flags the source", () => {
    const r = planGap(base({ useMl: false }));
    expect(r.kind === "ok" && r.source).toBe("rules");
    if (r.kind === "ok") for (const o of r.outfits) expect(o.source).toBe("rules");
  });

  it("returns a partial outfit with the budget shortfall when nothing fits", () => {
    const r = planGap(base({ budgetPiastres: 30_000n }));
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    for (const o of r.outfits) {
      expect(o.totalPiastres <= 30_000n).toBe(true);
      if (!o.complete) expect(o.missing.length).toBeGreaterThan(0);
    }
  });

  it("owned items are free: the gap fits a budget the full outfit would not", () => {
    const cheapest = (slot: Slot): bigint => catalog().filter((c) => c.slot === slot).reduce((m, c) => (c.pricePiastres < m ? c.pricePiastres : m), 10n ** 12n);
    const full = (["top", "bottom", "shoes", "bag", "accessory"] as const).reduce((s, x) => s + cheapest(x), 0n);
    const budget = full - 1n;
    const without = planGap(base({ budgetPiastres: budget, useMl: false }));
    expect(without.kind === "ok" && without.outfits.every((o) => !o.complete)).toBe(true);
    const withOwned = planGap(base({ budgetPiastres: budget, ownedSlots: ["shoes"], useMl: false }));
    expect(withOwned.kind === "ok" && withOwned.outfits.some((o) => o.complete)).toBe(true);
  });

  it("modest events exclude non-modest items", () => {
    const items = catalog().map((c) => (c.slot === "top" ? { ...c, coverage: { sleeve: "short" as const, neckline: "mid" as const, length: "n/a" as const } } : c));
    const r = planGap(base({ candidates: items, modest: true, useMl: false }));
    if (r.kind === "ok") for (const o of r.outfits) expect(o.items.some((i) => i.slot === "top")).toBe(false);
  });

  it("drops an outfit that would exceed the budget even if the optimizer returned one", () => {
    const r = planGap(base({ budgetPiastres: 0n }));
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") for (const o of r.outfits) expect(o.totalPiastres).toBe(0n);
  });

  it("property: the gap total never exceeds the budget and no placeholder or owned slot leaks", () => {
    const candArb = fc.record({
      slot: fc.constantFrom(...SLOTS),
      egp: fc.integer({ min: 10, max: 2_000 }),
      store: fc.integer({ min: 0, max: 3 }),
      inSize: fc.boolean(),
      pop: fc.integer({ min: 0, max: 1000 }),
      colour: fc.constantFrom("black", "white", "red", "olive", "blue", "orange"),
      formality: fc.integer({ min: 0, max: 4 }),
    });
    const ownedArb = fc.constantFrom<readonly Slot[]>([], ["shoes"], ["bag", "accessory"], ["top", "bottom"], ["dress"], ["shoes", "bag", "accessory"]);
    fc.assert(
      fc.property(
        fc.array(candArb, { minLength: 0, maxLength: 40 }),
        fc.option(fc.integer({ min: 0, max: 600_000 }), { nil: null }),
        ownedArb,
        fc.boolean(),
        fc.constantFrom(...(Object.keys(KIND_FORMALITY) as (keyof typeof KIND_FORMALITY)[])),
        fc.boolean(),
        (cs, budget, owned, useMl, kind, modest) => {
          const candidates: Candidate[] = cs.map((c, i) =>
            cand(`i${i}`, c.slot, c.egp, { storeId: `s${c.store}`, inSize: c.inSize, popularity: c.pop, colors: [c.colour], formality: c.formality }),
          );
          const r = planGap({
            candidates,
            ownedSlots: owned,
            budgetPiastres: budget === null ? null : BigInt(budget) * 100n,
            kind,
            season: "all",
            modest,
            useMl,
            styleVector: null,
            freeDeliveryThresholdPiastres: 200_000n,
          });
          if (r.kind !== "ok") return false;
          for (const o of r.outfits) {
            if (budget !== null && o.totalPiastres > BigInt(budget) * 100n) return false;
            if (o.remainingBudgetPiastres !== null && o.remainingBudgetPiastres < 0n) return false;
            if (o.items.some((i) => isOwnedPlaceholder(i.itemId) || owned.includes(i.slot) || !i.inSize)) return false;
            if (o.totalPiastres !== o.items.reduce((s, i) => s + i.pricePiastres, 0n)) return false;
          }
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("status and link transitions", () => {
  it("derives the outfit status", () => {
    expect(outfitStatus({ ownedSlots: [], linkStatuses: [] })).toBe("none");
    expect(outfitStatus({ ownedSlots: ["shoes"], linkStatuses: ["planned"] })).toBe("needs_purchases");
    expect(outfitStatus({ ownedSlots: [], linkStatuses: ["in_bag"] })).toBe("needs_purchases");
    expect(outfitStatus({ ownedSlots: [], linkStatuses: ["purchased"] })).toBe("planned");
    expect(outfitStatus({ ownedSlots: [], linkStatuses: ["worn"] })).toBe("planned");
    expect(outfitStatus({ ownedSlots: ["dress", "shoes", "bag", "accessory"], linkStatuses: [] })).toBe("owned_only");
  });
  it("only allows forward link transitions", () => {
    expect(canTransitionLink("planned", "in_bag")).toBe(true);
    expect(canTransitionLink("in_bag", "purchased")).toBe(true);
    expect(canTransitionLink("purchased", "worn")).toBe(true);
    expect(canTransitionLink("worn", "planned")).toBe(false);
    expect(canTransitionLink("planned", "worn")).toBe(false);
    expect(canTransitionLink("x", "planned")).toBe(false);
  });
  it("detects past events", () => {
    expect(isPast(10, 10)).toBe(true);
    expect(isPast(11, 10)).toBe(false);
  });
});
