import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { money } from "../money";
import {
  containsArabicLetter,
  CatalogValidationError,
  CONDITIONS,
  LISTING_EVENTS,
  LISTING_STATUSES,
  InvalidListingTransitionError,
  NO_PRICE_EVIDENCE,
  allowedListingEvents,
  applyProductPatch,
  buildPublicProductView,
  createProduct,
  csvCell,
  gtinVariantKey,
  isPriceInRange,
  isTerminalListingStatus,
  isValidGtin,
  nextListingStatus,
  parseCsv,
  parseEgpDecimal,
  parseImportFile,
  publicSellerIdentity,
  publishBlockers,
  publishWarnings,
  displayName,
  referencedUploadIds,
  sanitizePriceBlock,
  validateImportRows,
  validateProductDraft,
  validateSizeChartStructure,
  type ImportContext,
  type ListingStatus,
  type Product,
  type ProductDraft,
  type SizeChartRow,
} from "./index";

const CAT = "0192f3a4-5b6c-7d8e-9f01-000000000001";
const UP1 = "0192f3a4-5b6c-7d8e-9f01-0000000000a1";
const UP2 = "0192f3a4-5b6c-7d8e-9f01-0000000000a2";

function draft(over: Partial<ProductDraft> = {}): ProductDraft {
  return {
    title: { ar: "فستان كتان أبيض" },
    categoryId: CAT,
    condition: "new_with_tags",
    imageUploadIds: [],
    defectPhotoUploadIds: [],
    skus: [{ sizeLabel: "M", price: money(129_900n) }],
    ...over,
  };
}

function counter(): () => string {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

describe("product draft validation", () => {
  it("accepts a minimal Arabic draft", () => {
    expect(validateProductDraft(draft())).toEqual([]);
  });

  it("property: a title without any Arabic letter is always rejected", () => {
    const nonArabic = fc.string({ minLength: 1, maxLength: 60 }).filter((s) => !containsArabicLetter(s));
    fc.assert(
      fc.property(nonArabic, (title) => {
        const issues = validateProductDraft(draft({ title: { ar: title, en: "English title" } }));
        expect(issues.some((i) => i.pointer === "/title/ar" && ["arabic_text_required", "text_invalid_characters"].includes(i.code))).toBe(true);
      }),
    );
  });

  it("property: adding an Arabic letter to a clean title makes it acceptable", () => {
    const clean = fc.stringMatching(/^[A-Za-z0-9 ]{0,40}$/);
    fc.assert(
      fc.property(clean, (s) => {
        expect(validateProductDraft(draft({ title: { ar: `${s} ك` } })).filter((i) => i.pointer === "/title/ar")).toEqual([]);
      }),
    );
  });

  it("rejects bidi override characters and control characters", () => {
    expect(validateProductDraft(draft({ title: { ar: "فستان‮abc" } })).map((i) => i.code)).toContain("text_invalid_characters");
    expect(validateProductDraft(draft({ title: { ar: "فستان\u0007" } })).map((i) => i.code)).toContain("text_invalid_characters");
  });

  it("requires defect photos for minor_defect and nothing else changes that", () => {
    expect(validateProductDraft(draft({ condition: "minor_defect" })).map((i) => i.code)).toContain("defect_photo_required");
    expect(validateProductDraft(draft({ condition: "minor_defect", defectPhotoUploadIds: [UP1] }))).toEqual([]);
    for (const c of CONDITIONS.filter((x) => x !== "minor_defect")) {
      expect(validateProductDraft(draft({ condition: c }))).toEqual([]);
    }
  });

  it("flags price range, duplicates, gtin and sku limits", () => {
    const issues = validateProductDraft(
      draft({
        skus: [
          { sizeLabel: "M", color: "Red", price: money(0n) },
          { sizeLabel: " m ", color: "red", price: money(100n), gtin: "123" },
        ],
      }),
    );
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("price_out_of_range");
    expect(codes).toContain("duplicate_variant");
    expect(codes).toContain("gtin_invalid");
    expect(validateProductDraft(draft({ skus: [] })).map((i) => i.code)).toContain("sku_required");
    const many = Array.from({ length: 101 }, (_, i) => ({ sizeLabel: `S${i}`, price: money(100n) }));
    expect(validateProductDraft(draft({ skus: many })).map((i) => i.code)).toContain("too_many_skus");
  });

  it("createProduct is a draft, version 1, and throws a typed error with all issues", () => {
    const p = createProduct(draft(), { storeId: "s1", nowMs: 5, newId: counter() });
    expect(p.status).toBe("draft");
    expect(p.version).toBe(1);
    expect(p.skus).toHaveLength(1);
    expect(() => createProduct(draft({ title: { ar: "" } }), { storeId: "s1", nowMs: 5, newId: counter() })).toThrow(CatalogValidationError);
  });

  it("applyProductPatch bumps the version and re-validates", () => {
    const p = createProduct(draft(), { storeId: "s1", nowMs: 5, newId: counter() });
    const q = applyProductPatch(p, { material: "كتان" }, 9);
    expect(q.version).toBe(2);
    expect(q.updatedAtMs).toBe(9);
    expect(() => applyProductPatch(p, { condition: "minor_defect" }, 9)).toThrow(CatalogValidationError);
  });
});

describe("money input and GTIN", () => {
  it("property: piastres round trip through the decimal text", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 999_999_999n }), (n) => {
        const text = `${n / 100n}.${String(n % 100n).padStart(2, "0")}`;
        const parsed = parseEgpDecimal(text);
        expect(parsed?.amount).toBe(n);
        expect(isPriceInRange(parsed ?? money(0n))).toBe(true);
      }),
    );
  });

  it("rejects floats, commas, signs, exponent and Arabic-Indic digits", () => {
    for (const bad of ["1,299.50", "-5", "1e3", "١٢٣", "12.345", "", " ", ".5", "5.", "0x10"]) {
      expect(parseEgpDecimal(bad)).toBeNull();
    }
    expect(parseEgpDecimal("0")?.amount).toBe(0n);
    expect(isPriceInRange(parseEgpDecimal("0") ?? money(1n))).toBe(false);
  });

  function withCheck(payload: string): string {
    let sum = 0;
    for (let i = payload.length - 1, w = 3; i >= 0; i -= 1, w = w === 3 ? 1 : 3) sum += Number(payload[i]) * w;
    return payload + String((10 - (sum % 10)) % 10);
  }

  it("property: valid GTINs validate and a changed check digit does not", () => {
    fc.assert(
      fc.property(fc.constantFrom(7, 11, 12, 13), fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 13, maxLength: 13 }), (len, ds) => {
        const payload = ds.slice(0, len).join("");
        const good = withCheck(payload);
        expect(isValidGtin(good)).toBe(true);
        const last = Number(good[good.length - 1]);
        const bad = good.slice(0, -1) + String((last + 1) % 10);
        expect(isValidGtin(bad)).toBe(false);
      }),
    );
    expect(isValidGtin("12345")).toBe(false);
    expect(isValidGtin("abcdefgh")).toBe(false);
  });
});

describe("listing lifecycle", () => {
  it("is deterministic and delisted is terminal", () => {
    expect(nextListingStatus("draft", "publish", "seller")).toBe("active");
    expect(isTerminalListingStatus("delisted")).toBe(true);
    for (const e of LISTING_EVENTS) {
      expect(() => nextListingStatus("delisted", e, "system")).toThrow(InvalidListingTransitionError);
    }
  });

  it("property: a seller can never enter or leave auto_paused_price_parity except to delisted", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...LISTING_EVENTS), { maxLength: 30 }), (events) => {
        let s: ListingStatus = "draft";
        for (const e of events) {
          try {
            const next = nextListingStatus(s, e, "seller");
            expect(next).not.toBe("auto_paused_price_parity");
            s = next;
          } catch (err) {
            expect(err).toBeInstanceOf(InvalidListingTransitionError);
          }
        }
        expect(LISTING_STATUSES).toContain(s);
      }),
    );
  });

  it("system is the only actor for price parity pause and resume", () => {
    expect(() => nextListingStatus("active", "auto_pause_price_parity", "seller")).toThrow(InvalidListingTransitionError);
    expect(nextListingStatus("active", "auto_pause_price_parity", "system")).toBe("auto_paused_price_parity");
    expect(() => nextListingStatus("auto_paused_price_parity", "resume", "seller")).toThrow(InvalidListingTransitionError);
    expect(allowedListingEvents("auto_paused_price_parity", "seller")).toEqual(["delist"]);
  });

  it("publish gate lists every unmet requirement", () => {
    const ok = {
      titleAr: "فستان",
      titleEn: "Dress",
      descriptionAr: "وصف",
      condition: "new_with_tags" as const,
      imageCount: 1,
      defectPhotoCount: 0,
      pricedSkuCount: 1,
      categoryRequiresSizeChart: false,
      sizeChartStatus: "none" as const,
    };
    expect(publishBlockers(ok)).toEqual([]);
    const bad = publishBlockers({
      ...ok,
      descriptionAr: undefined,
      imageCount: 0,
      condition: "minor_defect",
      categoryRequiresSizeChart: true,
      sizeChartStatus: "unvalidated",
    });
    expect(bad.map((b) => b.pointer).sort()).toEqual(
      ["/defect_photo_upload_ids", "/description/ar", "/image_upload_ids", "/size_chart_id"].sort(),
    );
  });
});

describe("bilingual names", () => {
  const base = {
    titleAr: "فستان",
    titleEn: "Dress",
    descriptionAr: "وصف",
    condition: "new_with_tags" as const,
    imageCount: 1,
    defectPhotoCount: 0,
    pricedSkuCount: 1,
    categoryRequiresSizeChart: false,
    sizeChartStatus: "none" as const,
  };
  it("publish requires both names", () => {
    expect(publishBlockers({ ...base, titleEn: undefined })).toEqual([{ pointer: "/title/en", code: "title_en_missing" }]);
    expect(publishBlockers({ ...base, titleEn: "   " }).map((i) => i.code)).toEqual(["title_en_missing"]);
    expect(publishBlockers({ ...base, titleEn: "12345" }).map((i) => i.code)).toEqual(["title_en_missing"]);
    expect(publishBlockers({ ...base, titleEn: "A" }).map((i) => i.code)).toEqual(["title_en_missing"]);
    expect(publishBlockers({ ...base, titleEn: "x".repeat(121) }).map((i) => i.code)).toEqual(["text_too_long"]);
    expect(publishBlockers({ ...base, titleAr: "1234" }).map((i) => i.code)).toEqual(["title_ar_missing"]);
    expect(publishBlockers({ ...base, titleAr: "1234", titleEn: undefined }).map((i) => i.code)).toEqual(["title_ar_missing", "title_en_missing"]);
  });
  it("warnings: names block, department and one-language description do not", () => {
    const w = publishWarnings({ department: "unisex", title: { ar: "فستان" }, description: { ar: "وصف" } });
    expect(w).toEqual([
      { pointer: "/title/en", code: "title_en_missing", blocking: true },
      { pointer: "/department", code: "department_not_chosen", blocking: false },
      { pointer: "/description/en", code: "description_en_missing", blocking: false },
    ]);
    expect(publishWarnings({ department: "women", title: { ar: "فستان", en: "Dress" } })).toEqual([]);
  });
  it("displayName falls back to the other language, never blank", () => {
    expect(displayName({ ar: "فستان" }, "en")).toBe("فستان");
    expect(displayName({ ar: "فستان", en: "Dress" }, "en")).toBe("Dress");
    expect(displayName({ ar: "  ", en: "Dress" }, "ar")).toBe("Dress");
  });
});

describe("size chart structure hook", () => {
  const rowsArb = fc
    .array(fc.tuple(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 5 })), { minLength: 1, maxLength: 12 })
    .map((steps) => {
      let chest = 80;
      let waist = 60;
      return steps.map(([dc, dw], i): SizeChartRow => {
        chest += dc;
        waist += dw;
        return { sizeLabel: `S${i}`, measurements: { chest_cm: chest, waist_cm: waist } };
      });
    });

  it("property: non-decreasing charts are valid", () => {
    fc.assert(
      fc.property(rowsArb, (rows) => {
        expect(validateSizeChartStructure(rows)).toEqual([]);
      }),
    );
  });

  it("property: reversing a strictly increasing chart is non_monotonic", () => {
    const strict = fc.integer({ min: 2, max: 8 }).map((n) =>
      Array.from({ length: n }, (_, i): SizeChartRow => ({ sizeLabel: `S${i}`, measurements: { chest_cm: 80 + i * 4 } })),
    );
    fc.assert(
      fc.property(strict, (rows) => {
        const issues = validateSizeChartStructure([...rows].reverse().map((r, i) => ({ ...r, sizeLabel: `R${i}` })));
        expect(issues.some((i) => i.code === "non_monotonic")).toBe(true);
      }),
    );
  });

  it("flags empty, duplicate labels, mismatched sets and non-positive values", () => {
    expect(validateSizeChartStructure([]).map((i) => i.code)).toEqual(["empty"]);
    expect(
      validateSizeChartStructure([
        { sizeLabel: "M", measurements: { chest_cm: 90 } },
        { sizeLabel: "m", measurements: { chest_cm: 94 } },
      ]).map((i) => i.code),
    ).toContain("duplicate_size_label");
    expect(
      validateSizeChartStructure([
        { sizeLabel: "S", measurements: { chest_cm: 90 } },
        { sizeLabel: "M", measurements: { waist_cm: 70 } },
      ]).map((i) => i.code),
    ).toContain("measurement_set_mismatch");
    expect(validateSizeChartStructure([{ sizeLabel: "S", measurements: { chest_cm: -1 } }]).map((i) => i.code)).toContain(
      "not_positive_finite",
    );
    expect(validateSizeChartStructure([{ sizeLabel: "S", measurements: { chest_cm: Number.NaN } }]).map((i) => i.code)).toContain(
      "not_positive_finite",
    );
  });
});

describe("csv parser", () => {
  it("parses quotes, escaped quotes, CRLF, BOM and embedded newlines", () => {
    const r = parseCsv('﻿a,b\r\n"x,1","he said ""hi"""\r\n"line1\nline2",z\r\n');
    expect(r).toEqual({ ok: true, header: ["a", "b"], rows: [["x,1", 'he said "hi"'], ["line1\nline2", "z"]] });
  });

  it("property: csvCell then parse round trips arbitrary safe cells", () => {
    const cell = fc.string({ maxLength: 30 }).filter((s) => !/^[=+\-@\t\r]/.test(s) && !s.includes(String.fromCharCode(0)));
    fc.assert(
      fc.property(fc.array(fc.array(cell, { minLength: 2, maxLength: 3 }), { minLength: 1, maxLength: 5 }), (rows) => {
        const width = 2;
        const norm = rows.map((r) => [r[0] ?? "", r[1] ?? ""]);
        const text = [["h1", "h2"], ...norm].map((r) => r.map(csvCell).join(",")).join("\n");
        const parsed = parseCsv(text);
        // Rows that are entirely one empty cell collapse (blank line), so compare only when none are blank.
        if (norm.some((r) => r[0] === "" && r[1] === "")) return;
        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
          expect(parsed.rows).toEqual(norm);
          expect(parsed.header).toHaveLength(width);
        }
      }),
    );
  });

  it("guards formula injection on export", () => {
    for (const s of ["=1+1", "+1", "-1", "@a", "\tx"]) expect(csvCell(s).startsWith("'") || csvCell(s).startsWith(`"'`)).toBe(true);
  });

  it("enforces caps and reports malformed input", () => {
    expect(parseCsv('a\n"unterminated')).toEqual({ ok: false, code: "csv_malformed" });
    expect(parseCsv("a\n")).toEqual({ ok: false, code: "no_rows" });
    expect(parseCsv("")).toEqual({ ok: false, code: "no_rows" });
    expect(parseCsv(Array.from({ length: 41 }, (_, i) => `c${i}`).join(",") + "\n1")).toEqual({ ok: false, code: "too_many_columns" });
    expect(parseCsv("a\n" + "x".repeat(4097))).toEqual({ ok: false, code: "cell_too_long" });
    expect(parseCsv("a\n" + "1\n".repeat(5001))).toEqual({ ok: false, code: "too_many_rows" });
    expect(parseCsv("a\n" + "x".repeat(300_000))).toEqual({ ok: false, code: "csv_too_large" });
  });
});

const HEADER =
  "product_ref,title_ar,title_en,description_ar,category_slug,brand_slug,condition,size_label,color,seller_sku,barcode_gtin,price_egp,initial_stock,image_upload_ids,defect_photo_upload_ids";

function ctx(over: Partial<ImportContext> = {}): ImportContext {
  return {
    categories: new Map([["dresses", { id: CAT, active: true }], ["old", { id: CAT, active: false }]]),
    brands: new Map([["acme", "0192f3a4-5b6c-7d8e-9f01-0000000000b1"]]),
    ownedUploadIds: new Set([UP1, UP2]),
    takenGtinVariants: new Set(),
    ...over,
  };
}

function file(lines: string[]) {
  const p = parseImportFile([HEADER, ...lines].join("\n"));
  if (!p.ok) throw new Error("fixture parse failed");
  return p;
}

describe("bulk import validation", () => {
  const good1 = `p1,فستان كتان,Linen dress,وصف,dresses,acme,new_with_tags,M,White,SKU-1,,1299.50,5,${UP1},`;
  const good2 = `p1,فستان كتان,Linen dress,وصف,dresses,acme,new_with_tags,L,White,SKU-2,,1299.50,3,${UP1},`;
  const bad = `p2,Latin only,,,dresses,,new_with_tags,M,,,,10.00,,${UP1},`;

  it("accepts valid products and reports per-row errors for invalid ones", () => {
    const r = validateImportRows(file([good1, good2, bad]), ctx());
    expect(r.rowsTotal).toBe(3);
    expect(r.rowsFailed).toBe(1);
    expect(r.rowsOk).toBe(2);
    expect(r.products).toHaveLength(1);
    expect(r.products[0]?.draft.skus.map((s) => s.price.amount)).toEqual([129_950n, 129_950n]);
    expect(r.errors).toEqual([
      { row: 4, column: "title_ar", code: "title_ar_missing" },
      { row: 4, column: "title_en", code: "title_en_missing" },
    ]);
  });

  it("fails every row of a product when one row is bad", () => {
    const badRow = `p1,فستان كتان,Linen dress,وصف,dresses,acme,new_with_tags,L,White,SKU-2,,12,3,${UP1},`;
    const r = validateImportRows(file([good1, badRow.replace(",12,", ",abc,")]), ctx());
    expect(r.products).toEqual([]);
    expect(r.rowsFailed).toBe(2);
    expect(r.errors.find((e) => e.row === 2)?.code).toBe("product_group_invalid");
    expect(r.errors.find((e) => e.row === 3)).toEqual({ row: 3, column: "price_egp", code: "invalid_value" });
  });

  it("detects product-level mismatches, unknown taxonomy, foreign uploads and gtin conflicts", () => {
    const mism = good2.replace("فستان كتان", "فستان آخر");
    expect(validateImportRows(file([good1, mism]), ctx()).errors.map((e) => e.code)).toContain("product_columns_mismatch");
    const unknownCat = good1.replace("dresses", "nope");
    expect(validateImportRows(file([unknownCat]), ctx()).errors[0]?.code).toBe("category_not_found");
    expect(validateImportRows(file([good1.replace("dresses", "old")]), ctx()).errors[0]?.code).toBe("category_inactive");
    const foreign = good1.replace(UP1, "0192f3a4-5b6c-7d8e-9f01-0000000000ff");
    expect(validateImportRows(file([foreign]), ctx()).errors[0]).toEqual({ row: 2, column: "image_upload_ids", code: "upload_not_found" });
    const withGtin = good1.replace("SKU-1,,", "SKU-1,4006381333931,");
    expect(validateImportRows(file([withGtin]), ctx()).products).toHaveLength(1);
    const taken = new Set([gtinVariantKey("4006381333931", "White", "M")]);
    expect(validateImportRows(file([withGtin]), ctx({ takenGtinVariants: taken })).errors[0]).toEqual({
      row: 2,
      column: "barcode_gtin",
      code: "invalid_value",
    });
  });

  it("requires defect photos on minor_defect rows", () => {
    const r = validateImportRows(file([good1.replace("new_with_tags", "minor_defect")]), ctx());
    expect(r.errors[0]).toEqual({ row: 2, column: "defect_photo_upload_ids", code: "defect_photo_required" });
    const ok = good1.replace("new_with_tags", "minor_defect").replace(/,$/, `,${UP2}`);
    expect(validateImportRows(file([ok]), ctx()).products).toHaveLength(1);
  });

  it("reads the optional department column: valid, blank (default) and invalid values", () => {
    const withDept = (cell: string) => {
      const parsed = parseImportFile([`${HEADER},department`, `${good1},${cell}`].join("\n"));
      if (!parsed.ok) throw new Error("fixture parse failed");
      return validateImportRows(parsed, ctx());
    };
    const ok = withDept("women");
    expect(ok.products[0]?.draft.department).toBe("women");
    expect(withDept("").products[0]?.draft.department).toBeUndefined();
    expect(withDept(" Kids ").products[0]?.draft.department).toBe("kids");
    const bad = withDept("accessories");
    expect(bad.products).toEqual([]);
    expect(bad.errors[0]).toEqual({ row: 2, column: "department", code: "invalid_value" });
  });

  it("fails the whole file for unknown or missing columns", () => {
    expect(parseImportFile("product_ref,title_ar,hacker\n1,2,3")).toMatchObject({ ok: false, error: { code: "unknown_column" } });
    expect(parseImportFile("product_ref,title_ar\n1,2")).toMatchObject({ ok: false, error: { code: "missing_column" } });
    expect(parseImportFile("product_ref,product_ref\n1,2")).toMatchObject({ ok: false, error: { code: "csv_malformed" } });
  });

  it("is pure: identical bytes give identical reports and inputs are not mutated", () => {
    const f = file([good1, good2, bad]);
    const frozenCtx = ctx();
    const before = JSON.stringify(f, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    const a = validateImportRows(f, frozenCtx);
    const b = validateImportRows(f, frozenCtx);
    expect(JSON.stringify(a, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).toBe(
      JSON.stringify(b, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
    );
    expect(JSON.stringify(f, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).toBe(before);
    expect([...referencedUploadIds(f)].sort()).toEqual([UP1]);
  });

  it("property: rows_ok + rows_failed equals rows_total and error rows are within the file", () => {
    const line = fc.record({
      ref: fc.constantFrom("a", "b", "c"),
      title: fc.constantFrom("فستان", "dress", ""),
      price: fc.constantFrom("10", "12.5", "x", "0", "-1"),
      size: fc.constantFrom("S", "M", " ", "L"),
    });
    fc.assert(
      fc.property(fc.array(line, { minLength: 1, maxLength: 15 }), (ls) => {
        const f = file(ls.map((l) => `${l.ref},${l.title},,,dresses,,new_with_tags,${l.size},,,,${l.price},,,`));
        const r = validateImportRows(f, ctx());
        expect(r.rowsOk + r.rowsFailed).toBe(r.rowsTotal);
        for (const e of r.errors) expect(e.row >= 2 && e.row <= ls.length + 1).toBe(true);
        const okRows = new Set(r.products.flatMap((p) => p.rows));
        for (const e of r.errors) expect(okRows.has(e.row)).toBe(false);
      }),
    );
  });
});

describe("public read model", () => {
  const base: Product = createProduct(draft({ skus: [{ sizeLabel: "M", price: money(100_00n) }] }), {
    storeId: "s1",
    nowMs: 1,
    newId: counter(),
  });
  const active: Product = { ...base, status: "active" };
  const sku = active.skus[0];
  if (sku === undefined) throw new Error("fixture");

  it("hides non-active products", () => {
    for (const s of LISTING_STATUSES.filter((x) => x !== "active")) {
      expect(
        buildPublicProductView({
          product: { ...base, status: s },
          returnClass: "standard",
          seller: null,
          stock: new Map(),
          priceBlocks: new Map(),
          sizeChartValidated: false,
        }),
      ).toBeNull();
    }
  });

  it("property: units_left only for stock 1..5, never from missing stock", () => {
    fc.assert(
      fc.property(fc.integer({ min: -3, max: 200 }), (n) => {
        const v = buildPublicProductView({
          product: active,
          returnClass: "standard",
          seller: null,
          stock: new Map([[sku.id, n]]),
          priceBlocks: new Map(),
          sizeChartValidated: false,
        });
        const s = v?.skus[0];
        expect(s?.available).toBe(n >= 1);
        expect(s?.unitsLeft).toBe(n >= 1 && n <= 5 ? n : null);
      }),
    );
    const unknown = buildPublicProductView({
      product: active,
      returnClass: "standard",
      seller: null,
      stock: new Map(),
      priceBlocks: new Map(),
      sizeChartValidated: false,
    });
    expect(unknown?.skus[0]).toMatchObject({ available: false, unitsLeft: null });
  });

  it("never shows a reference price or discount without a complete verified claim", () => {
    const ref = money(200_00n);
    expect(sanitizePriceBlock(null)).toEqual(NO_PRICE_EVIDENCE);
    expect(sanitizePriceBlock({ badge: "verified_discount", referencePrice: null, discountPct: 20, claimId: "c" })).toEqual(NO_PRICE_EVIDENCE);
    expect(sanitizePriceBlock({ badge: "verified_discount", referencePrice: ref, discountPct: 4, claimId: "c" })).toEqual(NO_PRICE_EVIDENCE);
    expect(sanitizePriceBlock({ badge: "verified_discount", referencePrice: ref, discountPct: 20, claimId: null })).toEqual(NO_PRICE_EVIDENCE);
    expect(sanitizePriceBlock({ badge: "lowest_30d", referencePrice: ref, discountPct: 20, claimId: "c" })).toEqual({
      badge: "lowest_30d",
      referencePrice: null,
      discountPct: null,
      claimId: "c",
    });
    const ok = { badge: "verified_discount", referencePrice: ref, discountPct: 50, claimId: "c" } as const;
    expect(sanitizePriceBlock(ok)).toEqual(ok);
  });

  it("projects exactly four identity fields and only for approved complete stores", () => {
    const full = {
      legalName: "Acme LLC",
      commercialRegisterNo: "123",
      taxCardNo: "456",
      governorate: "Cairo",
      approved: true,
      signatoryNationalId: "29001010101010",
      iban: "EG000",
    };
    const id = publicSellerIdentity(full);
    expect(Object.keys(id ?? {}).sort()).toEqual(["commercialRegisterNo", "governorate", "legalName", "taxCardNo"]);
    expect(publicSellerIdentity({ ...full, approved: false })).toBeNull();
    expect(publicSellerIdentity({ ...full, taxCardNo: " " })).toBeNull();
    expect(publicSellerIdentity(null)).toBeNull();
  });

  it("derives return eligibility from the category class", () => {
    const mk = (c: "standard" | "hygiene" | "personalized" | "non_returnable") =>
      buildPublicProductView({ product: active, returnClass: c, seller: null, stock: new Map(), priceBlocks: new Map(), sizeChartValidated: true })
        ?.returnEligibility;
    expect(mk("standard")).toEqual({ returnable: true, windowDays: 14 });
    expect(mk("hygiene")).toEqual({ returnable: false, reasonCode: "hygiene_non_returnable" });
  });
});
