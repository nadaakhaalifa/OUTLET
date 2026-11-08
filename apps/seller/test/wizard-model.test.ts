import { describe, expect, it } from "vitest";
import { stateFromProduct } from "../src/lib/product-state";
import {
  EMPTY_STATE,
  checklistFrom,
  conditionSection,
  defectCardBody,
  detailsSection,
  needsDefectCard,
  parsePriceMinor,
  priceSection,
  reasonKey,
  stepForReason,
  stepProblems,
  validPhotoFile,
  type RequiredAttribute,
  type WizardState,
} from "../src/lib/wizard-model";

const photo = (id: string) => ({ mediaId: id, name: `${id}.png` });
const base: WizardState = { ...EMPTY_STATE, categoryId: "c1", photos: { main: photo("m1") }, name: "فستان صيفي", description: "فستان قطن", price: "1299.50" };
const defs: RequiredAttribute[] = [
  { code: "colour", dataType: "enum", required: true },
  { code: "size_run", dataType: "size_run", required: true },
];

describe("parsePriceMinor", () => {
  it.each([
    ["1299", 129900n],
    ["1299.5", 129950n],
    ["1299,05", 129905n],
    ["١٢٩٩٫٥٠", 129950n],
    ["0.01", 1n],
  ])("%s -> %s piastres", (input, minor) => {
    expect(parsePriceMinor(input)).toBe(minor);
  });
  it.each(["", "0", "0.00", "-5", "12.345", "abc", "1e3", "1 000", "9999999999"])("rejects %j", (input) => {
    expect(parsePriceMinor(input)).toBeNull();
  });
});

describe("grade rules mirror ADR-0009", () => {
  it("defect grades need a card; new-with-tags and sample do not", () => {
    for (const g of ["new_with_imperfections", "open_box", "refurbished", "pre_owned"]) expect(needsDefectCard(g)).toBe(true);
    for (const g of ["new_with_tags", "sample"]) expect(needsDefectCard(g)).toBe(false);
  });

  it("step 1 blocks a defect grade until a close-up, defect type, location and notes exist", () => {
    const open: WizardState = { ...base, condition: "openBox" };
    expect(stepProblems(1, open, [])).toEqual(["defectPhoto", "defectType", "defectLocation", "notes"]);
    const filled: WizardState = {
      ...open,
      photos: { main: photo("m1"), defect: photo("d1") },
      defect: { ...open.defect, typeCode: "stain", location: "الكم" },
      notes: "بقعة صغيرة",
    };
    expect(stepProblems(1, filled, [])).toEqual([]);
  });

  it("a new-clearance item needs only the category and the main photo", () => {
    expect(stepProblems(1, { ...EMPTY_STATE }, [])).toEqual(["category", "mainPhoto"]);
    expect(stepProblems(1, base, [])).toEqual([]);
  });

  it("step 2 needs an Arabic name, a description and the required attributes; step 3 a valid price", () => {
    expect(stepProblems(2, { ...base, name: "Dress", description: "" }, defs)).toEqual(["name", "description", "attributes"]);
    const ok: WizardState = { ...base, attributes: { colour: "black" }, sizes: [{ label: "M", cm: "94" }] };
    expect(stepProblems(2, ok, defs)).toEqual([]);
    expect(stepProblems(3, { ...base, price: "0" }, defs)).toEqual(["price"]);
    expect(stepProblems(3, base, defs)).toEqual([]);
  });
});

describe("wire sections are null until complete", () => {
  it("condition needs the main photo and maps slots to roles (defect close-up = condition)", () => {
    expect(conditionSection(EMPTY_STATE)).toBeNull();
    const s: WizardState = { ...base, condition: "cosmeticDefect", photos: { main: photo("m1"), defect: photo("d1"), packaging: photo("p1") } };
    expect(conditionSection(s)).toEqual({
      condition_grade_code: "new_with_imperfections",
      media: [
        { media_id: "m1", role: "main", position: 0 },
        { media_id: "d1", role: "condition", position: 1 },
        { media_id: "p1", role: "packaging", position: 2 },
      ],
    });
  });

  it("near expiry is new-with-tags plus the near_expiry stock reason", () => {
    expect(conditionSection({ ...base, condition: "nearExpiry" })).toMatchObject({ condition_grade_code: "new_with_tags", stock_reason: "near_expiry" });
  });

  it("details need category, an Arabic name and a description; attributes follow the category set", () => {
    expect(detailsSection({ ...base, name: "Dress" }, defs)).toBeNull();
    const d = detailsSection({ ...base, attributes: { colour: "black" }, sizes: [{ label: "M", cm: "94" }], warrantyMonths: "٦", accessories: "كيس" }, defs);
    expect(d).toMatchObject({ title_ar: "فستان صيفي", attributes: { colour: "black", size_run: [{ label: "M", cm: 94 }] }, warranty_months: 6, warranty_kind: "seller", included_accessories_ar: "كيس" });
  });

  it("price is integer piastres in EGP", () => {
    expect(priceSection(base)).toEqual({ price: { amount_minor: "129950", currency: "EGP" } });
    expect(priceSection({ ...base, price: "" })).toBeNull();
  });

  it("the defect card stores the hotspot as basis points of the photo (percent x 100)", () => {
    const s: WizardState = {
      ...base,
      condition: "openBox",
      photos: { main: photo("m1"), defect: photo("d1") },
      defect: { typeCode: "stain", location: "الكم الأيسر", severity: "minor", affectsFunction: false, xPct: 25, yPct: 60.5 },
      notes: "بقعة",
    };
    expect(defectCardBody(s)).toEqual({
      summary_ar: "بقعة",
      affects_function: false,
      items: [{ defect_type_code: "stain", location_ar: "الكم الأيسر", severity: "minor", affects_function: false, photo_media_id: "d1", hotspot_x_bp: 2500, hotspot_y_bp: 6050 }],
    });
    expect(defectCardBody({ ...s, condition: "newClearance" })).toBeNull();
    expect(defectCardBody({ ...s, notes: "" })).toBeNull();
  });
});

describe("checklist and reasons come from the server", () => {
  it("is all pending before a draft exists", () => {
    expect(checklistFrom(null).every((r) => !r.done)).toBe(true);
  });
  it("maps activation reasons to rows", () => {
    const rows = Object.fromEntries(checklistFrom(["CONDITION_PHOTO_REQUIRED", "NO_ACTIVE_VARIANT"]).map((r) => [r.id, r.done]));
    expect(rows).toEqual({ photos: true, defect: false, condition: true, price: false });
  });
  it("every server reason has a message key and a step to fix it", () => {
    expect(reasonKey("DEFECT_CARD_REQUIRED")).toBe("seller.reason.DEFECT_CARD_REQUIRED");
    expect(reasonKey("SOMETHING_NEW")).toBe("seller.reason.unknown");
    expect(stepForReason("MAIN_PHOTO_REQUIRED")).toBe(1);
    expect(stepForReason("TITLE_AR_REQUIRED")).toBe(2);
    expect(stepForReason("NO_ACTIVE_VARIANT")).toBe(3);
  });
});

describe("photo files", () => {
  it("accepts JPG/PNG/WebP/HEIC up to 10 MB", () => {
    expect(validPhotoFile({ type: "image/heic", size: 10 * 1024 * 1024 })).toBeNull();
    expect(validPhotoFile({ type: "application/pdf", size: 10 })).toBe("type");
    expect(validPhotoFile({ type: "image/png", size: 10 * 1024 * 1024 + 1 })).toBe("size");
  });
});

describe("stateFromProduct", () => {
  it("restores condition, photos, defect hotspot, details and price", () => {
    const s = stateFromProduct({
      id: "p1",
      version: 4,
      status: "DRAFT",
      title_ar: "حذاء",
      description_ar: "وصف",
      primary_category_id: "c1",
      condition_grade_code: "open_box",
      attributes: { colour: "black", size_run: [{ label: "M", cm: 94 }] },
      media: [
        { role: "main", media: { media_id: "m1" } },
        { role: "condition", media: { media_id: "d1" } },
      ],
      skus: [{ id: "s1", price: { amount_minor: "129905", currency: "EGP" } }],
      defect_card: { summary_ar: "بقعة", items: [{ defect_type_code: "stain", location_ar: "الكم", severity: "minor", affects_function: false, hotspot_x_bp: 2500, hotspot_y_bp: 6000 }] },
    });
    expect(s).toMatchObject({ condition: "openBox", categoryId: "c1", name: "حذاء", price: "1299.05", notes: "بقعة", attributes: { colour: "black" }, sizes: [{ label: "M", cm: "94" }] });
    expect(s.photos.main?.mediaId).toBe("m1");
    expect(s.photos.defect?.mediaId).toBe("d1");
    expect(s.defect).toMatchObject({ typeCode: "stain", xPct: 25, yPct: 60 });
  });
});
