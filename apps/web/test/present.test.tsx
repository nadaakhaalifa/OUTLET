import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

let pathname = "/eg-ar";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

import { money } from "@outlet/money";
import { HeaderTabs } from "../src/components/HeaderTabs";
import { decimalString, pick, toCondition, toCubby, toImage, toPricing, toStoreCard } from "../src/lib/present";
import type { StoreSummary } from "../src/server/api-client";
import { product, store } from "./fixtures";

const pub = { discountDisplayMode: "public" as const };
const verified = (over = {}) => product(1, { claimType: "verified_discount", referenceAmountMinor: 200_000n, referenceCurrency: "EGP", ...over });

describe("pick", () => {
  it("Arabic locale always uses Arabic; English uses English only when non-empty", () => {
    expect(pick("ar-EG", "ع", "E")).toBe("ع");
    expect(pick("en-EG", "ع", "E")).toBe("E");
    expect(pick("en-EG", "ع", null)).toBe("ع");
    expect(pick("en-EG", "ع", "")).toBe("ع");
  });
});

describe("toPricing honesty", () => {
  it("shows a verified claim only when every condition holds", () => {
    expect(toPricing(verified(), pub)?.verified).toMatchObject({ claimAllowed: true, evidenceIds: ["/v1/eg/proof/1"] });
  });
  it.each([
    ["no store", verified(), null],
    ["member-only store", verified(), { discountDisplayMode: "member_only" as const }],
    ["hidden store", verified(), { discountDisplayMode: "hidden" as const }],
    ["no reference amount", verified({ referenceAmountMinor: undefined }), pub],
    ["no reference currency", verified({ referenceCurrency: undefined }), pub],
    ["unknown reference currency", verified({ referenceCurrency: "XXX" }), pub],
    ["empty proof path", verified({ priceProofPath: "" }), pub],
    ["lowest_30d claim", verified({ claimType: "lowest_30d" }), pub],
  ])("never shows a discount: %s", (_n, p, s) => {
    const r = toPricing(p, s);
    expect(r).not.toBeNull();
    expect(r?.verified).toBeUndefined();
    expect(r?.price).toEqual(money(80_000n, "EGP"));
  });
  it("launch price keeps its label; unknown currency is not rendered", () => {
    expect(toPricing(product(1, { claimType: "launch_price" }), pub)).toMatchObject({ priceKind: "launch" });
    expect(toPricing(product(1, { claimType: "plain" }), pub)).not.toHaveProperty("priceKind");
    expect(toPricing(product(1, { currency: "ZZZ" }), pub)).toBeNull();
  });
});

describe("toCondition", () => {
  it("normalises case and dashes; unknown codes are undefined", () => {
    expect(toCondition("OPEN-BOX")).toBe("openBox");
    expect(toCondition("near_expiry")).toBe("nearExpiry");
    expect(toCondition("sample")).toBe("sample");
    expect(toCondition("pre_owned")).toBeUndefined();
  });
});

describe("toImage", () => {
  it("none without an image", () => {
    expect(toImage({ ...product(1), image: null }, "en-EG")).toBeUndefined();
  });
  it("uses the localised alt, falls back to the title when alt is empty, and omits missing dimensions", () => {
    const base = product(1);
    expect(toImage(base, "en-EG")).toEqual({ src: base.image!.url, alt: "Jacket 1 photo", width: 400, height: 500 });
    expect(toImage({ ...base, image: { ...base.image!, altAr: null, altEn: null } }, "en-EG")?.alt).toBe("Jacket 1");
    expect(toImage({ ...base, image: { ...base.image!, altAr: null, altEn: null } }, "ar-EG")?.alt).toBe("جاكيت 1");
    expect(toImage({ ...base, image: { ...base.image!, width: null, height: null } }, "en-EG")).toEqual({ src: base.image!.url, alt: "Jacket 1 photo" });
  });
});

describe("toCubby", () => {
  it("builds an item with an escaped quick-view link and image", () => {
    const c = toCubby({ ...product(1), id: "a b/c" }, "en-EG", store, "/eg-en/stores/nile");
    expect(c).toMatchObject({ key: "a b/c", name: "Jacket 1", href: "/eg-en/stores/nile?p=a%20b%2Fc" });
    expect(c?.image).toBeDefined();
  });
  it("omits the image when there is none, and returns null for an unknown currency", () => {
    expect(toCubby({ ...product(1), image: null }, "ar-EG", store, "/s")).not.toHaveProperty("image");
    expect(toCubby(product(1, { currency: "ZZZ" }), "ar-EG", store, "/s")).toBeNull();
  });
});

describe("decimalString", () => {
  it("formats minor units without floats, including negatives and short amounts", () => {
    expect(decimalString(money(80_000n, "EGP"))).toBe("800.00");
    expect(decimalString(money(5n, "EGP"))).toBe("0.05");
    expect(decimalString(money(0n, "EGP"))).toBe("0.00");
    expect(decimalString(money(-1_234n, "EGP"))).toBe("-12.34");
  });
});

describe("toStoreCard", () => {
  const s: StoreSummary = { id: "1", slug: "nile", nameAr: "نيل", nameEn: "Nile", kind: "local" };
  it("localises the name and links under the base; art is optional with optional dimensions", () => {
    expect(toStoreCard(s, "en-EG", "/eg-en", "Local")).toEqual({ key: "nile", storeName: "Nile", category: "Local", href: "/eg-en/stores/nile" });
    expect(toStoreCard({ ...s, nameEn: null }, "en-EG", "/b", "L").storeName).toBe("نيل");
    expect(toStoreCard({ ...s, art: { src: "/a.jpg" } }, "ar-EG", "/b", "L").image).toEqual({ src: "/a.jpg", alt: "" });
    expect(toStoreCard({ ...s, art: { src: "/a.jpg", width: 3, height: 4 } }, "ar-EG", "/b", "L").image).toEqual({ src: "/a.jpg", alt: "", width: 3, height: 4 });
  });
});

describe("HeaderTabs", () => {
  it.each([
    ["/eg-ar", "explore"],
    ["/eg-ar/stores/nile", "explore"],
    ["/eg-ar/deals", "deals"],
    ["/eg-ar/deals/70", "deals"],
    ["/eg-ar/account", "none"],
  ])("%s marks %s", (path, active) => {
    pathname = path;
    render(<HeaderTabs base="/eg-ar" locale="en-EG" />);
    const current = screen.getAllByRole("link").filter((l) => l.getAttribute("aria-current") === "page").map((l) => l.getAttribute("href"));
    expect(current).toEqual(active === "explore" ? ["/eg-ar"] : active === "deals" ? ["/eg-ar/deals"] : []);
  });
});
