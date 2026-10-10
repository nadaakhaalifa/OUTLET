import { describe, expect, it } from "vitest";
import { SourceEventSchema } from "../domain/ports";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const base = { messageId: U(1), occurredAtMs: 1_800_000_000_000, storeId: U(2), shopperKey: "pseudo-abcdef" };

describe("SourceEventSchema", () => {
  it("accepts a purchase and converts amounts to bigint", () => {
    const r = SourceEventSchema.parse({
      ...base, kind: "purchase", productId: U(3), skuId: U(4), sellerOrderId: U(5), qty: 1,
      grossMinor: "12000", commissionMinor: 1200n, sizeLabel: "M",
    });
    expect(r.kind === "purchase" && r.grossMinor).toBe(12000n);
  });
  it.each(["measurements", "budget_minor", "user_id", "waist_cm"])("rejects a %s property", (key) => {
    const r = SourceEventSchema.safeParse({ ...base, kind: "view", productId: U(3), [key]: 1 });
    expect(r.success).toBe(false);
  });
  it("rejects search terms that look like personal data and normalises others", () => {
    const t = (term: string) => SourceEventSchema.safeParse({ ...base, kind: "search_click", term });
    expect(t("01012345678").success).toBe(false);
    expect(t("a@b.com").success).toBe(false);
    expect(t("https://x.y").success).toBe(false);
    const ok = t("  White   Linen DRESS ");
    expect(ok.success && ok.data.kind === "search_click" && ok.data.term).toBe("white linen dress");
  });
  it("rejects negative or float amounts", () => {
    const p = { ...base, kind: "purchase", productId: U(3), skuId: U(4), sellerOrderId: U(5), qty: 1, commissionMinor: "1", sizeLabel: "M" };
    expect(SourceEventSchema.safeParse({ ...p, grossMinor: "-5" }).success).toBe(false);
    expect(SourceEventSchema.safeParse({ ...p, grossMinor: "1.5" }).success).toBe(false);
  });
});

import { assertRange } from "../application/queries";
describe("window granularity", () => {
  it("snaps windows outward to whole UTC days", () => {
    const D = 86_400_000;
    expect(assertRange({ fromMs: 10 * D + 5_000, toMs: 10 * D + 9_000 })).toEqual({ fromMs: 10 * D, toMs: 11 * D });
  });
});
