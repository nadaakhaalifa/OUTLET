import { describe, expect, it } from "vitest";
import { money } from "../money";
import {
  applyProductPatch,
  bilingualNameIssues,
  createProduct,
  isEnglishNameMissing,
  parseImportFile,
  returnEligibility,
  validateImportRows,
  validateImportText,
  validateProductDraft,
  type ImportContext,
  type ProductDraft,
} from "./index";

const CAT = "0192f3a4-5b6c-7d8e-9f01-000000000001";
const UP1 = "0192f3a4-5b6c-7d8e-9f01-0000000000a1";

const draft = (over: Partial<ProductDraft> = {}): ProductDraft => ({
  title: { ar: "فستان كتان أبيض" },
  categoryId: CAT,
  condition: "new_with_tags",
  imageUploadIds: [],
  defectPhotoUploadIds: [],
  skus: [{ sizeLabel: "M", price: money(129_900n) }],
  ...over,
});

const ids = (): (() => string) => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
};

describe("names", () => {
  it("reports a missing English name", () => {
    expect(isEnglishNameMissing({ ar: "فستان", en: "  " })).toBe(true);
    expect(isEnglishNameMissing({ ar: "فستان", en: "Dress" })).toBe(false);
  });
  it("flags names over the limit in each language", () => {
    const issues = bilingualNameIssues({ ar: "ف".repeat(121), en: "a".repeat(121) }, "/title");
    expect(issues.map((i) => i.code)).toEqual(["text_too_long", "text_too_long"]);
  });
});

describe("product draft edges", () => {
  it("validates the optional English description, department, photo caps and stock", () => {
    const issues = validateProductDraft(
      draft({
        description: { ar: "وصف", en: "x".repeat(2001) },
        department: "robots" as never,
        defectPhotoUploadIds: Array.from({ length: 13 }, () => UP1),
        skus: [{ sizeLabel: "M", price: money(100n), initialStock: 100_001 }],
      }),
    );
    const codes = issues.map((i) => `${i.pointer}:${i.code}`);
    expect(codes).toContain("/department:invalid_value");
    expect(codes).toContain("/defect_photo_upload_ids:image_limit_exceeded");
    expect(codes).toContain("/skus/0/initial_stock:stock_out_of_range");
    expect(issues.some((i) => i.pointer === "/description/en")).toBe(true);
  });

  it("keeps trimmed bilingual descriptions on create and patch, and drops blank English", () => {
    const p = createProduct(draft({ description: { ar: " وصف ", en: " Desc " } }), { storeId: "s1", nowMs: 1, newId: ids() });
    expect(p.description).toEqual({ ar: "وصف", en: "Desc" });
    const q = applyProductPatch(p, { description: { ar: "وصف جديد", en: "New" }, title: { ar: "عنوان جديد", en: "New title" } }, 2);
    expect(q.description).toEqual({ ar: "وصف جديد", en: "New" });
    expect(q.title).toEqual({ ar: "عنوان جديد", en: "New title" });
    const r = applyProductPatch(q, { description: { ar: "وصف", en: " " }, title: { ar: "عنوان", en: "" } }, 3);
    expect(r.description).toEqual({ ar: "وصف" });
    expect(r.title).toEqual({ ar: "عنوان" });
    const noDesc = createProduct(draft({ description: { ar: "وصف", en: " " } }), { storeId: "s1", nowMs: 1, newId: ids() });
    expect(noDesc.description).toEqual({ ar: "وصف" });
  });
});

describe("return eligibility", () => {
  it("maps every non-standard class to its reason code", () => {
    expect(returnEligibility("standard")).toEqual({ returnable: true, windowDays: 14 });
    expect(returnEligibility("hygiene")).toEqual({ returnable: false, reasonCode: "hygiene_non_returnable" });
    expect(returnEligibility("personalized")).toEqual({ returnable: false, reasonCode: "personalized_non_returnable" });
    expect(returnEligibility("non_returnable")).toEqual({ returnable: false, reasonCode: "non_returnable" });
  });
});

describe("bulk import edges", () => {
  const HEADER =
    "product_ref,title_ar,title_en,description_ar,category_slug,brand_slug,condition,size_label,color,seller_sku,barcode_gtin,price_egp,initial_stock,image_upload_ids,defect_photo_upload_ids";
  const ctx: ImportContext = {
    categories: new Map([["dresses", { id: CAT, active: true }]]),
    brands: new Map(),
    ownedUploadIds: new Set([UP1]),
    takenGtinVariants: new Set(),
  };
  const row = `p1,فستان كتان,Linen dress,وصف,dresses,,new_with_tags,M,White,SKU-1,,1299.50,5,${UP1},`;
  const parse = (header: string, lines: string[]) => {
    const p = parseImportFile([header, ...lines].join("\n"));
    if (!p.ok) throw new Error("fixture parse failed");
    return p;
  };

  it("rejects an invalid product_ref and a non-numeric stock", () => {
    const r = validateImportRows(parse(HEADER, [row.replace("p1,", "bad ref!,"), row.replace(",5,", ",many,")]), ctx);
    expect(r.errors).toContainEqual({ row: 2, column: "product_ref", code: "product_ref_invalid" });
    expect(r.errors).toContainEqual({ row: 3, column: "initial_stock", code: "stock_out_of_range" });
    expect(r.products).toEqual([]);
  });

  it("requires Arabic description when only English is given", () => {
    const r = validateImportRows(parse(`${HEADER},description_en`, [`${row.replace("وصف", "")},English text`]), ctx);
    expect(r.errors).toContainEqual({ row: 2, column: "description_ar", code: "arabic_text_required" });
  });

  it("validateImportText reports file errors and full reports in one call", () => {
    expect(validateImportText("nope", () => ctx).kind).toBe("file_error");
    const ok = validateImportText([HEADER, row].join("\n"), () => ctx);
    expect(ok.kind === "report" && ok.report.products).toHaveLength(1);
  });
});
