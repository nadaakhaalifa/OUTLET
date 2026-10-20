import { describe, expect, it } from "vitest";
import { productSegment, idFromSegment } from "../lib/paths";
import { sizeRows } from "../view-models/product";
import type { Product } from "../view-models/types";

const ID = "00000000-0000-4000-8000-000000000810";
const m = (a: number) => ({ amount: String(a), currency: "EGP" as const });
const base = (skus: Product["skus"]): Product => ({
  id: ID, title: { ar: "ف" }, store: { id: ID, slug: "n", name: { ar: "م" }, kind: "local", verified_badge: false, live_drop: false },
  price: { price: m(100), badge: "none" }, condition: "sample", department: "unisex", sponsored: false, images: [], skus,
  return_eligibility: { returnable: false }, seller_legal_identity_visible: false, size_chart_available: false, updated_at: "2026-10-01T00:00:00Z",
});

describe("public product view model", () => {
  it("surfaces units_left only for 1..5 on available SKUs", () => {
    const sku = (n: number | null, available = true) => ({ id: ID, size_label: "M", available, units_left: n, price: { price: m(100), badge: "none" as const } });
    const rows = sizeRows(base([sku(3), sku(null), sku(6), sku(0), sku(2, false)]), undefined);
    expect(rows.map((r) => r.unitsLeft)).toEqual([3, null, null, null, null]);
  });
  it("product segment is the bare lowercase id and round-trips", () => {
    expect(productSegment(ID.toUpperCase())).toBe(ID);
    expect(idFromSegment(productSegment(ID))).toBe(ID);
  });
});
