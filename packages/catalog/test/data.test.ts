import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTestDb } from "@outlet/db/testing";
import { loadCard, storeDetailDto } from "../src/application/data.js";
import type { StoreSellerRow } from "../src/application/data.js";

const store = (over: Partial<StoreSellerRow> = {}): StoreSellerRow => ({
  id: randomUUID(), seller_id: randomUUID(), slug: "nile-outlet", display_name_ar: "منفذ النيل", display_name_en: "Nile Outlet", tagline_ar: null, tagline_en: null, kind: "local", status: "ACTIVE",
  verified_badge: true, ships_from_country: "EG", followers_count: 12, discount_display_mode: "public", price_trust_score: 80, updated_at: new Date("2030-01-01T00:00:00Z"), seller_status: "active",
  legal_name_ar: "شركة النيل", legal_name_en: "Nile Co", commercial_register_no: "CR-1", tax_card_no: "TX-1", governorate_name_ar: "القاهرة", ...over,
});

describe("storeDetailDto", () => {
  it("projects the seller's legal identity verbatim and builds a lower-case market path", () => {
    const d = storeDetailDto("EG", store());
    expect(d.legal_identity).toEqual({ legal_name_ar: "شركة النيل", legal_name_en: "Nile Co", commercial_register_no: "CR-1", tax_card_no: "TX-1", governorate_name_ar: "القاهرة" });
    expect(d.canonical_path).toBe("/eg/stores/nile-outlet");
    expect(d.status).toBe("ACTIVE");
  });

  it("missing legal fields (seller not yet verified) become empty Arabic strings, never null, so the public listing stays well-formed", () => {
    const d = storeDetailDto("EG", store({ legal_name_ar: null, legal_name_en: null, commercial_register_no: null, tax_card_no: null, governorate_name_ar: null }));
    expect(d.legal_identity).toEqual({ legal_name_ar: "", legal_name_en: null, commercial_register_no: "", tax_card_no: "", governorate_name_ar: "" });
  });

  it("only VACATION survives as a distinct status; every other store status is shown as ACTIVE (suspension is handled by unpublishing, not by this label)", () => {
    expect(storeDetailDto("EG", store({ status: "VACATION" })).status).toBe("VACATION");
    for (const s of ["ACTIVE", "SUSPENDED", "CLOSED", "anything"]) expect(storeDetailDto("EG", store({ status: s })).status).toBe("ACTIVE");
  });
});

describe("loadCard", () => {
  it("returns undefined for a defect card id that does not exist (no throw, no empty shell)", async () => {
    await withTestDb(async (db) => {
      expect(await loadCard(db, randomUUID())).toBeUndefined();
    });
  });
});
