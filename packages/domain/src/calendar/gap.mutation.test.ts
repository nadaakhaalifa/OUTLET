// Targeted tests for the calendar gap-fill planner: budget guard, owned-slot handling, ML/rules source
// selection and link-status helpers. Written to kill Stryker survivors (ADR-0019).
import { describe, expect, it } from "vitest";
import { SLOTS, type Candidate, type Slot } from "../stylist/types";
import {
  KIND_FORMALITY,
  canTransitionLink,
  isOwnedPlaceholder,
  isPast,
  outfitStatus,
  ownedCoversTemplate,
  ownedPlaceholder,
  planGap,
  type GapInput,
} from "./index";

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
const catalog = (): Candidate[] =>
  SLOTS.flatMap((slot) => [0, 1, 2, 3].map((i) => cand(`${slot}-${i}`, slot, 100 + i * 120, { storeId: `s${i % 3}`, popularity: 300 + i * 50 })));
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

describe("ownedPlaceholder", () => {
  it("is a free, in-size, neutral item keyed by slot", () => {
    const p = ownedPlaceholder("shoes", 3);
    expect(p).toEqual({
      itemId: "owned:shoes",
      storeId: "owned:shoes",
      slot: "shoes",
      pricePiastres: 0n,
      verifiedDiscountPct: 0,
      colors: [],
      formality: 3,
      seasons: ["all"],
      coverage: { sleeve: "n/a", neckline: "n/a", length: "n/a" },
      popularity: 0,
      inSize: true,
    });
    expect(isOwnedPlaceholder("owned:bag")).toBe(true);
    expect(isOwnedPlaceholder("bag-1")).toBe(false);
    expect(isOwnedPlaceholder("xowned:bag")).toBe(false);
  });
  it("event formality table is exact", () => {
    expect(KIND_FORMALITY).toEqual({ work: 2, wedding_guest: 4, date: 3, eid: 3, university: 1, travel: 1, custom: 1 });
  });
});

describe("planGap owned-only", () => {
  it("echoes the budget, canonical slot order, and the source for ml and rules", () => {
    const all: Slot[] = ["accessory", "bag", "shoes", "dress"];
    const ml = planGap(base({ ownedSlots: all, budgetPiastres: 12_345n }));
    expect(ml).toEqual({
      kind: "ok",
      source: "ml",
      outfits: [
        {
          items: [],
          ownedSlots: ["dress", "shoes", "bag", "accessory"],
          totalPiastres: 0n,
          complete: true,
          missing: [],
          score: 0,
          source: "ml",
          ownedOnly: true,
          remainingBudgetPiastres: 12_345n,
        },
      ],
    });
    const rules = planGap(base({ ownedSlots: all, budgetPiastres: null, useMl: false }));
    expect(rules.kind === "ok" && rules.source).toBe("rules");
    expect(rules.kind === "ok" && rules.outfits[0]?.remainingBudgetPiastres).toBeNull();
    expect(rules.kind === "ok" && rules.outfits[0]?.source).toBe("rules");
  });
  it("duplicate owned slots are folded", () => {
    const r = planGap(base({ ownedSlots: ["dress", "dress", "shoes", "shoes", "bag", "accessory"] }));
    expect(r.kind === "ok" && r.outfits[0]?.ownedSlots).toEqual(["dress", "shoes", "bag", "accessory"]);
  });
});

describe("planGap budget guard and bookkeeping", () => {
  // One item per slot, each in its own store, so the cheapest completion is unique and costs exactly 500 EGP.
  const single = (): Candidate[] => (["top", "bottom", "shoes", "bag", "accessory"] as const).map((s, i) => cand(`${s}-only`, s, 100, { storeId: `st${i}` }));
  const exact = 50_000n;
  it("a total exactly equal to the budget is allowed; one piastre less drops the outfit", () => {
    for (const useMl of [false, true]) {
      const r = planGap(base({ candidates: single(), budgetPiastres: exact, useMl }));
      expect(r.kind).toBe("ok");
      if (r.kind !== "ok") return;
      const full = r.outfits.filter((o) => o.complete);
      expect(full).toHaveLength(1);
      expect(full[0]?.totalPiastres).toBe(exact);
      expect(full[0]?.remainingBudgetPiastres).toBe(0n);
      const under = planGap(base({ candidates: single(), budgetPiastres: exact - 1n, useMl }));
      expect(under.kind === "ok" && under.outfits.some((o) => o.complete)).toBe(false);
      if (under.kind === "ok") for (const o of under.outfits) expect(o.totalPiastres).toBeLessThanOrEqual(exact - 1n);
    }
  });
  it("with no budget every outfit passes and remaining is null", () => {
    const r = planGap(base({ budgetPiastres: null, useMl: false }));
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.outfits.length).toBeGreaterThan(0);
    for (const o of r.outfits) expect(o.remainingBudgetPiastres).toBeNull();
  });
  it("ml path: remaining budget is computed and outfit sources are ml", () => {
    const r = planGap(base());
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.source).toBe("ml");
    expect(r.outfits.length).toBeGreaterThan(0);
    for (const o of r.outfits) {
      expect(o.source).toBe("ml");
      expect(o.remainingBudgetPiastres).toBe(200_000n - o.totalPiastres);
      expect(o.ownedOnly).toBe(false);
      expect(o.ownedSlots).toEqual([]);
    }
  });
  it("candidates that look like owned placeholders are never offered", () => {
    const poison = cand("owned:top", "top", 1, { storeId: "owned:top" });
    const r = planGap(base({ candidates: [...catalog(), poison], useMl: false, budgetPiastres: null }));
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    for (const o of r.outfits) expect(o.items.some((i) => i.itemId === "owned:top")).toBe(false);
    const ml = planGap(base({ candidates: [...catalog(), poison] }));
    if (ml.kind === "ok") for (const o of ml.outfits) expect(o.items.some((i) => i.itemId === "owned:top")).toBe(false);
  });
  it("locked owned slots are excluded from items but their slots are reported", () => {
    const r = planGap(base({ ownedSlots: ["top", "bottom"], useMl: false }));
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    for (const o of r.outfits) {
      expect(o.items.map((i) => i.slot).sort()).toEqual(["accessory", "bag", "shoes"]);
      expect(o.ownedSlots).toEqual(["top", "bottom"]);
    }
  });
  it("a budget that cannot fit anything drops every outfit that overshoots", () => {
    const r = planGap(base({ budgetPiastres: 1n, useMl: false }));
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    for (const o of r.outfits) expect(o.totalPiastres).toBeLessThanOrEqual(1n);
  });
});

describe("planGap injected clock", () => {
  it("passes the clock to the optimizer; a clock past the deadline still yields a complete, in-budget outfit", () => {
    let t = 0;
    const clock = (): number => (t += 1_000_000);
    const r = planGap(base({ now: clock }));
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(t).toBeGreaterThan(0);
    expect(r.outfits.some((o) => o.complete)).toBe(true);
    for (const o of r.outfits) expect(o.totalPiastres).toBeLessThanOrEqual(200_000n);
  });
  it("rules mode never calls the clock", () => {
    let calls = 0;
    planGap(base({ useMl: false, now: () => (calls += 1) }));
    expect(calls).toBe(0);
  });
});

describe("outfitStatus and link transitions", () => {
  const full: Slot[] = ["dress", "shoes", "bag", "accessory"];
  it("status priority", () => {
    expect(ownedCoversTemplate(full)).toBe(true);
    expect(outfitStatus({ ownedSlots: full, linkStatuses: ["planned"] })).toBe("owned_only");
    expect(outfitStatus({ ownedSlots: [], linkStatuses: [] })).toBe("none");
    expect(outfitStatus({ ownedSlots: [], linkStatuses: ["planned", "in_bag"] })).toBe("needs_purchases");
    expect(outfitStatus({ ownedSlots: [], linkStatuses: ["planned", "purchased"] })).toBe("planned");
    expect(outfitStatus({ ownedSlots: [], linkStatuses: ["worn"] })).toBe("planned");
    expect(outfitStatus({ ownedSlots: [], linkStatuses: ["in_bag"] })).toBe("needs_purchases");
  });
  it("transition table is exact", () => {
    const all = ["planned", "in_bag", "purchased", "worn"];
    const allowed: Record<string, string[]> = { planned: ["in_bag"], in_bag: ["planned", "purchased"], purchased: ["worn"], worn: [] };
    for (const f of all) for (const t of all) expect(canTransitionLink(f, t)).toBe((allowed[f] ?? []).includes(t));
    expect(canTransitionLink("nope", "planned")).toBe(false);
    expect(canTransitionLink("worn", "worn")).toBe(false);
  });
  it("isPast is inclusive of the start instant", () => {
    expect(isPast(100, 100)).toBe(true);
    expect(isPast(101, 100)).toBe(false);
  });
});
