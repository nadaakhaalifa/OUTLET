import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { bulletGeometry, pathOf, sparklinePoints, waterfallGeometry } from "./geometry";

describe("sparklinePoints", () => {
  it("maps min to the bottom and max to the top within padding", () => {
    const p = sparklinePoints([0, 5, 10], 100, 20, { pad: 0 });
    expect(p.map((q) => q.y)).toEqual([20, 10, 0]);
    expect(p.map((q) => q.x)).toEqual([0, 50, 100]);
  });
  it("mirror puts the oldest point at the inline-end side", () => {
    const p = sparklinePoints([1, 2], 100, 20, { pad: 0, mirror: true });
    expect(p[0]?.x).toBe(100);
    expect(p[1]?.x).toBe(0);
  });
  it("shared domain keeps stacked sparklines comparable", () => {
    const a = sparklinePoints([5, 5], 10, 10, { domain: [0, 10], pad: 0 });
    const b = sparklinePoints([0, 10], 10, 10, { domain: [0, 10], pad: 0 });
    expect(a[0]?.y).toBe(5);
    expect(b[0]?.y).toBe(10);
  });
  it("handles empty, single and flat series", () => {
    expect(sparklinePoints([], 10, 10)).toEqual([]);
    expect(sparklinePoints([4], 10, 10)).toHaveLength(1);
    expect(sparklinePoints([3, 3, 3], 10, 10).every((q) => q.y === 5)).toBe(true);
    expect(pathOf([])).toBe("");
  });
  it("property: every point stays inside the viewbox", () => {
    fc.assert(fc.property(fc.array(fc.double({ min: -1e6, max: 1e6, noNaN: true }), { minLength: 1, maxLength: 50 }), (vs) => {
      for (const q of sparklinePoints(vs, 120, 32)) {
        expect(q.x).toBeGreaterThanOrEqual(0); expect(q.x).toBeLessThanOrEqual(120);
        expect(q.y).toBeGreaterThanOrEqual(0); expect(q.y).toBeLessThanOrEqual(32);
      }
    }));
  });
});

describe("bulletGeometry", () => {
  it("scales measure, bands and target to the width", () => {
    const g = bulletGeometry({ value: 50, target: 80, bands: [40, 70, 100] }, 200);
    expect(g.measure.width).toBe(100);
    expect(g.targetX).toBe(160);
    expect(g.bands.map((b) => b.width)).toEqual([80, 60, 60]);
  });
  it("omits the target tick when there is none and clamps overshoot", () => {
    const g = bulletGeometry({ value: 500, bands: [10], max: 100 }, 100);
    expect(g.targetX).toBeNull();
    expect(g.measure.width).toBe(100);
  });
});

describe("waterfallGeometry", () => {
  const steps = [
    { label: "Gross", value: 100, kind: "total" as const },
    { label: "Fees", value: -30, kind: "delta" as const },
    { label: "Refunds", value: -20, kind: "delta" as const },
    { label: "Net", value: 50, kind: "total" as const },
  ];
  it("floats deltas from the running level and ends at the net total", () => {
    const { bars } = waterfallGeometry(steps, 400, 100);
    expect(bars.map((b) => b.end)).toEqual([100, 70, 50, 50]);
    expect(bars.map((b) => b.kind)).toEqual(["total", "down", "down", "total"]);
    expect(bars[1]?.y).toBe(0);
  });
  it("mirror reverses the inline order only", () => {
    const a = waterfallGeometry(steps, 400, 100).bars;
    const b = waterfallGeometry(steps, 400, 100, { mirror: true }).bars;
    expect(b[0]?.x).toBe(a[3]?.x);
    expect(b[0]?.y).toBe(a[0]?.y);
  });
  it("property: bars stay inside the plot and have positive height", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: -1000, max: 1000 }), { minLength: 1, maxLength: 12 }), (vs) => {
      const s = vs.map((v, i) => ({ label: `s${i}`, value: v, kind: i === 0 ? ("total" as const) : ("delta" as const) }));
      for (const b of waterfallGeometry(s, 480, 160).bars) {
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.y + b.height).toBeLessThanOrEqual(161);
        expect(b.height).toBeGreaterThan(0);
      }
    }));
  });
});

import { agingGeometry, barHGeometry, intervalGeometry, stackedGeometry } from "./geometry";

const nums = fc.array(fc.double({ min: -1e6, max: 1e6, noNaN: true }), { maxLength: 12 });
const bad = (o: unknown): boolean => /NaN|Infinity/.test(JSON.stringify(o));

describe("barHGeometry", () => {
  it("scales from a zero baseline with the max at full width", () => {
    const { bars } = barHGeometry([{ label: "a", value: 10 }, { label: "b", value: 5 }], 100);
    expect(bars.map((b) => b.width)).toEqual([100, 50]);
    expect(bars.every((b) => b.x === 0)).toBe(true);
  });
  it("mirror grows from inline-end; null is missing not zero-length", () => {
    const { bars } = barHGeometry([{ label: "a", value: 4 }, { label: "b", value: null }], 100, { mirror: true });
    expect(bars[0]?.x).toBe(0);
    expect(bars[1]).toMatchObject({ missing: true, width: 0 });
  });
  it("property: finite, within plot, monotonic in value, deterministic", () => {
    fc.assert(fc.property(nums, (vs) => {
      const rows = vs.map((v, i) => ({ label: String(i), value: v }));
      const a = barHGeometry(rows, 200);
      expect(a).toEqual(barHGeometry(rows, 200));
      expect(bad(a)).toBe(false);
      for (const b of a.bars) expect(b.width).toBeLessThanOrEqual(200);
      for (const x of a.bars) for (const y of a.bars) if (x.value <= y.value) expect(x.width).toBeLessThanOrEqual(y.width);
    }));
  });
  it("handles empty", () => expect(barHGeometry([], 100)).toEqual({ bars: [], height: 0 }));
});

describe("stackedGeometry", () => {
  it("segments add up to the whole width and start at 0", () => {
    const { segments } = stackedGeometry([{ label: "a", value: 1 }, { label: "b", value: 2 }, { label: "c", value: 3 }], 100);
    expect(segments.reduce((s, x) => s + x.width, 0)).toBeCloseTo(100, 1);
    expect(segments[0]?.x).toBe(0);
  });
  it("zero or empty total gives zero widths, not NaN", () => {
    expect(stackedGeometry([{ label: "a", value: 0 }], 100).segments[0]).toMatchObject({ width: 0, share: 0 });
    expect(stackedGeometry([], 100).segments).toEqual([]);
  });
  it("property: total equals the whole, shares sum to 1, mirror symmetric", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 8 }), (vs) => {
      const segs = vs.map((v, i) => ({ label: String(i), value: v }));
      const f = stackedGeometry(segs, 300);
      const m = stackedGeometry(segs, 300, { mirror: true });
      const total = vs.reduce((a, b) => a + b, 0);
      expect(f.total).toBe(total);
      expect(bad(f)).toBe(false);
      if (total > 0) {
        expect(f.segments.reduce((s, x) => s + x.width, 0)).toBeCloseTo(300, 0);
        expect(f.segments.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 6);
      }
      f.segments.forEach((s, i) => { const t = m.segments[i]; expect(t?.width).toBe(s.width); expect((t?.x ?? 0) + s.x + s.width).toBeCloseTo(300, 1); });
    }));
  });
});

describe("agingGeometry", () => {
  const b = [{ label: "<1d", count: 3 }, { label: "1-3d", count: 1 }, { label: ">3d", count: 0 }];
  it("orders youngest first; mirror puts the youngest at the right", () => {
    const f = agingGeometry(b, 100, 50);
    const m = agingGeometry(b, 100, 50, { mirror: true });
    expect(f.columns[0]?.x).toBeLessThan(f.columns[2]?.x ?? 0);
    expect(m.columns[0]?.x).toBeGreaterThan(m.columns[2]?.x ?? 0);
  });
  it("reference boundary marks later buckets beyond and mirrors its x", () => {
    const f = agingGeometry(b, 100, 50, { referenceBoundary: 2 });
    const m = agingGeometry(b, 100, 50, { referenceBoundary: 2, mirror: true });
    expect(f.columns.map((c) => c.beyond)).toEqual([false, false, true]);
    expect((f.referenceX ?? 0) + (m.referenceX ?? 0)).toBeCloseTo(100, 1);
  });
  it("zero count draws no height; null is missing", () => {
    const g = agingGeometry([{ label: "a", count: 0 }, { label: "b", count: null }], 100, 50);
    expect(g.columns.map((c) => c.height)).toEqual([0, 0]);
    expect(g.columns[1]?.missing).toBe(true);
  });
  it("property: finite, heights within chart, deterministic", () => {
    fc.assert(fc.property(nums, fc.option(fc.integer({ min: -2, max: 20 }), { nil: undefined }), fc.boolean(), (vs, ref, mirror) => {
      const buckets = vs.map((v, i) => ({ label: String(i), count: v }));
      const o = { mirror, ...(ref === undefined ? {} : { referenceBoundary: ref }) };
      const g = agingGeometry(buckets, 240, 80, o);
      expect(g).toEqual(agingGeometry(buckets, 240, 80, o));
      expect(bad(g)).toBe(false);
      for (const c of g.columns) { expect(c.height).toBeLessThanOrEqual(80); expect(c.height).toBeGreaterThanOrEqual(0); }
    }));
  });
});

describe("intervalGeometry", () => {
  it("orders p10 < p50 < p90 on a shared scale and mirrors", () => {
    const rows = [{ label: "a", interval: { p10: 2, p50: 5, p90: 10 } }, { label: "b", interval: { p10: 0, p50: 1, p90: 5 } }];
    const f = intervalGeometry(rows, 100);
    const m = intervalGeometry(rows, 100, { mirror: true });
    expect(f.marks[0]).toMatchObject({ x10: 20, x50: 50, x90: 100 });
    expect(m.marks[0]?.x90).toBe(0);
    expect((f.marks[1]?.x90 ?? 0) + (m.marks[1]?.x90 ?? 0)).toBe(100);
  });
  it("rejects null and unordered intervals rather than sorting them", () => {
    const g = intervalGeometry([{ label: "n", interval: null }, { label: "bad", interval: { p10: 5, p50: 2, p90: 9 } }], 100);
    expect(g.marks.every((m) => m.unavailable)).toBe(true);
  });
  it("property: finite and ordered for any inputs", () => {
    const d = fc.double({ min: -10, max: 1e6, noNaN: true });
    const iv = fc.record({ p10: d, p50: d, p90: d });
    fc.assert(fc.property(fc.array(fc.option(iv, { nil: null }), { maxLength: 10 }), fc.boolean(), (ivs, mirror) => {
      const g = intervalGeometry(ivs.map((x, i) => ({ label: String(i), interval: x })), 200, { mirror });
      expect(bad(g)).toBe(false);
      for (const m of g.marks) if (!m.unavailable) {
        if (mirror) { expect(m.x10).toBeGreaterThanOrEqual(m.x50); expect(m.x50).toBeGreaterThanOrEqual(m.x90); }
        else { expect(m.x10).toBeLessThanOrEqual(m.x50); expect(m.x50).toBeLessThanOrEqual(m.x90); }
      }
    }));
  });
});
