import { describe, expect, it } from "vitest";
import {
  FIXTURE_OUTFITS, InMemoryStylistPort, PortError, addOutcome, budgetFit, buildOutfitViews, itemsTotal, parseBudgetEgp, replaceOutfit, stylistFailureState,
  type Outfit,
} from "./model";

describe("budget parsing", () => {
  it("treats empty as no limit and converts whole EGP to piastres", () => {
    expect(parseBudgetEgp("  ")).toEqual({ ok: true, value: null });
    expect(parseBudgetEgp("3000")).toEqual({ ok: true, value: 300_000n });
    expect(parseBudgetEgp("١٥٠٠")).toEqual({ ok: true, value: 150_000n });
  });
  it("rejects zero, decimals and junk", () => {
    for (const s of ["0", "12.5", "-3", "abc", "99999999"]) expect(parseBudgetEgp(s)).toEqual({ ok: false });
  });
});

describe("budget fit", () => {
  it("never reports an over-budget outfit as fitting", () => {
    expect(budgetFit(100n, null)).toEqual({ kind: "none" });
    expect(budgetFit(100n, 100n)).toEqual({ kind: "exact" });
    expect(budgetFit(90n, 100n)).toEqual({ kind: "fits", spare: 10n });
    expect(budgetFit(130n, 100n)).toEqual({ kind: "over", by: 30n });
  });
  it("sums prices across stores in piastres", () => {
    expect(itemsTotal(FIXTURE_OUTFITS[0]!)).toBe(210_000n);
  });
});

describe("outfit views", () => {
  it("marks partial outfits with the server shortfall and caps at five", () => {
    const many: Outfit[] = Array.from({ length: 7 }, (_, i) => ({ ...FIXTURE_OUTFITS[0]!, id: `o${i}` }));
    expect(buildOutfitViews(many, null)).toHaveLength(5);
    const v = buildOutfitViews(FIXTURE_OUTFITS, 300_000n);
    expect(v[1]!.isPartial).toBe(true);
    expect(v[1]!.missing[0]).toEqual({ slot: "shoes", shortfall: 25_000n });
    expect(v[0]!.isPartial).toBe(false);
  });
  it("drops empty outfits and replaces a swapped one in place", () => {
    expect(buildOutfitViews([{ id: "x", items: [], deliveries: [], missing: [] }], null)).toHaveLength(0);
    const next = { ...FIXTURE_OUTFITS[0]!, items: [] };
    expect(replaceOutfit(FIXTURE_OUTFITS, next)[0]).toBe(next);
    expect(replaceOutfit(FIXTURE_OUTFITS, next)[1]).toBe(FIXTURE_OUTFITS[1]);
  });
});

describe("add to bag", () => {
  it("reports rejected items explicitly instead of dropping them", async () => {
    const port = new InMemoryStylistPort(FIXTURE_OUTFITS, "ai", null, [{ skuId: "a2", reason: "soldOut", currentPrice: null }]);
    const r = await port.addOutfit("o1");
    expect(r.added).toEqual(["a1", "a3"]);
    expect(addOutcome(r).kind).toBe("partial");
    expect(addOutcome({ added: ["a"], rejected: [] }).kind).toBe("added");
    expect(addOutcome({ added: [], rejected: r.rejected }).kind).toBe("none");
  });
});

describe("failures and fallback", () => {
  it("maps offline vs failed and carries the rules source", async () => {
    const port = new InMemoryStylistPort(FIXTURE_OUTFITS, "rules");
    expect((await port.generate()).source).toBe("rules");
    port.setFailure("offline");
    await expect(port.generate()).rejects.toBeInstanceOf(PortError);
    expect(stylistFailureState(new PortError("offline"))).toEqual({ status: "error", offline: true });
    expect(stylistFailureState(new Error("x"))).toEqual({ status: "error", offline: false });
  });
  it("records feedback and swaps an item", async () => {
    const port = new InMemoryStylistPort();
    await port.feedback("o1", "a1", "dislike");
    expect(port.feedbackLog).toEqual(["o1:a1:dislike"]);
    const o = await port.swap("o1", "a1");
    expect(o.items[0]!.skuId).toBe("a1-alt");
  });
});
