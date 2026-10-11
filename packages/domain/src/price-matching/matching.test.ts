import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyIsotonic, chooseTau, cohenKappaMilli, fitIsotonic, labelledSetReady, precisionRecall } from "./calibration";
import { deriveExternalEvidence, gateEvidence, isEvidenceStale, shouldStoreSnapshot, snapshotDelta, type PriceSnapshot } from "./evidence";
import { cosine, hamming64, normalizeGtin } from "./hashing";
import { isMatch, scoreMatch, type AttributeVerdict } from "./matching";
import { DEFAULT_TAU_BP, MS_PER_DAY, MS_PER_HOUR } from "./types";

const ALL_MATCH: AttributeVerdict = { brand: "match", colour: "match", material: "match", sizeRun: "overlap" };
const GTIN_A = "4006381333931"; // valid EAN-13
const H = "ffffffffffffffff";
const flip = (bits: number): string => (0xffffffffffffffffn ^ ((1n << BigInt(bits)) - 1n)).toString(16).padStart(16, "0");

describe("hashing", () => {
  it("validates GTIN check digits and normalises to 14 digits", () => {
    expect(normalizeGtin(GTIN_A)).toBe("04006381333931");
    expect(normalizeGtin("4006381333932")).toBeNull();
    expect(normalizeGtin("12345")).toBeNull();
    expect(normalizeGtin("036000291452")).toBe("00036000291452"); // UPC-A equals the zero-padded EAN-13
    expect(normalizeGtin("0036000291452")).toBe("00036000291452");
  });
  it("hamming is a metric on 64-bit hashes (property)", () => {
    const h = fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }).map((n) => n.toString(16).padStart(16, "0"));
    fc.assert(
      fc.property(h, h, h, (a, b, c) => {
        expect(hamming64(a, a)).toBe(0);
        expect(hamming64(a, b)).toBe(hamming64(b, a));
        expect((hamming64(a, c) ?? 0)).toBeLessThanOrEqual((hamming64(a, b) ?? 0) + (hamming64(b, c) ?? 0));
      }),
    );
    expect(hamming64(H, "0000000000000000")).toBe(64);
    expect(hamming64("zz", H)).toBeNull();
  });
  it("cosine", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1], [1, 2])).toBeNull();
    expect(cosine([0, 0], [1, 1])).toBeNull();
  });
});

describe("matching waterfall", () => {
  const base = { sameSeller: false, attributes: ALL_MATCH } as const;
  it("GTIN exact wins and different valid GTINs are a hard negative", () => {
    const m = scoreMatch({ ...base, haul: { gtin: GTIN_A }, external: { gtin: "04006381333931" } });
    expect(m).toMatchObject({ method: "gtin", confBp: 9_900 });
    expect(isMatch(m)).toBe(true);
    const n = scoreMatch({ ...base, haul: { gtin: GTIN_A, pHash: H }, external: { gtin: "036000291452", pHash: H } });
    expect(n).toMatchObject({ method: "none", confBp: 0, cap: "gtin_conflict" });
  });
  it("seller SKU counts only for the same seller", () => {
    expect(scoreMatch({ ...base, sameSeller: true, haul: { sellerSku: "ab-123" }, external: { sellerSku: "AB-123 " } })).toMatchObject({ method: "seller_sku", confBp: 9_400 });
    expect(scoreMatch({ ...base, sameSeller: false, haul: { sellerSku: "ab-123" }, external: { sellerSku: "ab-123" } }).method).toBe("none");
  });
  it("one image or embedding signal alone cannot reach tau; both together can", () => {
    const img = scoreMatch({ ...base, haul: { pHash: H }, external: { pHash: H } });
    expect(img.method).toBe("image_hash");
    expect(isMatch(img)).toBe(false);
    const emb = scoreMatch({ ...base, haul: { embedding: [1, 2, 3] }, external: { embedding: [1, 2, 3] } });
    expect(emb.method).toBe("embedding");
    expect(isMatch(emb)).toBe(false);
    const both = scoreMatch({ ...base, haul: { pHash: H, embedding: [1, 2, 3] }, external: { pHash: H, embedding: [1, 2, 3] } });
    expect(both).toMatchObject({ method: "image_and_embedding", confBp: 10_000 });
    expect(isMatch(both)).toBe(true);
  });
  it("hamming above the threshold is no image signal", () => {
    expect(scoreMatch({ ...base, haul: { pHash: H }, external: { pHash: flip(7) } }).method).toBe("none");
    expect(scoreMatch({ ...base, haul: { pHash: H }, external: { pHash: flip(6) } }).signals.imageSimBp).toBe(7_000);
  });
  const strong = { haul: { pHash: H, embedding: [1, 2, 3] }, external: { pHash: H, embedding: [1, 2, 3] }, sameSeller: false } as const;
  it("the attribute check fails closed and caps conflicts (hard negatives: same style, other colour)", () => {
    expect(isMatch(scoreMatch({ ...strong, attributes: null }))).toBe(false);
    expect(scoreMatch({ ...strong, attributes: null }).cap).toBe("attributes_unavailable");
    expect(scoreMatch({ ...strong, attributes: { ...ALL_MATCH, colour: "conflict" } })).toMatchObject({ confBp: 3_000, cap: "attribute_conflict" });
    expect(scoreMatch({ ...strong, attributes: { ...ALL_MATCH, sizeRun: "disjoint" } }).confBp).toBe(4_000);
    expect(isMatch(scoreMatch({ ...strong, attributes: { ...ALL_MATCH, colour: "unknown" } }))).toBe(false);
  });
  it("confidence is always within 0..10000 and never reaches tau with a conflict (property)", () => {
    const vec = fc.array(fc.double({ min: -5, max: 5, noNaN: true }), { minLength: 3, maxLength: 3 });
    const hash = fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }).map((n) => n.toString(16).padStart(16, "0"));
    fc.assert(
      fc.property(vec, vec, hash, hash, fc.constantFrom("match", "conflict", "unknown"), (ea, eb, ha, hb, colour) => {
        const m = scoreMatch({
          haul: { embedding: ea, pHash: ha },
          external: { embedding: eb, pHash: hb },
          sameSeller: false,
          attributes: { brand: "match", colour, material: "match", sizeRun: "overlap" },
        });
        expect(m.confBp).toBeGreaterThanOrEqual(0);
        expect(m.confBp).toBeLessThanOrEqual(10_000);
        if (colour === "conflict") expect(m.confBp).toBeLessThan(DEFAULT_TAU_BP);
      }),
    );
  });
  it("applies a calibration map before the cap", () => {
    const m = scoreMatch({ ...strong, attributes: ALL_MATCH, calibrate: () => 6_000 });
    expect(m.confBp).toBe(6_000);
  });
});

describe("calibration and tau selection", () => {
  it("isotonic fit is monotone non-decreasing (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ rawBp: fc.integer({ min: 0, max: 10_000 }), same: fc.boolean() }), { minLength: 1, maxLength: 80 }), (s) => {
        const m = fitIsotonic(s);
        for (let i = 1; i < m.ys.length; i += 1) expect(m.ys[i] ?? 0).toBeGreaterThanOrEqual(m.ys[i - 1] ?? 0);
        let prev = -1;
        for (let x = 0; x <= 10_000; x += 500) {
          const y = applyIsotonic(m, x);
          expect(y).toBeGreaterThanOrEqual(prev);
          prev = y;
        }
      }),
    );
  });
  it("chooses the lowest tau reaching 98% precision on a synthetic labelled split and reports recall", () => {
    const set: { confBp: number; same: boolean }[] = [];
    for (let i = 0; i < 1_000; i += 1) set.push({ confBp: 9_300 + (i % 700), same: true }); // positives high
    for (let i = 0; i < 1_000; i += 1) set.push({ confBp: 2_000 + (i % 6_000), same: false }); // negatives low
    set.push({ confBp: 9_250, same: false }); // one hard negative just below the positives
    const t = chooseTau(set);
    expect(t.ok).toBe(true);
    if (t.ok) {
      expect(t.validation.precisionBp).toBeGreaterThanOrEqual(9_800);
      expect(t.validation.recallBp).toBeGreaterThan(9_000);
      expect(precisionRecall(set, t.tauBp).precisionBp).toBe(t.validation.precisionBp);
    }
    expect(chooseTau([{ confBp: 9_000, same: false }, { confBp: 9_500, same: false }]).ok).toBe(false);
    expect(chooseTau([])).toEqual({ ok: false, reason: "empty_validation_set" });
  });
  it("needs 2,000 pairs and kappa >= 0.8 before leaving shadow mode", () => {
    expect(labelledSetReady({ pairs: 1_999, kappaMilli: 900 })).toBe(false);
    expect(labelledSetReady({ pairs: 2_000, kappaMilli: 799 })).toBe(false);
    expect(labelledSetReady({ pairs: 2_000, kappaMilli: 800 })).toBe(true);
    expect(cohenKappaMilli([{ a: true, b: true }, { a: false, b: false }, { a: true, b: true }, { a: false, b: false }])).toBe(1_000);
    expect(cohenKappaMilli([{ a: true, b: false }, { a: false, b: true }])).toBe(0);
  });
});

describe("snapshots and evidence", () => {
  const T = 1_800_000_000_000;
  const snap = (i: number, ageDays: number, price: bigint, available = true, dom = "d"): PriceSnapshot => ({
    id: `s${i}`, fetchedAtMs: T - ageDays * MS_PER_DAY, priceAmount: price, available, domHash: dom,
  });
  it("dedupes unchanged fetches within a day but stores one row per new day", () => {
    const prev = snap(1, 0, 100n);
    expect(snapshotDelta(prev, { priceAmount: 100n, available: true, domHash: "d" })).toBe("unchanged");
    expect(snapshotDelta(prev, { priceAmount: 100n, available: true, domHash: "e" })).toBe("changed");
    expect(shouldStoreSnapshot(prev, T + MS_PER_HOUR, "unchanged")).toBe(false);
    expect(shouldStoreSnapshot(prev, T + MS_PER_HOUR, "changed")).toBe(true);
    expect(shouldStoreSnapshot(prev, T + MS_PER_DAY, "unchanged")).toBe(true);
    expect(shouldStoreSnapshot(null, T, "unchanged")).toBe(true);
  });
  it("derives the 30-day low, current price and observed time; out-of-stock is not a current offer", () => {
    const ev = deriveExternalEvidence([snap(1, 40, 50n), snap(2, 20, 900n), snap(3, 5, 700n), snap(4, 0, 800n)], T, "ext-1");
    expect(ev).toEqual({ id: "ext-1", lowPriceAmount: 700n, currentPriceAmount: 800n, historyDays: 30, observedAtMs: T });
    const oos = deriveExternalEvidence([snap(1, 1, 700n), snap(2, 0, 600n, false)], T, "x");
    expect(oos?.currentPriceAmount).toBeNull();
    expect(oos?.lowPriceAmount).toBe(600n);
    expect(deriveExternalEvidence([], T, "x")).toBeNull();
  });
  it("evidence goes stale after 72 h", () => {
    expect(isEvidenceStale(T - 72 * MS_PER_HOUR, T)).toBe(false);
    expect(isEvidenceStale(T - 72 * MS_PER_HOUR - 1, T)).toBe(true);
  });
  it("shadow gate: nothing is live until the flag is off; below tau is rejected", () => {
    expect(gateEvidence({ confBp: 9_500, tauBp: 9_200, shadowOnly: true })).toBe("shadow");
    expect(gateEvidence({ confBp: 9_500, tauBp: 9_200, shadowOnly: false })).toBe("live");
    expect(gateEvidence({ confBp: 9_199, tauBp: 9_200, shadowOnly: false })).toBe("rejected");
  });
});
