import { describe, expect, it } from "vitest";
import { decimalPrice } from "../lib/format";
import { alternatesFor, entitySegment, idFromSegment, slugify } from "../lib/paths";
import { countdownParts } from "./helpers";
import { isIndexableDrop, ladderSteps, mysteryText, priceRange } from "../view-models/drops";
import { breadcrumbJsonLd, productJsonLd, serializeJsonLd } from "../view-models/product";
import type { Product, PublicDropDetail } from "../view-models/types";

const ID = "00000000-0000-4000-8000-000000000810";
const m = (a: number) => ({ amount: String(a), currency: "EGP" as const });
const product = (over: Partial<Product> = {}): Product => ({
  id: ID, title: { ar: "فستان كتان", en: "Linen dress" },
  store: { id: ID, slug: "nile", name: { ar: "منفذ النيل" }, kind: "local", verified_badge: true, live_drop: false },
  price: { price: m(99900), badge: "verified_discount", reference_price: m(129900), discount_pct: 23, claim_id: ID }, condition: "new_with_tags", department: "women", sponsored: false,
  images: [], skus: [{ id: ID, size_label: "M", available: true, price: { price: m(99900), badge: "none" } }],
  return_eligibility: { returnable: true, window_days: 14 }, seller_legal_identity_visible: false, size_chart_available: false, updated_at: "2026-10-01T00:00:00Z", ...over,
});

describe("json-ld", () => {
  it("emits an Offer with price and availability only: no reference price, validity, rating or reviews", () => {
    const j = productJsonLd({ product: product(), url: "https://x.test/ar/p/a", site: "https://x.test", locale: "ar", imageUrls: [] });
    const raw = JSON.stringify(j);
    expect((j.offers as Record<string, unknown>).price).toBe("999.00");
    expect((j.offers as Record<string, unknown>).availability).toBe("https://schema.org/InStock");
    expect(raw).not.toMatch(/priceValidUntil|aggregateRating|review|1299|highPrice|strikethrough/i);
    expect(j.name).toBe("فستان كتان");
  });
  it("out of stock when no SKU is available", () => {
    const p = product({ skus: [{ id: ID, size_label: "M", available: false, price: { price: m(1), badge: "none" } }] });
    const j = productJsonLd({ product: p, url: "u", site: "s", locale: "en", imageUrls: [] });
    expect((j.offers as Record<string, unknown>).availability).toBe("https://schema.org/OutOfStock");
    expect(j.name).toBe("Linen dress");
  });
  it("escapes < so data cannot close the script element", () => {
    expect(serializeJsonLd({ n: "</script><b>" })).not.toContain("<");
    expect(JSON.parse(serializeJsonLd({ n: "</script>" })).n).toBe("</script>");
  });
  it("breadcrumbs are positioned from 1", () => {
    const b = breadcrumbJsonLd([{ name: "a", url: "u1" }, { name: "b", url: "u2" }]);
    expect((b.itemListElement as { position: number }[]).map((x) => x.position)).toEqual([1, 2]);
  });
});

describe("paths and hreflang", () => {
  it("slug + uuid round-trips; Arabic slug is stable and id wins", () => {
    const seg = entitySegment(ID, undefined, "فستان كتان أبيض");
    expect(seg).toBe(`فستان-كتان-أبيض-${ID}`);
    expect(idFromSegment(encodeURIComponent(seg))).toBe(ID);
    expect(idFromSegment("nothing")).toBeNull();
    expect(entitySegment(ID, "", "!!!")).toBe(ID);
    expect(slugify("  Linen -- Dress!! ")).toBe("linen-dress");
  });
  it("alternates are self-consistent with x-default Arabic", () => {
    const a = alternatesFor("https://x.test", "en", `/p/${ID}`);
    expect(a.canonical).toBe(`https://x.test/en/p/${ID}`);
    expect(a.languages["ar-EG"]).toBe(`https://x.test/ar/p/${ID}`);
    expect(a.languages.en).toBe(a.canonical);
    expect(a.languages["x-default"]).toBe(a.languages["ar-EG"]);
  });
  it("machine price is a Latin decimal", () => {
    expect(decimalPrice(129900n)).toBe("1299.00");
    expect(decimalPrice(5n)).toBe("0.05");
  });
});

describe("drops and countdown", () => {
  const drop = { id: ID, store_id: ID, type: "price_ladder", state: "LIVE", paused: false, title: "t", starts_at: "2026-10-01T00:00:00Z", early_access_at: null, ends_at: "2026-10-02T00:00:00Z",
    limits: { per_user: 1, per_device: 1 }, mystery: { min_value: "200000", max_value: "400000", guaranteed_min: "200000", currency: "EGP" },
    ladder: [{ at: "2026-10-01T12:00:00Z", prices: [{ sku_id: ID, price: "800" }, { sku_id: ID, price: "500" }] }, { at: "2026-10-01T06:00:00Z", prices: [{ sku_id: ID, price: "900" }] }],
    server_time: "2026-10-01T00:00:00Z", currency: "EGP", items: [{ sku_id: ID, price: "700" }, { sku_id: ID, price: "300" }],
    social_proof: { bought_24h: 0, viewing_now: 0, remaining: null }, waitlist_size: null } as unknown as PublicDropDetail;
  it("derives range, ladder order and mystery disclosure from API values", () => {
    expect(priceRange(drop)).toEqual({ min: 300n, max: 700n });
    expect(ladderSteps(drop).map((s) => [s.min, s.max])).toEqual([[900n, 900n], [500n, 800n]]);
    expect(mysteryText(drop, "en")?.guaranteed).toBe("EGP 2,000");
  });
  it("only upcoming or live drops are indexable", () => {
    expect(isIndexableDrop({ state: "LIVE" })).toBe(true);
    expect(isIndexableDrop({ state: "ENDED" })).toBe(false);
    expect(isIndexableDrop({ state: "ARCHIVED" })).toBe(false);
  });
  it("countdown uses server time plus monotonic elapsed, never the device clock", () => {
    const deadline = "2026-10-01T02:30:00Z";
    const server = Date.parse("2026-10-01T00:00:00Z");
    expect(countdownParts(deadline, server, 0)).toEqual({ days: 0, hours: 2, minutes: 30 });
    expect(countdownParts(deadline, server, 31 * 60_000)).toEqual({ days: 0, hours: 1, minutes: 59 });
    expect(countdownParts(deadline, server, 3 * 3_600_000)).toBeNull();
    expect(countdownParts(deadline, null, 0)).toBeNull();
  });
});
