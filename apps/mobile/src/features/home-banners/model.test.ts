import { describe, expect, it } from "vitest";
import {
  AUTO_ADVANCE_MS, ImpressionOnce, InMemoryHomeBannersPort, dragTarget, fixtureBannersWire, goTo, initAuto, nextBoundaryMs,
  normaliseBanner, normaliseBanners, pause, resume, routeForCta, selectSlides, settleStep, slotX, stepIndex, tick, timerActive, withCount, wrapIndex,
  type HomeBannerWire,
} from "./model";

const T = Date.parse("2026-10-12T10:00:00Z");
const base: HomeBannerWire = {
  id: "a", title: { ar: "عنوان" }, sponsored: false,
  starts_at: "2026-10-12T00:00:00Z", ends_at: "2026-10-13T00:00:00Z", cta: { kind: "store", target_id: "s1" },
};

describe("normalise", () => {
  it("falls back to Arabic when English is missing and picks default art", () => {
    const b = normaliseBanner(base);
    expect(b?.title.en).toBe("عنوان");
    expect(b?.art).toBe("atelier");
  });
  it("drops unusable items: empty title, inverted window, missing target, bad price range, unknown kind", () => {
    expect(normaliseBanner({ ...base, title: { ar: " " } })).toBeNull();
    expect(normaliseBanner({ ...base, ends_at: base.starts_at })).toBeNull();
    expect(normaliseBanner({ ...base, cta: { kind: "drop" } })).toBeNull();
    expect(normaliseBanner({ ...base, cta: { kind: "search", price_min: 10, price_max: 5 } })).toBeNull();
    expect(normaliseBanner({ ...base, cta: { kind: "search" } })).toBeNull();
    expect(normaliseBanner({ ...base, cta: { kind: "search", price_max: 1.5 } })).toBeNull();
    expect(normaliseBanner({ ...base, cta: { kind: "url" as never, target_id: "x" } })).toBeNull();
  });
  it("accepts https images only and dedupes ids", () => {
    expect(normaliseBanner({ ...base, image_url: "http://x/y.png" })?.imageUrl).toBeNull();
    expect(normaliseBanner({ ...base, image_url: "https://x/y.png" })?.imageUrl).toBe("https://x/y.png");
    const d = normaliseBanners({ items: [base, base], server_time: "2026-10-12T10:00:00Z" });
    expect(d.banners).toHaveLength(1);
    expect(d.serverNowMs).toBe(T);
  });
});

describe("selection by server time", () => {
  const items = normaliseBanners({
    server_time: "2026-10-12T10:00:00Z",
    items: [
      { ...base, id: "live" },
      { ...base, id: "future", starts_at: "2026-10-12T12:00:00Z" },
      { ...base, id: "ended", ends_at: "2026-10-12T09:00:00Z" },
      { ...base, id: "edge-end", starts_at: "2026-10-12T08:00:00Z", ends_at: "2026-10-12T10:00:00Z" },
    ],
  }).banners;
  it("is start-inclusive, end-exclusive and keeps server order", () => {
    expect(selectSlides(items, T).map((b) => b.id)).toEqual(["live"]);
    expect(selectSlides(items, Date.parse("2026-10-12T12:00:00Z")).map((b) => b.id)).toEqual(["live", "future"]);
  });
  it("caps and reports the next boundary", () => {
    expect(selectSlides(items, T, 0)).toEqual([]);
    expect(nextBoundaryMs(items, T)).toBe(Date.parse("2026-10-12T12:00:00Z"));
    expect(nextBoundaryMs([], T)).toBeNull();
  });
  it("empty list selects nothing", () => expect(selectSlides([], T)).toEqual([]));
});

describe("cta routes", () => {
  const c = (cta: HomeBannerWire["cta"]) => normaliseBanner({ ...base, cta })!.cta;
  it("maps every kind to an internal route", () => {
    expect(routeForCta(c({ kind: "drop", target_id: "d1" }))).toEqual({ pathname: "/drops", params: { id: "d1" } });
    expect(routeForCta(c({ kind: "store", target_id: "s1" }))).toEqual({ pathname: "/shop-all", params: { store: "s1" } });
    expect(routeForCta(c({ kind: "category", target_id: "denim" }))).toEqual({ pathname: "/shop-all", params: { category: "denim" } });
    expect(routeForCta(c({ kind: "search", query: "linen", price_min: 0, price_max: 150000 }))).toEqual({ pathname: "/shop-all", params: { q: "linen", min: "0", max: "1500" } });
    expect(routeForCta(c({ kind: "search", price_max: 50050 }))).toEqual({ pathname: "/shop-all", params: { max: "501" } });
    expect(routeForCta(c({ kind: "search", price_min: 12999, query: "x" }))).toEqual({ pathname: "/shop-all", params: { q: "x", min: "129" } });
    expect(routeForCta(c({ kind: "category", target_id: "dresses", price_max: 100000 }))).toEqual({ pathname: "/shop-all", params: { category: "dresses", max: "1000" } });
    expect(routeForCta(c({ kind: "voucher" })).pathname).toBe("/rewards");
  });
});

describe("index and RTL math", () => {
  it("wraps", () => {
    expect(wrapIndex(-1, 3)).toBe(2);
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(wrapIndex(5, 0)).toBe(0);
  });
  it("mirrors slots and targets in RTL", () => {
    expect(slotX(1, 300, false, 0)).toBe(300);
    expect(slotX(1, 300, true, 0)).toBe(-300);
    expect(dragTarget(1, 300, false)).toBe(-300);
    expect(dragTarget(1, 300, true)).toBe(300);
    // the next slide lands at x = 0 after a full forward step
    expect(slotX(1, 300, true, dragTarget(1, 300, true))).toBe(0);
  });
  it("settles on distance or velocity, mirrored in RTL, and never with one slide", () => {
    expect(settleStep(-100, 0, 300, false, 3)).toBe(1);
    expect(settleStep(100, 0, 300, true, 3)).toBe(1);
    expect(settleStep(100, 0, 300, false, 3)).toBe(-1);
    expect(settleStep(-10, -0.8, 300, false, 3)).toBe(1);
    expect(settleStep(-10, 0, 300, false, 3)).toBe(0);
    expect(settleStep(-200, -1, 300, false, 1)).toBe(0);
  });
});

describe("auto-advance machine", () => {
  it("interval is 10 s (owner override of the 7 s spec)", () => expect(AUTO_ADVANCE_MS).toBe(10000));
  it("ticks with loop and never with one slide", () => {
    let s = initAuto(3);
    s = tick(tick(tick(s)));
    expect(s.index).toBe(0);
    expect(timerActive(initAuto(1))).toBe(false);
    expect(tick(initAuto(1)).index).toBe(0);
    expect(timerActive(initAuto(0))).toBe(false);
  });
  it("pauses for each reason independently and resumes only when all clear", () => {
    let s = pause(pause(initAuto(3), "touch"), "background");
    expect(timerActive(s)).toBe(false);
    expect(tick(s).index).toBe(0);
    s = resume(s, "touch");
    expect(timerActive(s)).toBe(false);
    s = resume(s, "background");
    expect(timerActive(s)).toBe(true);
    expect(pause(pause(s, "blurred"), "blurred").pauses).toEqual(["blurred"]);
  });
  it("reduce motion holds the timer (manual only)", () => expect(timerActive(pause(initAuto(3), "reduceMotion"))).toBe(false));
  it("keeps the index in range when data shrinks and supports manual goTo", () => {
    const s = withCount(goTo(initAuto(5), 4), 2);
    expect(s.index).toBe(1);
    expect(goTo(s, -1).index).toBe(1);
    expect(withCount(s, 0).index).toBe(0);
  });
});

describe("impressions and fake", () => {
  it("counts an id once", () => {
    const o = new ImpressionOnce();
    expect([o.take("a"), o.take("a"), o.take("b")]).toEqual([true, false, true]);
  });
  it("fixture is honest: only the board promo is sponsored, discount text only in promo_percent_label, all within window", async () => {
    const d = await new InMemoryHomeBannersPort(() => T).load();
    expect(d.banners.length).toBeGreaterThan(0);
    expect(selectSlides(d.banners, d.serverNowMs)).toHaveLength(d.banners.length);
    expect(d.banners.filter((b) => b.sponsored).map((b) => b.id)).toEqual(["bn-4"]);
    expect(d.devFixtures).toBe(true);
    expect(fixtureBannersWire(T).items.every((i) => i.promo_percent_label !== undefined || !JSON.stringify(i).includes("%"))).toBe(true);
  });
});
