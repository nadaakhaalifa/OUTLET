import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DAY_MS, PARITY_GRACE_MS, STALE_EVIDENCE_MS, TAU_BP, addBusinessDays, anomalySignals, computeWindow, detectDuplicateReset, detectImageReuse,
  detectPingPong, detectPreDropSpike, detectSuddenDiscount, enforcementLadder, externalWindow, hamming, parityCheck, priceTrustScore, riskTierOf,
  vrpFromInternal, vrpWithExternal,
} from "../src/index.js";
import type { ExternalSnapshot, TrustSignals, Violation, ViolationRule } from "../src/index.js";

const RUNS = { numRuns: 1000 };
const NOW = new Date("2026-10-01T09:00:00.000Z");
const d = (n: number): Date => new Date(NOW.getTime() + n * DAY_MS);
// 100 -> 80 held, discount run begins 10 days ago, 60 days of history: internal reference 100.
const internal = () => computeWindow([{ priceMinor: 100n, validFrom: d(-60) }, { priceMinor: 80n, validFrom: d(-10) }], NOW);
const ext = (prices: [number, bigint][], lastAgoH = 1): ReturnType<typeof externalWindow> =>
  externalWindow(prices.map(([day, p]): ExternalSnapshot => ({ priceMinor: p, fetchedAt: d(day) })).concat([{ priceMinor: prices[prices.length - 1]?.[1] ?? 1n, fetchedAt: new Date(NOW.getTime() - lastAgoH * 3_600_000) }]), NOW);

describe("vrpWithExternal", () => {
  it("external lower wins, higher is ignored, internal only when unmatched or short history", () => {
    expect(vrpFromInternal(internal(), NOW)).toBe(100n);
    expect(vrpWithExternal(internal(), ext([[-45, 90n]]), 9500, TAU_BP, { now: NOW })).toMatchObject({ vrp: 90n, referenceClass: "external", reason: "external_lower" });
    expect(vrpWithExternal(internal(), ext([[-45, 120n]]), 9500, TAU_BP, { now: NOW })).toMatchObject({ vrp: 100n, referenceClass: "internal", reason: "external_not_lower" });
    expect(vrpWithExternal(internal(), ext([[-45, 50n]]), 9000, TAU_BP, { now: NOW })).toMatchObject({ vrp: 100n, reason: "unmatched" });
    expect(vrpWithExternal(internal(), null, 10000, TAU_BP, { now: NOW }).reason).toBe("unmatched");
    expect(vrpWithExternal(internal(), ext([[-5, 50n]]), 9500, TAU_BP, { now: NOW })).toMatchObject({ vrp: 100n, reason: "short_history" });
  });
  it("fails closed after 72 h of stale evidence and never creates a reference alone; brand RRP stays separate", () => {
    const stale = externalWindow([{ priceMinor: 90n, fetchedAt: d(-45) }, { priceMinor: 90n, fetchedAt: new Date(NOW.getTime() - STALE_EVIDENCE_MS - 1000) }], NOW);
    expect(vrpWithExternal(internal(), stale, 9500, TAU_BP, { now: NOW })).toMatchObject({ vrp: null, reason: "stale_external" });
    expect(vrpWithExternal(internal(), externalWindow([], NOW), 9500, TAU_BP, { now: NOW }).vrp).toBeNull();
    const launch = computeWindow([{ priceMinor: 100n, validFrom: d(-5) }], NOW);
    expect(vrpWithExternal(launch, ext([[-45, 90n]]), 9500, TAU_BP, { now: NOW })).toMatchObject({ vrp: null, referenceClass: "none" });
    expect(vrpWithExternal(internal(), null, 0, TAU_BP, { now: NOW, brandRrp: 500n })).toMatchObject({ vrp: 100n, brandRrp: 500n });
  });
  it("property: external evidence only LOWERS the VRP, and the claim never exceeds the strictest evidence", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 1, maxLength: 6 }), fc.integer({ min: 0, max: 10000 }), fc.integer({ min: 0, max: 100 }), (cur, extPrices, conf, ageH) => {
        const base = vrpFromInternal(internal(), NOW);
        const snaps: ExternalSnapshot[] = extPrices.map((p, i) => ({ priceMinor: BigInt(p), fetchedAt: new Date(NOW.getTime() - (ageH + 24 * (extPrices.length - i + 30)) * 3_600_000) }));
        snaps.push({ priceMinor: BigInt(extPrices[0] ?? 1), fetchedAt: new Date(NOW.getTime() - ageH * 3_600_000) });
        const ew = externalWindow(snaps, NOW);
        const r = vrpWithExternal(internal(), ew, conf, TAU_BP, { now: NOW });
        if (r.vrp !== null && base !== null) expect(r.vrp <= base).toBe(true);
        if (r.referenceClass === "external" && ew.window.low30d !== null) expect(r.vrp).toBe(ew.window.low30d);
        if (r.vrp !== null) expect(BigInt(cur) < r.vrp ? r.vrp > BigInt(cur) : true).toBe(true);
      }),
      RUNS,
    );
  });
});

describe("parityCheck", () => {
  const base = { ourPrice: 100n, externalCurrent: 90n, externalFetchedAt: NOW, matchConfBp: 9500, tauBp: TAU_BP, now: NOW, breachSince: null };
  it("demotes with a 48 h deadline, pauses after it, and ignores unverifiable evidence", () => {
    expect(parityCheck(base)).toMatchObject({ status: "breach", action: "demote" });
    expect(parityCheck(base).fixDeadline?.getTime()).toBe(NOW.getTime() + PARITY_GRACE_MS);
    expect(parityCheck({ ...base, breachSince: new Date(NOW.getTime() - PARITY_GRACE_MS) }).action).toBe("pause_sku");
    expect(parityCheck({ ...base, breachSince: new Date(NOW.getTime() - PARITY_GRACE_MS + 1) }).action).toBe("demote");
    expect(parityCheck({ ...base, externalCurrent: 100n }).status).toBe("ok");
    expect(parityCheck({ ...base, externalCurrent: null }).status).toBe("unmatched");
    expect(parityCheck({ ...base, matchConfBp: 100 }).status).toBe("unmatched");
    expect(parityCheck({ ...base, externalFetchedAt: null }).status).toBe("stale");
    expect(parityCheck({ ...base, externalFetchedAt: new Date(NOW.getTime() - STALE_EVIDENCE_MS - 1) }).action).toBe("none");
  });
});

describe("priceTrustScore", () => {
  const clean: TrustSignals = { fakeReferences90d: 0, inflations90d: 0, openParityBreach: false, resolvedParityBreaches90d: 0, anomalySignals: 0, hasVerifiedChannel: true, staleEvidence: false, upheldAppeals90d: 0 };
  it("weights and tiers", () => {
    expect(priceTrustScore(clean)).toBe(100);
    expect(priceTrustScore({ ...clean, fakeReferences90d: 1, inflations90d: 1, openParityBreach: true, resolvedParityBreaches90d: 1, anomalySignals: 1, hasVerifiedChannel: false, staleEvidence: true })).toBe(100 - 15 - 10 - 20 - 5 - 8 - 10 - 10);
    expect(priceTrustScore({ ...clean, fakeReferences90d: 99, inflations90d: 99, resolvedParityBreaches90d: 99, anomalySignals: 99, openParityBreach: true, hasVerifiedChannel: false, staleEvidence: true })).toBe(0);
    expect(priceTrustScore({ ...clean, upheldAppeals90d: 9 })).toBe(100);
    expect(priceTrustScore({ ...clean, fakeReferences90d: 1, upheldAppeals90d: 1 })).toBe(90);
    expect([riskTierOf(80), riskTierOf(79), riskTierOf(50), riskTierOf(49)]).toEqual(["trusted", "normal", "normal", "watched"]);
  });
  it("property: always an integer in 0..100", () => {
    fc.assert(fc.property(fc.integer({ min: -5, max: 99 }), fc.integer({ min: -5, max: 99 }), fc.boolean(), fc.boolean(), fc.integer({ min: 0, max: 99 }), (a, b, c, e, f) => {
      const s = priceTrustScore({ ...clean, fakeReferences90d: a, inflations90d: b, openParityBreach: c, staleEvidence: e, upheldAppeals90d: f });
      expect(Number.isInteger(s) && s >= 0 && s <= 100).toBe(true);
    }), RUNS);
  });
});

describe("enforcementLadder", () => {
  const v = (rule: ViolationRule, daysAgo: number, severe = false): Violation => ({ rule, at: d(-daysAgo), severe });
  const names = (x: ReturnType<typeof enforcementLadder>) => x.acts.map((a) => a.action);
  it("maps each event to the table", () => {
    expect(names(enforcementLadder(v("fake_reference", 0), [], NOW))).toEqual(["autocorrect_display"]);
    const inf = enforcementLadder(v("pre_discount_inflation", 0), [], NOW);
    expect(names(inf)).toEqual(["remove_badge", "rank_penalty"]);
    expect(inf.acts[0]?.expiresAt?.getTime()).toBe(NOW.getTime() + 30 * DAY_MS);
    expect(names(enforcementLadder(v("parity_breach", 0), [], NOW))).toEqual(["demote"]);
    expect(names(enforcementLadder(v("parity_unfixed", 0), [], NOW))).toEqual(["demote", "pause_sku"]);
    expect(names(enforcementLadder(v("channel_disconnected", 0), [], NOW))).toEqual(["remove_all_pct"]);
    expect(names(enforcementLadder(v("ping_pong", 0), [], NOW))).toEqual(["rank_penalty"]);
  });
  it("3 violations in 90 days sanction; old ones do not count; severe or repeat suspends with a 5 business day review", () => {
    const three = enforcementLadder(v("fake_reference", 0), [v("fake_reference", 10), v("parity_breach", 80)], NOW);
    expect(names(three)).toEqual(["autocorrect_display", "lose_verified", "commission_surcharge", "block_drops"]);
    expect(three.violations90d).toBe(3);
    expect(names(enforcementLadder(v("fake_reference", 0), [v("fake_reference", 10), v("fake_reference", 91)], NOW))).toEqual(["autocorrect_display"]);
    const sev = enforcementLadder(v("fake_reference", 0, true), [], NOW);
    expect(sev).toMatchObject({ humanReviewRequired: true });
    expect(names(sev)).toContain("suspend_store");
    expect(names(enforcementLadder(v("fake_reference", 0), [v("fake_reference", 5, true)], NOW))).toContain("suspend_store");
    expect(enforcementLadder(v("fake_reference", 0), Array.from({ length: 5 }, (_, i) => v("fake_reference", i + 1)), NOW).humanReviewRequired).toBe(true);
    expect(enforcementLadder(v("fake_reference", 0), [], NOW).reviewDueBy).toBeNull();
  });
  it("addBusinessDays skips Friday and Saturday", () => {
    expect(addBusinessDays(new Date("2026-11-05T09:00:00Z"), 1).toISOString()).toBe("2026-11-08T09:00:00.000Z"); // Thu -> Sun
    expect(addBusinessDays(new Date("2026-11-08T09:00:00Z"), 5).toISOString()).toBe("2026-11-15T09:00:00.000Z");
  });
  it("property: the ladder is monotonic in the violation count", () => {
    const rules: ViolationRule[] = ["fake_reference", "pre_discount_inflation", "parity_breach", "parity_unfixed", "channel_disconnected", "ping_pong"];
    fc.assert(
      fc.property(fc.constantFrom(...rules), fc.array(fc.record({ rule: fc.constantFrom(...rules), ago: fc.integer({ min: 0, max: 120 }), severe: fc.boolean() }), { maxLength: 10 }), (cur, hist) => {
        const h = hist.map((x) => v(x.rule, x.ago, x.severe));
        let prev = new Set<string>();
        let prevN = 0;
        for (let k = 0; k <= h.length; k++) {
          const r = enforcementLadder(v(cur, 0), h.slice(0, k), NOW);
          const now = new Set<string>(names(r));
          for (const a of prev) expect(now.has(a)).toBe(true);
          expect(r.violations90d).toBeGreaterThanOrEqual(prevN);
          prev = now;
          prevN = r.violations90d;
        }
      }),
      RUNS,
    );
  });
});

describe("anomaly detectors", () => {
  const pt = (day: number, p: bigint) => ({ at: d(day), priceMinor: p });
  it("pre-drop spike", () => {
    expect(detectPreDropSpike([pt(-40, 100n), pt(-20, 150n), pt(-1, 100n)], NOW)?.kind).toBe("pre_drop_spike");
    expect(detectPreDropSpike([pt(-40, 100n), pt(-20, 150n)], NOW)).toBeNull();
    expect(detectPreDropSpike([pt(-80, 100n), pt(-70, 150n), pt(-1, 100n)], NOW)).toBeNull();
    expect(detectPreDropSpike([pt(-5, 100n)], NOW)).toBeNull();
  });
  it("ping-pong", () => {
    expect(detectPingPong([pt(-6, 100n), pt(-5, 150n), pt(-4, 100n), pt(-3, 150n), pt(-2, 100n)])?.kind).toBe("ping_pong");
    expect(detectPingPong([pt(-6, 100n), pt(-5, 150n), pt(-4, 100n)])).toBeNull();
    expect(detectPingPong([pt(-6, 100n), pt(-5, 101n), pt(-4, 100n), pt(-3, 101n), pt(-2, 100n), pt(-1, 100n)])).toBeNull();
    expect(detectPingPong([])).toBeNull();
  });
  const fp = (id: string, store: string, hash: number, active: boolean, color = "red") => ({ id, storeId: store, phash: new Uint8Array([hash, 0, 0, 0, 0, 0, 0, 0]), brand: "b", color, category: "c", active });
  it("duplicate reset and image reuse via pHash", () => {
    expect(hamming(new Uint8Array([0b101]), new Uint8Array([0b010]))).toBe(3);
    expect(hamming(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(Number.POSITIVE_INFINITY);
    const n = fp("n", "s1", 0b1, true);
    expect(detectDuplicateReset(n, [fp("o", "s1", 0b11, false)])?.inheritsFrom).toBe("o");
    expect(detectDuplicateReset(n, [fp("o", "s1", 0b11, false, "blue")])).toBeNull();
    expect(detectDuplicateReset(n, [fp("o", "s1", 0b11, true)])).toBeNull();
    expect(detectDuplicateReset(n, [fp("o", "s2", 0b11, false)])).toBeNull();
    expect(detectDuplicateReset(n, [fp("o", "s1", 0xff, false)])).toBeNull();
    expect(detectImageReuse(n, [fp("x", "s2", 0b1, true, "blue")])?.kind).toBe("image_reuse");
    expect(detectImageReuse(n, [fp("x", "s1", 0b1, true)])).toBeNull();
  });
  it("sudden discount before a mega event and the aggregate", () => {
    const series = [pt(-20, 100n), pt(-3, 60n)];
    const ev = [{ startsAt: d(5) }];
    expect(detectSuddenDiscount(series, ev, 5)?.kind).toBe("sudden_discount");
    expect(detectSuddenDiscount(series, ev, 50)).toBeNull();
    expect(detectSuddenDiscount(series, [{ startsAt: d(60) }], 5)).toBeNull();
    expect(detectSuddenDiscount([pt(-20, 100n), pt(-3, 90n)], ev, 5)).toBeNull();
    expect(detectSuddenDiscount([pt(-20, 100n), pt(-3, 120n)], ev, 5)).toBeNull();
    expect(anomalySignals({ series, dropAt: NOW, megaEvents: ev, sellThroughPct: 5 }).map((s) => s.kind)).toEqual(["sudden_discount"]);
    const n = fp("n", "s1", 1, true);
    expect(anomalySignals({ series: [], dropAt: NOW, listing: n, sameStoreListings: [fp("o", "s1", 1, false)], otherStoreListings: [fp("x", "s2", 1, true)] }).map((s) => s.kind)).toEqual(["duplicate_reset", "image_reuse"]);
    expect(anomalySignals({ series: [], dropAt: NOW, listing: n })).toEqual([]);
  });
});
