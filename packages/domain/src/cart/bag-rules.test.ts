import { describe, expect, it } from "vitest";
import { planAdd, validateQty, type ExistingLine } from "./bag-rules";
import { InvalidCartInputError } from "./errors";
import { rankSuggestions } from "./suggestions";
import { money } from "../money";

const mk = (count: number): ExistingLine[] =>
  Array.from({ length: count }, (_, i) => ({ lineId: `l${i}`, skuId: `s${i}`, qty: 1, state: "IN_BAG" as const }));

describe("planAdd", () => {
  it("creates a new line", () => {
    expect(planAdd([], "s", 2)).toEqual({ kind: "create", qty: 2 });
  });
  it("merges into the existing SKU line, including a saved one", () => {
    const ex: ExistingLine[] = [{ lineId: "l", skuId: "s", qty: 4, state: "SAVED_FOR_LATER" }];
    expect(planAdd(ex, "s", 3)).toEqual({ kind: "merge", lineId: "l", qty: 7 });
  });
  it("allows exactly 10 units and rejects 11", () => {
    const ex: ExistingLine[] = [{ lineId: "l", skuId: "s", qty: 9, state: "IN_BAG" }];
    expect(planAdd(ex, "s", 1)).toEqual({ kind: "merge", lineId: "l", qty: 10 });
    expect(planAdd(ex, "s", 2)).toEqual({ kind: "rejected", reason: "sku_unit_limit_reached" });
  });
  it("allows the 50th line and rejects the 51st, but still merges at 50", () => {
    expect(planAdd(mk(49), "new", 1).kind).toBe("create");
    expect(planAdd(mk(50), "new", 1)).toEqual({ kind: "rejected", reason: "line_limit_reached" });
    expect(planAdd(mk(50), "s3", 1)).toEqual({ kind: "merge", lineId: "l3", qty: 2 });
  });
  it("rejects invalid quantities", () => {
    for (const q of [0, -1, 11, 1.5, Number.NaN]) expect(() => planAdd([], "s", q)).toThrow(InvalidCartInputError);
    expect(validateQty(10)).toBe(10);
    expect(() => validateQty(11)).toThrow(InvalidCartInputError);
  });
});

describe("rankSuggestions", () => {
  const c = (skuId: string, p: bigint) => ({ skuId, unitPrice: money(p) });
  it("puts single-item unlockers first by ascending price, then partials by descending price", () => {
    const out = rankSuggestions(money(5000n), [c("a", 1000n), c("b", 9000n), c("c", 5000n), c("d", 4000n)], 10);
    expect(out.map((x) => x.skuId)).toEqual(["c", "b", "d", "a"]);
  });
  it("is empty when nothing remains and honours the limit", () => {
    expect(rankSuggestions(money(0n), [c("a", 1n)], 5)).toEqual([]);
    expect(rankSuggestions(money(100n), [c("a", 1n), c("b", 2n)], 1)).toHaveLength(1);
    expect(rankSuggestions(money(100n), [c("a", 1n)], 0)).toEqual([]);
  });
  it("breaks price ties by sku id", () => {
    const out = rankSuggestions(money(100n), [c("z", 200n), c("m", 200n)], 5);
    expect(out.map((x) => x.skuId)).toEqual(["m", "z"]);
  });
});
