import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_TYPES, CatalogError, DEFECT_GRADES, DefectCardInput, DefectItemInput, InvalidTransitionError, LISTING_STATUSES, MoneyDto, PriceDisplay, PhotosConditionInput, ProductDraftInput,
  StoreCreateInput, StorePatch, activationReasons, allowedTransitions, assertAttributes, attributeIssues, canTransition, decodeCursor, encodeCursor, encodeToken, hasArabicLetters,
  isListingStatus, normalizeBrandName, normalizeToken, optionValueIssues, sizeRunSchema, transition, transitionPath,
} from "../src/index.js";
import type { ActivationInput, AttributeDef } from "../src/index.js";

describe("listing state machine", () => {
  it("allows exactly the documented edges", () => {
    expect(allowedTransitions("DRAFT")).toEqual(["IN_REVIEW", "ARCHIVED", "BLOCKED"]);
    expect(canTransition("PUBLISHED", "PAUSED")).toBe(true);
    expect(canTransition("PAUSED", "PUBLISHED")).toBe(true);
    expect(canTransition("PUBLISHED", "SOLD_OUT")).toBe(true);
    expect(canTransition("SOLD_OUT", "PUBLISHED")).toBe(true);
    expect(canTransition("DRAFT", "PUBLISHED")).toBe(false);
    expect(transitionPath("DRAFT", "IN_REVIEW", "PUBLISHED")).toBe("PUBLISHED");
  });

  it("ARCHIVED is terminal and every invalid pair throws a typed InvalidTransitionError", () => {
    for (const from of LISTING_STATUSES) {
      for (const to of LISTING_STATUSES) {
        if (canTransition(from, to)) expect(transition(from, to)).toBe(to);
        else {
          const e = (() => {
            try {
              transition(from, to);
            } catch (x) {
              return x;
            }
            return undefined;
          })();
          expect(e).toBeInstanceOf(InvalidTransitionError);
          expect(e).toBeInstanceOf(CatalogError);
          expect(e).toMatchObject({ code: "invalid_transition", from, to });
        }
      }
    }
    expect(allowedTransitions("ARCHIVED")).toEqual([]);
  });

  it("property: every status except ARCHIVED can reach ARCHIVED, and nothing leaves it", () => {
    fc.assert(
      fc.property(fc.constantFrom(...LISTING_STATUSES), (s) => s === "ARCHIVED" || canTransition(s, "ARCHIVED")),
    );
    fc.assert(fc.property(fc.constantFrom(...LISTING_STATUSES), (to) => !canTransition("ARCHIVED", to)));
  });

  it("property: a random walk over allowed edges never leaves the status set", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(10), { maxLength: 30 }), (picks) => {
        let cur = "DRAFT" as (typeof LISTING_STATUSES)[number];
        for (const k of picks) {
          const next = allowedTransitions(cur);
          const to = next[k % Math.max(next.length, 1)];
          if (to === undefined) break;
          cur = transition(cur, to);
          if (!isListingStatus(cur)) return false;
        }
        return true;
      }),
    );
    expect(isListingStatus("nope")).toBe(false);
  });
});

const set: AttributeDef[] = [
  { code: "colour", dataType: "enum", enumCodes: ["black", "white"], required: true },
  { code: "material", dataType: "text", enumCodes: [], required: true },
  { code: "size_run", dataType: "size_run", enumCodes: [], required: true },
  { code: "pieces", dataType: "number", enumCodes: [], required: false },
  { code: "drawstring_free", dataType: "boolean", enumCodes: [], required: false },
];
const run = [{ label: "S", cm: 88 }, { label: "M", cm: 94 }];

describe("attributes", () => {
  it("accepts a complete valid set", () => {
    expect(attributeIssues(set, { colour: "black", material: "cotton", size_run: run, pieces: 2, drawstring_free: true }, true)).toEqual([]);
    expect(ATTRIBUTE_TYPES).toContain("size_run");
  });

  it.each([
    [{ colour: "pink", material: "x", size_run: run }, "colour: must be one of"],
    [{ colour: "black", material: "  ", size_run: run }, "material: must be non-empty"],
    [{ colour: "black", material: "x", size_run: run, pieces: Number.NaN }, "pieces: must be a finite number"],
    [{ colour: "black", material: "x", size_run: run, drawstring_free: "yes" }, "drawstring_free: must be true or false"],
    [{ colour: "black", material: "x", size_run: run, sparkle: 1 }, "sparkle: not an attribute"],
    [{ colour: "black", material: "x", size_run: [{ label: "S", cm: 94 }, { label: "M", cm: 88 }] }, "strictly increasing"],
    [{ colour: "black", material: "x", size_run: [{ label: "S", cm: 88 }, { label: "S", cm: 94 }] }, "unique"],
    [{ colour: "black", material: "x", size_run: [] }, "size_run:"],
  ])("rejects %j", (attrs, fragment) => {
    expect(attributeIssues(set, attrs, false).join("|")).toContain(fragment);
  });

  it("complete mode demands required attributes, partial mode does not", () => {
    expect(attributeIssues(set, {}, true)).toEqual(["colour: required", "material: required", "size_run: required"]);
    expect(attributeIssues(set, {}, false)).toEqual([]);
    expect(() => { assertAttributes(set, { colour: "x" }, false); }).toThrow(CatalogError);
    expect(() => { assertAttributes(set, { colour: "black" }, false); }).not.toThrow();
  });

  it("property: a size run is valid iff labels are unique and cm strictly increases", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.string({ minLength: 1, maxLength: 3 }), fc.integer({ min: 1, max: 200 })), { minLength: 1, maxLength: 8 }), (pairs) => {
        const value = pairs.map(([label, cm]) => ({ label: label.trim() === "" ? "x" : label.trim(), cm }));
        const increasing = value.every((s, i) => i === 0 || s.cm > (value[i - 1]?.cm ?? 0));
        const unique = new Set(value.map((s) => s.label)).size === value.length;
        expect(sizeRunSchema.safeParse(value).success).toBe(increasing && unique);
      }),
    );
  });

  it("variant options must be size/colour, size must be in the run, colour valid", () => {
    const attrs = { size_run: run };
    expect(optionValueIssues(set, attrs, { size: "M", colour: "black" })).toEqual([]);
    expect(optionValueIssues(set, attrs, { size: "XL" })[0]).toContain("not in the product size run");
    expect(optionValueIssues(set, attrs, { size: 3 })[0]).toContain("must be text");
    expect(optionValueIssues(set, {}, { size: "M" })[0]).toContain("no valid size_run");
    expect(optionValueIssues(set, attrs, { weight: 1 })[0]).toContain("not a variant axis");
    expect(optionValueIssues(set, attrs, { colour: "pink" })[0]).toContain("must be one of");
    expect(optionValueIssues([], attrs, { colour: "black" })[0]).toContain("not an attribute");
  });
});

describe("conditions and Arabic", () => {
  it("detects Arabic letters", () => {
    expect(hasArabicLetters("فستان")).toBe(true);
    expect(hasArabicLetters("Dress 123")).toBe(false);
    expect(hasArabicLetters("فستان dress")).toBe(true);
    expect(DEFECT_GRADES).toContain("new_with_imperfections");
    expect(DEFECT_GRADES).not.toContain("new_with_tags");
  });

  it("folds brand name variants", () => {
    expect(normalizeBrandName("  ZARA  ")).toBe("zara");
    expect(normalizeBrandName("أديداس")).toBe(normalizeBrandName("اديداس"));
    expect(normalizeBrandName("مَدرسة")).toBe(normalizeBrandName("مدرسه"));
  });
});

const ready: ActivationInput = {
  titleAr: "فستان",
  descriptionAr: "وصف",
  hasCategory: true,
  attributeIssues: [],
  grade: { code: "new_with_tags", active: true, requiresDefectCard: false, requiresConditionPhoto: false },
  defectCard: null,
  mediaRoles: ["main"],
  activeVariantPrices: [100n],
  seller: { status: "active", legalNameAr: "شركة", commercialRegisterNo: "1", taxCardNo: "2", governorateNameAr: "القاهرة" },
  storeStatus: "ACTIVE",
};

describe("activation rules", () => {
  it("passes a complete listing", () => {
    expect(activationReasons(ready)).toEqual([]);
  });

  it.each<[string, Partial<ActivationInput>, string]>([
    ["blank Arabic title", { titleAr: " " }, "TITLE_AR_REQUIRED"],
    ["Latin-only title", { titleAr: "Dress" }, "TITLE_NOT_ARABIC"],
    ["blank description", { descriptionAr: "" }, "DESCRIPTION_AR_REQUIRED"],
    ["no category set", { hasCategory: false }, "CATEGORY_REQUIRED"],
    ["attribute problems", { attributeIssues: ["colour: required"] }, "ATTRIBUTES_INCOMPLETE"],
    ["no active variant", { activeVariantPrices: [] }, "NO_ACTIVE_VARIANT"],
    ["zero price variant", { activeVariantPrices: [0n] }, "VARIANT_PRICE_INVALID"],
    ["disabled grade", { grade: { ...ready.grade, active: false } }, "GRADE_DISABLED"],
    ["defect grade without card", { grade: { ...ready.grade, requiresDefectCard: true } }, "DEFECT_CARD_REQUIRED"],
    ["empty card", { grade: { ...ready.grade, requiresDefectCard: true }, defectCard: { gradeCode: "new_with_tags", itemCount: 0 } }, "DEFECT_CARD_EMPTY"],
    ["card for another grade", { grade: { ...ready.grade, requiresDefectCard: true }, defectCard: { gradeCode: "open_box", itemCount: 1 } }, "DEFECT_CARD_GRADE_MISMATCH"],
    ["no main photo", { mediaRoles: ["gallery"] }, "MAIN_PHOTO_REQUIRED"],
    ["no condition photo", { grade: { ...ready.grade, requiresConditionPhoto: true } }, "CONDITION_PHOTO_REQUIRED"],
    ["seller not active", { seller: { ...ready.seller, status: "draft" } }, "SELLER_NOT_ACTIVE"],
    ["seller tax card missing", { seller: { ...ready.seller, taxCardNo: null } }, "SELLER_LEGAL_IDENTITY_INCOMPLETE"],
    ["seller governorate blank", { seller: { ...ready.seller, governorateNameAr: " " } }, "SELLER_LEGAL_IDENTITY_INCOMPLETE"],
    ["store on vacation", { storeStatus: "VACATION" }, "STORE_NOT_ACTIVE"],
  ])("blocks: %s", (_n, patch, reason) => {
    expect(activationReasons({ ...ready, ...patch })).toContain(reason);
  });

  it("a valid defect listing passes", () => {
    const g = { ...ready.grade, code: "new_with_imperfections", requiresDefectCard: true, requiresConditionPhoto: true };
    expect(activationReasons({ ...ready, grade: g, defectCard: { gradeCode: g.code, itemCount: 2 }, mediaRoles: ["main", "condition"] })).toEqual([]);
  });
});

describe("DTO schemas", () => {
  const uuid = "0193c8a0-0000-7000-8000-000000000001";
  const item = { defect_type_code: "stain", location_ar: "الكم", severity: "minor", affects_function: false, photo_media_id: uuid };

  it("defect item needs a photo and a full hotspot", () => {
    expect(DefectItemInput.safeParse(item).success).toBe(true);
    expect(DefectItemInput.safeParse({ ...item, photo_media_id: undefined }).success).toBe(false);
    expect(DefectItemInput.safeParse({ ...item, hotspot_x_bp: 5 }).success).toBe(false);
    expect(DefectItemInput.safeParse({ ...item, hotspot_x_bp: 5, hotspot_y_bp: 20000 }).success).toBe(false);
    expect(DefectItemInput.safeParse({ ...item, hotspot_x_bp: 5, hotspot_y_bp: 10 }).success).toBe(true);
    expect(DefectItemInput.safeParse({ ...item, severity: "critical" }).success).toBe(false);
    expect(DefectItemInput.safeParse({ ...item, extra: 1 }).success).toBe(false);
  });

  it("defect card caps at 30 items", () => {
    expect(DefectCardInput.safeParse({ affects_function: false, items: Array.from({ length: 31 }, () => item) }).success).toBe(false);
    expect(DefectCardInput.safeParse({ affects_function: false, items: [item] }).success).toBe(true);
  });

  it("money is a decimal string, never a float", () => {
    expect(MoneyDto.safeParse({ amount_minor: "1299", currency: "EGP" }).success).toBe(true);
    expect(MoneyDto.safeParse({ amount_minor: 12.99, currency: "EGP" }).success).toBe(false);
    expect(MoneyDto.safeParse({ amount_minor: "12.99", currency: "EGP" }).success).toBe(false);
  });

  it("price display: a plain price carries no reference or discount", () => {
    const base = { current_price: { amount_minor: "100", currency: "EGP" }, claim_type: "plain", price_proof_path: "/eg/x" };
    expect(PriceDisplay.safeParse(base).success).toBe(true);
    expect(Object.keys(PriceDisplay.shape)).toContain("reference_price"); // optional: only Price Watch fills it
  });

  it("input schemas are strict", () => {
    expect(ProductDraftInput.safeParse({ condition_grade_code: "new_with_tags", primary_category_id: uuid }).success).toBe(true);
    expect(ProductDraftInput.safeParse({ condition_grade_code: "new_with_tags", primary_category_id: "x" }).success).toBe(false);
    expect(StorePatch.safeParse({ display_name_ar: "" }).success).toBe(false);
    expect(StorePatch.safeParse({ slug: "x" }).success).toBe(false);
    expect(StoreCreateInput.safeParse({ seller_id: uuid, slug: "Bad Slug", display_name_ar: "م", kind: "local", ships_from_country: "EG" }).success).toBe(false);
    expect(PhotosConditionInput.safeParse({ media: [], condition_grade_code: "new_with_tags" }).success).toBe(false);
  });
});

describe("cursor and token helpers", () => {
  const c = { t: "2030-01-01T00:00:01.123456Z", id: "0193c8a0-0000-7000-8000-000000000001" };
  it("round-trips and rejects garbage", () => {
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(() => decodeCursor("not-a-cursor")).toThrow(CatalogError);
    expect(() => decodeCursor(Buffer.from(JSON.stringify({ t: "x", id: "y" })).toString("base64url"))).toThrow(/invalid cursor/);
  });

  it("128-bit token is 26 Crockford chars and normalisation is forgiving", () => {
    const t = encodeToken(new Uint8Array(16).fill(255));
    expect(t).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(normalizeToken(t.toLowerCase())).toBe(t);
    expect(normalizeToken(`${t.slice(0, 13)}-${t.slice(13)}`)).toBe(t);
    expect(normalizeToken("short")).toBeUndefined();
    expect(encodeToken(new Uint8Array(16))).toBe("0".repeat(26));
  });

  it("property: distinct random inputs give distinct tokens", () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 16, maxLength: 16 }), fc.uint8Array({ minLength: 16, maxLength: 16 }), (a, b) => {
      const same = a.every((v, i) => v === b[i]);
      return (encodeToken(a) === encodeToken(b)) === same;
    }));
  });
});
