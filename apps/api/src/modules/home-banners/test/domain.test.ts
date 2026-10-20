import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_SLIDES,
  SPONSORED_LABEL,
  composeSlides,
  isLive,
  lifecycleOf,
  sponsoredLabel,
  transition,
  validateCta,
  validateDraft,
  validateWindow,
  type BannerDraft,
  type HomeBanner,
} from "../domain/banner";
import { H, NOW, banner, sponsored } from "./fixtures";

const draft = (o: Partial<BannerDraft> = {}): BannerDraft => ({
  titleAr: "خصم",
  titleEn: null,
  subtitleAr: null,
  subtitleEn: null,
  imageKey: null,
  artVariant: null,
  priority: 100,
  startsAtMs: NOW,
  endsAtMs: NOW + H,
  sponsored: false,
  sponsorRef: null,
  cta: { kind: "store", targetId: "store_1" },
  ...o,
});

describe("schedule window (server time)", () => {
  it("is live on [starts, ends) for scheduled banners only", () => {
    const b = banner(1, { startsAtMs: NOW, endsAtMs: NOW + H });
    expect(isLive(b, NOW - 1)).toBe(false);
    expect(isLive(b, NOW)).toBe(true);
    expect(isLive(b, NOW + H - 1)).toBe(true);
    expect(isLive(b, NOW + H)).toBe(false);
    expect(isLive({ ...b, status: "paused" }, NOW)).toBe(false);
    expect(isLive({ ...b, status: "draft" }, NOW)).toBe(false);
  });
  it("derives the lifecycle", () => {
    const b = banner(1, { startsAtMs: NOW, endsAtMs: NOW + H });
    expect(lifecycleOf(b, NOW - 1)).toBe("scheduled");
    expect(lifecycleOf(b, NOW)).toBe("live");
    expect(lifecycleOf(b, NOW + H)).toBe("expired");
    expect(lifecycleOf({ ...b, status: "paused" }, NOW)).toBe("paused");
    expect(lifecycleOf({ ...b, status: "draft" }, NOW)).toBe("draft");
  });
  it("rejects start >= end and windows over 90 days", () => {
    expect(validateWindow(NOW, NOW)).toHaveLength(1);
    expect(validateWindow(NOW, NOW - 1)).toHaveLength(1);
    expect(validateWindow(NOW, NOW + 91 * 24 * H)).toEqual([{ pointer: "/ends_at", code: "window_too_long" }]);
    expect(validateWindow(NOW, NOW + 90 * 24 * H)).toEqual([]);
  });
});

describe("transitions", () => {
  it("follows draft -> scheduled <-> paused", () => {
    const b = { status: "draft" as const, endsAtMs: NOW + H };
    expect(transition(b, "schedule", NOW)).toEqual({ kind: "ok", status: "scheduled" });
    expect(transition({ ...b, status: "scheduled" }, "pause", NOW)).toEqual({ kind: "ok", status: "paused" });
    expect(transition({ ...b, status: "paused" }, "resume", NOW)).toEqual({ kind: "ok", status: "scheduled" });
    expect(transition(b, "pause", NOW)).toEqual({ kind: "invalid_state", status: "draft" });
    expect(transition({ ...b, status: "scheduled" }, "schedule", NOW)).toEqual({ kind: "invalid_state", status: "scheduled" });
  });
  it("refuses to schedule or resume an elapsed window", () => {
    expect(transition({ status: "draft", endsAtMs: NOW }, "schedule", NOW)).toEqual({ kind: "window_elapsed" });
    expect(transition({ status: "paused", endsAtMs: NOW - 1 }, "resume", NOW)).toEqual({ kind: "window_elapsed" });
  });
});

describe("CTA typing", () => {
  it("accepts typed targets and refuses URLs everywhere", () => {
    expect(validateCta({ kind: "drop", targetId: "drop_9" })).toEqual([]);
    expect(validateCta({ kind: "store", targetId: "https://evil.example" })).toHaveLength(1);
    expect(validateCta({ kind: "voucher", targetId: "a b" })).toHaveLength(1);
    expect(validateCta({ kind: "search", query: "https://evil.example/x", priceMin: null, priceMax: null })).toEqual([{ pointer: "/cta/query", code: "url_not_allowed" }]);
    expect(validateCta({ kind: "search", query: "javascript:alert(1)", priceMin: null, priceMax: null })).toHaveLength(1);
    expect(validateCta({ kind: "search", query: "white linen dress", priceMin: 10_000n, priceMax: 150_000n })).toEqual([]);
  });
  it("checks price bounds in integer piastres", () => {
    expect(validateCta({ kind: "category", targetId: "dresses", priceMin: 200n, priceMax: 100n })).toEqual([{ pointer: "/cta/price_min", code: "exceeds_max" }]);
    expect(validateCta({ kind: "category", targetId: "dresses", priceMin: -1n, priceMax: null })).toHaveLength(1);
    expect(validateCta({ kind: "category", targetId: "dresses", priceMin: null, priceMax: 100_000_001n })).toHaveLength(1);
  });
});

describe("draft validation", () => {
  it("requires Arabic and caps text lengths; English subtitle needs Arabic", () => {
    expect(validateDraft(draft())).toEqual([]);
    expect(validateDraft(draft({ titleAr: "" })).map((p) => p.pointer)).toContain("/title/ar");
    expect(validateDraft(draft({ titleAr: "ا".repeat(61) })).map((p) => p.pointer)).toContain("/title/ar");
    expect(validateDraft(draft({ subtitleEn: "x" })).map((p) => p.code)).toContain("required_with_en");
  });
  it("sponsored requires a reference and a reference requires sponsored", () => {
    expect(validateDraft(draft({ sponsored: true })).map((p) => p.code)).toContain("required_when_sponsored");
    expect(validateDraft(draft({ sponsorRef: "ads:1234" })).map((p) => p.code)).toContain("only_when_sponsored");
    expect(validateDraft(draft({ sponsored: true, sponsorRef: "ads:1234" }))).toEqual([]);
  });
  it("accepts object-store keys only for images", () => {
    expect(validateDraft(draft({ imageKey: "home-banners/2026/10/abc-123" }))).toEqual([]);
    for (const k of ["https://cdn.example/a.png", "//cdn.example/a", "../../etc/passwd", "a.png", "/abs/path/key"]) {
      expect(validateDraft(draft({ imageKey: k })).map((p) => p.pointer), k).toContain("/image_key");
    }
  });
});

describe("composition", () => {
  it("orders by priority, then earlier start, then id; hides non-live", () => {
    const a = banner(1, { priority: 10 });
    const b = banner(2, { priority: 50 });
    const c = banner(3, { priority: 50, startsAtMs: NOW - 2 * H });
    const paused = banner(4, { priority: 999, status: "paused" });
    const future = banner(5, { priority: 999, startsAtMs: NOW + 1 });
    expect(composeSlides([a, b, c, paused, future], NOW).map((s) => s.id)).toEqual([c.id, b.id, a.id]);
  });
  it("spaces sponsored slides and defers them behind organic ones", () => {
    const s1 = sponsored(1, { priority: 900 });
    const s2 = sponsored(2, { priority: 800 });
    const o = [3, 4, 5].map((n) => banner(n, { priority: 100 - n }));
    const ids = composeSlides([s1, s2, ...o], NOW).map((s) => s.id);
    expect(ids).toEqual([s1.id, o[0]?.id, o[1]?.id, s2.id, o[2]?.id]);
  });
  it("drops a sponsored banner that can never be spaced", () => {
    const out = composeSlides([sponsored(1), sponsored(2), sponsored(3)], NOW);
    expect(out).toHaveLength(1);
  });
  it("labels sponsored slides", () => {
    expect(sponsoredLabel(sponsored(1))).toEqual(SPONSORED_LABEL);
    expect(sponsoredLabel(banner(1))).toBeNull();
  });

  const arb = fc.array(
    fc.record({
      n: fc.integer({ min: 1, max: 40 }),
      prio: fc.integer({ min: 0, max: 1000 }),
      sp: fc.boolean(),
      status: fc.constantFrom("scheduled", "scheduled", "scheduled", "paused", "draft"),
      start: fc.integer({ min: -3, max: 3 }),
      len: fc.integer({ min: 1, max: 4 }),
    }),
    { maxLength: 40 },
  );
  it("property: <= 8 slides, all live, sorted, sponsored never twice in any 3 consecutive slides", () => {
    fc.assert(
      fc.property(arb, fc.integer({ min: -4 * H, max: 4 * H }), (rows, shift) => {
        const seen = new Set<number>();
        const list: HomeBanner[] = [];
        for (const r of rows) {
          if (seen.has(r.n)) continue;
          seen.add(r.n);
          const base = { priority: r.prio, status: r.status, startsAtMs: NOW + r.start * H, endsAtMs: NOW + (r.start + r.len) * H };
          list.push(r.sp ? sponsored(r.n, base) : banner(r.n, base));
        }
        const now = NOW + shift;
        const out = composeSlides(list, now);
        expect(out.length).toBeLessThanOrEqual(MAX_SLIDES);
        expect(out.every((b) => isLive(b, now))).toBe(true);
        for (let i = 0; i + 2 < out.length + 2; i++) {
          expect(out.slice(i, i + 3).filter((b) => b.sponsored).length).toBeLessThanOrEqual(1);
        }
        expect(new Set(out.map((b) => b.id)).size).toBe(out.length);
        // Idempotent and input-order independent.
        expect(composeSlides([...list].reverse(), now).map((b) => b.id)).toEqual(out.map((b) => b.id));
      }),
      { numRuns: 300 },
    );
  });
});
