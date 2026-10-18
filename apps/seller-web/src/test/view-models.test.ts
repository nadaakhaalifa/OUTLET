import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parsePriceToPiastres, validateProduct, type ProductDraft } from "../view-models/product-form";
import { checkCatalogCsv, parseCsv } from "../view-models/csv-import";
import { checkChart, sortSizeRows } from "../view-models/size-chart";
import { slaCountdown } from "../view-models/sla";
import { availableActions } from "../view-models/orders";
import { navFor, navForAccess } from "../view-models/nav";
import { NO_PERMISSIONS, permissionsFor } from "./permissions";
import { stateFromError } from "../view-models/screen-state";
import { defaultRange } from "../view-models/analytics";

const CAT = "0f4c1c1e-2a55-4f7e-9d2b-1a2b3c4d5e6f";

describe("slaCountdown", () => {
  const deadline = "2026-10-12T10:00:00Z";
  const now = Date.parse("2026-10-11T10:00:00Z");
  it("counts from the server clock plus elapsed monotonic time", () => {
    expect(slaCountdown({ deadlineIso: deadline, serverNowMs: now, elapsedSinceFetchMs: 0 })).toMatchObject({ level: "ok", hours: 24, minutes: 0 });
    expect(slaCountdown({ deadlineIso: deadline, serverNowMs: now, elapsedSinceFetchMs: 23 * 3_600_000 + 30 * 60_000 })).toMatchObject({ level: "warning", hours: 0, minutes: 30 });
  });
  it("is overdue at and after the deadline", () => {
    expect(slaCountdown({ deadlineIso: deadline, serverNowMs: Date.parse(deadline), elapsedSinceFetchMs: 0 }).level).toBe("overdue");
  });
  it("shows no countdown without a server time or a deadline (no guessing)", () => {
    expect(slaCountdown({ deadlineIso: deadline, serverNowMs: null, elapsedSinceFetchMs: 5 }).level).toBe("none");
    expect(slaCountdown({ deadlineIso: null, serverNowMs: now, elapsedSinceFetchMs: 5 }).level).toBe("none");
    expect(slaCountdown({ deadlineIso: "garbage", serverNowMs: now, elapsedSinceFetchMs: 5 }).level).toBe("none");
  });
  it("property: remaining never increases as elapsed grows", () => {
    fc.assert(fc.property(fc.nat(10 ** 8), fc.nat(10 ** 8), (a, b) => {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      const x = slaCountdown({ deadlineIso: deadline, serverNowMs: now, elapsedSinceFetchMs: lo });
      const y = slaCountdown({ deadlineIso: deadline, serverNowMs: now, elapsedSinceFetchMs: hi });
      expect(y.remainingMs).toBeLessThanOrEqual(x.remainingMs);
    }));
  });
});

describe("orders actions + nav", () => {
  it("maps status to the next allowed actions", () => {
    expect(availableActions("PAID", permissionsFor("warehouse"))).toEqual(["accept", "reject"]);
    expect(availableActions("CONFIRMED_COD", null)).toEqual(["accept", "reject"]);
    expect(availableActions("ACCEPTED", permissionsFor("owner"))).toEqual(["pack"]);
    expect(availableActions("PACKED", permissionsFor("manager"))).toEqual(["create_shipment"]);
    expect(availableActions("SHIPPED", permissionsFor("owner"))).toEqual([]);
  });
  it("hides actions without store_order.update (finance, catalog, support, suspended store)", () => {
    expect(availableActions("PAID", permissionsFor("finance"))).toEqual([]);
    expect(availableActions("PAID", permissionsFor("catalog"))).toEqual([]);
    expect(availableActions("PAID", permissionsFor("support"))).toEqual([]);
    expect(availableActions("PAID", NO_PERMISSIONS)).toEqual([]);
  });
  it("filters nav by permission and shows all when not enforced", () => {
    expect(navFor(permissionsFor("finance")).map((i) => i.href)).toContain("/finance");
    expect(navFor(null).length).toBeGreaterThan(navFor(permissionsFor("finance")).length);
    expect(navForAccess({ kind: "open" }).length).toBe(navFor(null).length);
  });
});

describe("price parsing and product validation", () => {
  it("parses prices to exact piastres", () => {
    expect(parsePriceToPiastres("649")).toBe(64900n);
    expect(parsePriceToPiastres("649.5")).toBe(64950n);
    expect(parsePriceToPiastres("٦٤٩٫٥٠")).toBe(64950n);
    expect(parsePriceToPiastres("0")).toBeNull();
    expect(parsePriceToPiastres("1.234")).toBeNull();
    expect(parsePriceToPiastres("-5")).toBeNull();
    expect(parsePriceToPiastres("")).toBeNull();
  });
  it("property: whole pounds round-trip through piastres", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 0, max: 99 }), (w, c) => {
      expect(parsePriceToPiastres(`${w}.${String(c).padStart(2, "0")}`)).toBe(BigInt(w) * 100n + BigInt(c));
    }));
  });
  const ok: ProductDraft = {
    titleAr: "فستان صيفي", titleEn: "", descriptionAr: "وصف", categoryId: CAT, condition: "new_with_tags",
    defectPhotoUploadIds: [], imageUploadIds: [], sizeChartId: "", skus: [{ sizeLabel: "M", price: "649.50", stock: "5" }],
  };
  it("accepts a valid product and produces integer-string money", () => {
    const r = validateProduct(ok);
    expect(r.errors).toEqual([]);
    expect(r.body?.skus[0]).toEqual({ size_label: "M", price: { amount: "64950", currency: "EGP" }, initial_stock: 5 });
    expect(r.body?.title).toEqual({ ar: "فستان صيفي" });
  });
  it("requires an Arabic title containing Arabic letters", () => {
    expect(validateProduct({ ...ok, titleAr: "" }).errors[0]?.messageKey).toBe("editor.error.titleArRequired");
    expect(validateProduct({ ...ok, titleAr: "Summer dress" }).errors[0]?.messageKey).toBe("editor.error.titleArNoArabic");
  });
  it("requires defect photos for minor_defect and at least one sku", () => {
    expect(validateProduct({ ...ok, condition: "minor_defect" }).errors.map((e) => e.field)).toContain("defectPhotos");
    expect(validateProduct({ ...ok, skus: [] }).errors.map((e) => e.field)).toContain("skus");
  });
  it("flags per-sku field errors with index", () => {
    const r = validateProduct({ ...ok, skus: [{ sizeLabel: "", price: "0", stock: "x" }] });
    expect(r.errors.map((e) => e.field)).toEqual(["sku.0.sizeLabel", "sku.0.price", "sku.0.stock"]);
    expect(r.body).toBeNull();
  });
});

describe("size chart editor", () => {
  const row = (sizeLabel: string, bust: string, waist: string) => ({ sizeLabel, values: { bust_cm: bust, waist_cm: waist } });
  it("accepts a monotonic chart", () => {
    const c = checkChart({ productType: "tops", unit: "cm", rows: [row("S", "88", "70"), row("M", "92", "74"), row("L", "96", "78")] });
    expect(c.valid).toBe(true);
    expect(c.body?.rows).toHaveLength(3);
  });
  it("reports non-monotonic and too-large steps", () => {
    const c = checkChart({ productType: "tops", unit: "cm", rows: [row("S", "88", "70"), row("M", "84", "74")] });
    expect(c.issues.map((i) => i.code)).toContain("not_monotonic");
    const d = checkChart({ productType: "tops", unit: "cm", rows: [row("S", "80", "60"), row("M", "120", "64")] });
    expect(d.issues.map((i) => i.code)).toContain("delta_too_large");
  });
  it("sorts alpha sizes so entry order does not matter", () => {
    expect(sortSizeRows([{ sizeLabel: "L" }, { sizeLabel: "S" }, { sizeLabel: "M" }]).map((r) => r.sizeLabel)).toEqual(["S", "M", "L"]);
    const c = checkChart({ productType: "tops", unit: "cm", rows: [row("L", "96", "78"), row("S", "88", "70"), row("M", "92", "74")] });
    expect(c.valid).toBe(true);
  });
  it("reads Eastern Arabic digits and rejects non-numbers", () => {
    const c = checkChart({ productType: "tops", unit: "cm", rows: [row("S", "٨٨", "70"), row("M", "9x", "74")] });
    expect(c.issues.some((i) => i.code === "not_a_number")).toBe(true);
  });
  it("requires the template measures for the product type", () => {
    const c = checkChart({ productType: "tops", unit: "cm", rows: [{ sizeLabel: "S", values: { bust_cm: "88" } }] });
    expect(c.issues.map((i) => i.code)).toContain("missing_measure");
  });
  it("accepts inches by normalising before range checks", () => {
    const c = checkChart({ productType: "tops", unit: "in", rows: [row("S", "34.5", "27"), row("M", "36", "28.5")] });
    expect(c.valid).toBe(true);
  });
});

describe("catalog csv import check", () => {
  const H = "title_ar,title_en,category_id,condition,size_label,price_piastres,stock";
  it("parses quoted fields, doubled quotes and CRLF", () => {
    expect(parseCsv('a,"b,c","d""e"\r\nx,y,z\r\n')).toEqual([["a", "b,c", 'd"e'], ["x", "y", "z"]]);
  });
  it("reports row and column for each problem, with correct counts", () => {
    const csv = [H, `فستان,Dress,${CAT},new_with_tags,M,64900,5`, `Dress,Dress,${CAT},new_with_tags,M,64900,5`, `فستان,Dress,bad,wat,,0,-1`].join("\n");
    const r = checkCatalogCsv(csv);
    expect(r.rowsTotal).toBe(3);
    expect(r.rowsOk).toBe(1);
    expect(r.rowsFailed).toBe(2);
    expect(r.errors.filter((e) => e.row === 3).map((e) => e.code)).toEqual(["title_ar_missing"]);
    expect(r.errors.filter((e) => e.row === 4).map((e) => e.column)).toEqual(["category_id", "condition", "size_label", "price_piastres", "stock"]);
  });
  it("requires an English title per row", () => {
    const r = checkCatalogCsv([H, `فستان,,${CAT},new_with_tags,M,64900,5`].join("\n"));
    expect(r.errors.map((e) => [e.row, e.column, e.code])).toEqual([[2, "title_en", "title_en_missing"]]);
  });
  it("fails the file on missing or unknown headers and empty files", () => {
    expect(checkCatalogCsv("title_ar,price_piastres\nx,1").errors.map((e) => e.code)).toContain("missing_header");
    expect(checkCatalogCsv(`${H},evil\n`).errors.map((e) => e.code)).toContain("unknown_header");
    expect(checkCatalogCsv("").errors[0]?.code).toBe("empty");
    expect(checkCatalogCsv(`${H}\n`).errors[0]?.code).toBe("empty");
  });
  it("flags rows with the wrong column count", () => {
    expect(checkCatalogCsv(`${H}\nفستان,${CAT}`).errors[0]).toMatchObject({ row: 2, code: "column_count" });
  });
  it("property: rowsOk + rowsFailed always equals rowsTotal", () => {
    fc.assert(fc.property(fc.array(fc.array(fc.string({ maxLength: 8 }), { minLength: 1, maxLength: 7 }), { maxLength: 15 }), (rows) => {
      const text = [H, ...rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(","))].join("\n");
      const r = checkCatalogCsv(text);
      if (r.errors.some((e) => e.row === 0)) return;
      expect(r.rowsOk + r.rowsFailed).toBe(r.rowsTotal);
    }));
  });
});

describe("misc", () => {
  it("error states: offline and unauthorized", () => {
    expect(stateFromError({ kind: "offline" }).kind).toBe("offline");
    expect(stateFromError({ kind: "unauthorized" })).toMatchObject({ kind: "error", signIn: true });
  });
  it("default range is 30 whole days ending at the next UTC midnight", () => {
    const r = defaultRange(Date.parse("2026-10-11T15:00:00Z"));
    expect(r).toEqual({ from: "2026-09-12T00:00:00.000Z", to: "2026-10-12T00:00:00.000Z" });
  });
});
