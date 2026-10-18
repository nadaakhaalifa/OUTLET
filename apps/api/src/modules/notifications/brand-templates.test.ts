import { describe, expect, it } from "vitest";
import { BRAND_TEMPLATE_KEYS, brandTemplates } from "./adapters/brand-templates";
import { seedTemplates } from "./adapters/seed-templates";
import { checkActivation, checkPayload, renderTemplate } from "./domain/templates";

describe("brand onboarding templates", () => {
  const all = brandTemplates();
  it("covers the five keys on in_app, push and email with stable unique ids", () => {
    expect(BRAND_TEMPLATE_KEYS).toEqual([
      "brand_application_received",
      "brand_application_needs_info",
      "brand_application_approved",
      "brand_application_rejected",
      "brand_application_appeal_result",
    ]);
    expect(all).toHaveLength(15);
    expect(new Set(all.map((t) => t.id)).size).toBe(15);
    expect(brandTemplates().map((t) => t.id)).toEqual(all.map((t) => t.id));
    for (const k of BRAND_TEMPLATE_KEYS) expect(all.filter((t) => t.key === k).map((t) => t.channel).sort()).toEqual(["email", "in_app", "push"]);
  });
  it("activates (Arabic subject/body, matching placeholders), is transactional, and renders AR and EN", () => {
    for (const t of all) {
      expect(checkActivation(t)).toBeNull();
      expect(t.category).toBe("transactional");
      expect(checkPayload(t, { brand_name: "Nile" })).toBeNull();
      expect(checkPayload(t, { brand_name: "Nile", message: "x" })).toBe("unknown_key");
      expect(renderTemplate(t, { brand_name: "Nile" }, "ar").bodyAr).toContain("Nile");
      expect(renderTemplate(t, { brand_name: "Nile" }, "en").bodyEn).toContain("Nile");
    }
  });
  it("is registered with the seed templates", () => {
    const keys = new Set(seedTemplates().map((t) => t.key));
    for (const k of BRAND_TEMPLATE_KEYS) expect(keys.has(k)).toBe(true);
  });
});
