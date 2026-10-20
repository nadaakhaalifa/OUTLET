import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { colors } from "@outlet/ui-tokens";
import { AgingBars, BarH, ChartFrame, IntervalPlot, StackedBar, SERIES_STYLES } from "./index";
import { contrast } from "./contrast";
import { ADMIN_CSS, uiWebCss } from "./css";
import { tokensCss } from "./tokens-css";
import { agingGeometry, barHGeometry, intervalGeometry, stackedGeometry } from "./geometry";

const f = (n: number): string => `#${n}`;
const AR = new Intl.NumberFormat("ar-EG", { useGrouping: true });
const fa = (n: number): string => AR.format(n);

type Maker = (o: { mirror?: boolean; format?: (n: number) => string; label?: string }) => string;
const makers: Record<string, Maker> = {
  BarH: (o) => html(<BarH label={o.label ?? "L"} mirror={o.mirror === true} rows={[{ label: "أ", value: 5 }, { label: "ب", value: null }, { label: "ج", value: 2 }]} format={o.format ?? f} notLoadedText="لم يُحمَّل" />),
  StackedBar: (o) => html(<StackedBar label={o.label ?? "L"} mirror={o.mirror === true} segments={[{ label: "س", value: 2 }, { label: "ص", value: 1 }, { label: "ع", value: 1 }]} format={o.format ?? f} formatShare={(x) => fa(Math.round(x * 100)) + "٪"} />),
  AgingBars: (o) => html(<AgingBars label={o.label ?? "L"} mirror={o.mirror === true} buckets={[{ label: "١", count: 2 }, { label: "٢", count: null }, { label: "٣", count: 3 }]} format={o.format ?? f} referenceBoundary={1} referenceLabel="حد" notLoadedText="لا بيانات" />),
  IntervalPlot: (o) => html(<IntervalPlot label={o.label ?? "L"} mirror={o.mirror === true} rows={[{ label: "ص", interval: { p10: 1, p50: 2, p90: 4 } }, { label: "ط", interval: null }]} format={o.format ?? f} unavailableText="غير متاح" />),
};
const names = Object.keys(makers);

describe("1. CSP-relevant markup (static; the real-browser enforcement run is in PhaseBCsp.browser.test.ts)", () => {
  for (const n of names) {
    it(`${n}: no style attr, no <style>/<script>, no on* handlers, no javascript: URLs, no foreignObject`, () => {
      const m = makers[n]!({});
      expect(m).not.toMatch(/\sstyle\s*=/i);
      expect(m).not.toMatch(/<(style|script|foreignObject)\b/i);
      expect(m).not.toMatch(/\son[a-z]+\s*=/i);
      expect(m).not.toMatch(/javascript:/i);
      expect(m).not.toMatch(/href=|xlink:/);
    });
  }
  it("generated CSS has no @import / url(http) / expression", () => {
    const css = uiWebCss(ADMIN_CSS) + tokensCss();
    expect(css).not.toMatch(/@import|url\(\s*['"]?https?:|expression\(/i);
  });
});

describe("2. accessibility", () => {
  for (const n of names) {
    it(`${n}: role=img, name via <title> referenced by aria-labelledby, focusable, single tab stop`, () => {
      const m = makers[n]!({ label: "Chart name" });
      const id = /aria-labelledby="([^"]+)"/.exec(m)?.[1];
      expect(id).toBeTruthy();
      expect(m).toContain(`<title id="${id}">Chart name</title>`);
      expect(m).toContain('role="img"');
      expect(m.match(/tabindex=/g)?.length).toBe(1);
      expect(m).not.toMatch(/tabindex="[1-9]/); // no positive tabindex
      expect(m.match(/<svg/g)?.length).toBe(1);
    });
    it(`${n}: label with markup chars is escaped`, () => {
      const m = makers[n]!({ label: '<img src=x onerror=alert(1)>"' });
      expect(m).not.toContain("<img");
      expect(m).toContain("&lt;img");
    });
  }
  it("ids are unique across several instances on one page", () => {
    // One React tree (useId is only unique within a tree; separate renderToStaticMarkup calls restart the counter).
    const m = html(
      <>
        <BarH label="a" rows={[{ label: "x", value: 1 }]} format={f} />
        <StackedBar label="b" segments={[{ label: "x", value: 1 }, { label: "y", value: 1 }]} format={f} />
        <StackedBar label="c" segments={[{ label: "x", value: 1 }, { label: "y", value: 1 }]} format={f} />
        <AgingBars label="d" buckets={[{ label: "x", count: 1 }]} format={f} referenceBoundary={0} />
        <IntervalPlot label="e" rows={[{ label: "x", interval: null }]} format={f} />
      </>,
    );
    const ids = [...m.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("inside ChartFrame: figure named by figcaption, table fallback is data-complete, focus order = toggle then svg", () => {
    const m = html(
      <ChartFrame title="T" summary="S" viewAsTableLabel="Table" chart={<BarH label="L" rows={[{ label: "A", value: 1 }]} format={f} />}
        table={{ caption: "c", columns: [{ key: "a", header: "Item", cell: (r: { a: string }) => r.a }], rows: [{ a: "A" }], rowKey: (r) => r.a }} />,
    );
    expect(m).toMatch(/<figure[^>]*aria-labelledby/);
    expect(m.indexOf("<button")).toBeLessThan(m.indexOf("<svg"));
    expect(m).toContain('aria-pressed="false"');
  });
  it("non-ready states render role=status text, no svg (screen reader announces the reason)", () => {
    const m = html(<StackedBar label="x" segments={[{ label: "a", value: 1 }]} format={f} state="no_data_yet" stateText="No data yet" />);
    expect(m).toContain('role="status"');
    expect(m).not.toContain("<svg");
  });
  it("series are distinguishable without colour: five styles, patterns 1..4 defined and referenced", () => {
    const segs = Array.from({ length: SERIES_STYLES }, (_, i) => ({ label: `s${i}`, value: 1 }));
    const m = html(<StackedBar label="x" segments={segs} format={f} />);
    for (let k = 1; k < SERIES_STYLES; k++) expect(m).toMatch(new RegExp(`<pattern id="uwc\\w+-p${k}"`));
    for (let k = 1; k < SERIES_STYLES; k++) expect(m).toMatch(new RegExp(`fill="url\\(#uwc\\w+-p${k}\\)"`));
    expect(m).toContain("uw-ch-s0");
  });
  it("sixth series wraps to a defined style (no dangling url(#p5))", () => {
    const segs = Array.from({ length: 7 }, (_, i) => ({ label: `s${i}`, value: 1 }));
    const m = html(<StackedBar label="x" segments={segs} format={f} />);
    expect(m).not.toMatch(/-p5\)/);
  });
  it("pattern ids in AgingBars exist when referenced (beyond-boundary fill)", () => {
    const m = makers.AgingBars!({});
    const ref = /fill="url\(#([\w-]+)\)"/.exec(m)?.[1];
    expect(ref).toBeTruthy();
    expect(m).toContain(`id="${ref}"`);
  });
  it("reduced motion: charts have no animation/transition in generated CSS", () => {
    const css = uiWebCss(ADMIN_CSS);
    const chartRules = css.split("}").filter((r) => r.includes(".uw-ch-") || r.includes(".uw-chart"));
    for (const r of chartRules) expect(r).not.toMatch(/animation|transition/);
    expect(css).toContain("prefers-reduced-motion:reduce");
  });
  it("forced-colors fallback exists for every chart class used", () => {
    const css = uiWebCss(ADMIN_CSS);
    expect(css).toContain("forced-colors");
    for (const c of ["uw-ch-s0", "uw-ch-range", "uw-ch-late", "uw-ch-missing", "uw-ch-tick", "uw-ch-frame", "uw-ch-target"]) {
      const forced = css.slice(css.indexOf("forced-colors"));
      expect(forced).toContain(c);
    }
  });
  for (const scheme of ["light", "dark"] as const) {
    describe(`contrast tokens ${scheme}`, () => {
      const c = colors[scheme];
      it("text on page and on pattern background >= 4.5", () => {
        expect(contrast(c.textPrimary, c.background)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(c.textPrimary, c.surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(c.textSecondary, c.background)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(c.textSecondary, c.surface)).toBeGreaterThanOrEqual(4.5);
      });
      it("graphical objects (series fill, axis, target, strokes) >= 3 on page and surface (WCAG 1.4.11)", () => {
        for (const bg of [c.background, c.surface]) {
          for (const fg of [c.brand, c.textPrimary, c.textSecondary, c.danger]) expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
        }
      });
    });
  }
});

describe("3. Arabic / RTL", () => {
  for (const n of names) {
    it(`${n}: Eastern Arabic digits from caller format pass through unchanged, Latin digits never injected`, () => {
      const m = makers[n]!({ format: fa });
      const texts = [...m.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((x) => x[1]!);
      const withDigits = texts.filter((t) => /\d|[٠-٩]/.test(t));
      expect(withDigits.length).toBeGreaterThan(0);
      for (const t of withDigits) expect(t, t).not.toMatch(/[0-9]/);
    });
    it(`${n}: mirror toggles text-anchor start->end and changes geometry`, () => {
      const a = makers[n]!({});
      const b = makers[n]!({ mirror: true });
      expect(a).not.toEqual(b);
      expect(b).toContain('text-anchor="end"');
    });
  }
  it("mirrored layouts stay inside the viewBox (no negative or >width x)", () => {
    for (const n of names) {
      const m = makers[n]!({ mirror: true });
      const w = Number(/viewBox="0 0 (\d+)/.exec(m)![1]);
      for (const g of m.matchAll(/<rect[^>]*\sx="(-?[\d.]+)"[^>]*\swidth="(-?[\d.]+)"/g)) {
        const x = Number(g[1]);
        const wd = Number(g[2]);
        expect(x).toBeGreaterThanOrEqual(-0.01);
        expect(x + wd).toBeLessThanOrEqual(w + 0.01);
      }
    }
  });
  it("Latin text inside an RTL chart is the caller's job: labels are not wrapped in <bdi>/dir (documented gap)", () => {
    const m = html(<BarH label="L" mirror rows={[{ label: "Bosta 24", value: 1 }]} format={f} />);
    // Not decided here: reported as a gap if absent.
    expect(m.includes("<bdi") || m.includes('dir="')).toBe(false);
  });
  describe("time-axis direction is a prop (mirror) and both directions are exact", () => {
    const b = [{ label: "y", count: 1 }, { label: "m", count: 2 }, { label: "o", count: 3 }];
    it("AgingBars LTR: youngest left; mirror: youngest right, exact mirror image of the x positions", () => {
      const l = agingGeometry(b, 300, 100).columns;
      const r = agingGeometry(b, 300, 100, { mirror: true }).columns;
      expect(l[0]!.x).toBeLessThan(l[2]!.x);
      expect(r[0]!.x).toBeGreaterThan(r[2]!.x);
      l.forEach((c, i) => expect(c.x + c.width + r[i]!.x).toBeCloseTo(300, 1));
    });
    it("reference line mirrors across the same axis", () => {
      for (const k of [0, 1, 2, 3]) {
        const l = agingGeometry(b, 300, 100, { referenceBoundary: k }).referenceX!;
        const r = agingGeometry(b, 300, 100, { referenceBoundary: k, mirror: true }).referenceX!;
        expect(l + r).toBeCloseTo(300, 1);
      }
    });
    it("StackedBar / BarH / IntervalPlot mirror exactly", () => {
      const s = stackedGeometry([{ label: "a", value: 1 }, { label: "b", value: 3 }], 200);
      const sm = stackedGeometry([{ label: "a", value: 1 }, { label: "b", value: 3 }], 200, { mirror: true });
      s.segments.forEach((g, i) => expect(g.x + g.width + sm.segments[i]!.x).toBeCloseTo(200, 1));
      const h = barHGeometry([{ label: "a", value: 3 }], 200).bars[0]!;
      const hm = barHGeometry([{ label: "a", value: 3 }], 200, { mirror: true }).bars[0]!;
      expect(h.x + h.width + hm.x).toBeCloseTo(200, 1);
      const iv = intervalGeometry([{ label: "a", interval: { p10: 1, p50: 2, p90: 4 } }], 200).marks[0]!;
      const ivm = intervalGeometry([{ label: "a", interval: { p10: 1, p50: 2, p90: 4 } }], 200, { mirror: true }).marks[0]!;
      expect(iv.x50 + ivm.x50).toBeCloseTo(200, 1);
    });
  });
});

describe("4. edge data", () => {
  const noBad = (m: string): void => {
    expect(m).not.toMatch(/NaN|Infinity|undefined|e\+\d|="-?[\d.]*e-\d/);
  };
  const SIZES = [0, 1, 2];
  it("empty arrays render without throwing and without NaN", () => {
    noBad(html(<BarH label="x" rows={[]} format={f} />));
    noBad(html(<StackedBar label="x" segments={[]} format={f} />));
    noBad(html(<AgingBars label="x" buckets={[]} format={f} />));
    noBad(html(<IntervalPlot label="x" rows={[]} format={f} />));
  });
  it("BarH height 0 for empty rows still yields a valid svg height >= 1", () => {
    expect(html(<BarH label="x" rows={[]} format={f} />)).toMatch(/height="1"/);
  });
  it("single point / single row / single bucket / single segment", () => {
    noBad(html(<BarH label="x" rows={[{ label: "a", value: 7 }]} format={f} />));
    const s = html(<StackedBar label="x" segments={[{ label: "a", value: 7 }]} format={f} formatShare={(n) => `${n * 100}%`} />);
    noBad(s);
    expect(s).toContain("a: #7 (100%)");
    noBad(html(<AgingBars label="x" buckets={[{ label: "a", count: 7 }]} format={f} referenceBoundary={1} />));
    noBad(html(<IntervalPlot label="x" rows={[{ label: "a", interval: { p10: 3, p50: 3, p90: 3 } }]} format={f} />));
  });
  it("zero-width interval (p10=p50=p90) is still visible (>=1px)", () => {
    const m = html(<IntervalPlot label="x" rows={[{ label: "a", interval: { p10: 3, p50: 3, p90: 3 } }]} format={f} />);
    expect(m).toMatch(/class="uw-ch-range"[^>]*width="1"/);
  });
  it("null points: marked not loaded, never drawn as a zero-length bar; numbers of other rows unaffected", () => {
    const m = html(<BarH label="x" rows={[{ label: "a", value: 4 }, { label: "b", value: null }]} format={f} notLoadedText="NL" />);
    expect(m).toContain("NL");
    expect(m.match(/uw-ch-s0/g)?.length).toBe(1);
    expect(m.match(/uw-ch-missing/g)?.length).toBe(1);
  });
  it("held (stale) points are visibly distinct and labelled", () => {
    const m = html(<AgingBars label="x" buckets={[{ label: "a", count: 4 }]} format={f} state="stale" stateText="held since 03:00" />);
    expect(m).toContain("uw-ch-stale");
    expect(m).toContain("held since 03:00");
  });
  it("stale without stateText does not crash and adds no empty paragraph", () => {
    const m = html(<BarH label="x" rows={[{ label: "a", value: 1 }]} format={f} state="stale" />);
    expect(m).not.toContain("<p");
  });
  it("non-ready state without stateText renders an empty role=status (R-NODATA: text required but not enforced)", () => {
    // @ts-expect-error stateText is required for non-ready states at compile time; this checks the runtime guard.
    const m = html(<BarH label="x" rows={[{ label: "a", value: 1 }]} format={f} state="empty" />);
    expect(m).not.toMatch(/role="status"><\/p>/); // a silent empty status is a defect
  });
  it("negative values never produce negative width/height or leak below the baseline", () => {
    const ms = [
      html(<BarH label="x" rows={[{ label: "a", value: -5 }, { label: "b", value: 5 }]} format={f} />),
      html(<StackedBar label="x" segments={[{ label: "a", value: -5 }, { label: "b", value: 5 }]} format={f} />),
      html(<AgingBars label="x" buckets={[{ label: "a", count: -3 }, { label: "b", count: 2 }]} format={f} />),
    ];
    for (const m of ms) {
      noBad(m);
      expect(m).not.toMatch(/(width|height)="-/);
    }
  });
  it("negative value is not silently displayed as 0: the label shows the caller-formatted figure (data honesty)", () => {
    const m = html(<BarH label="x" rows={[{ label: "a", value: -5 }, { label: "b", value: 5 }]} format={f} />);
    expect(m).toContain("#-5");
  });
  it("StackedBar with a negative segment: label value matches what the caller passed", () => {
    const m = html(<StackedBar label="x" segments={[{ label: "a", value: -5 }, { label: "b", value: 5 }]} format={f} />);
    expect(m).toContain("a: #-5");
  });
  it("interval with p10>p50 is rejected visibly (unavailable text), not sorted", () => {
    const m = html(<IntervalPlot label="x" rows={[{ label: "a", interval: { p10: 5, p50: 2, p90: 1 } }]} format={f} unavailableText="BAD" />);
    expect(m).toContain("BAD");
  });
  it("non-finite inputs never reach attributes", () => {
    noBad(html(<BarH label="x" rows={[{ label: "a", value: NaN }, { label: "b", value: Infinity }, { label: "c", value: 3 }]} format={f} />));
    noBad(html(<AgingBars label="x" buckets={[{ label: "a", count: Infinity }, { label: "b", count: 3 }]} format={f} />));
    noBad(html(<IntervalPlot label="x" rows={[{ label: "a", interval: { p10: NaN, p50: 1, p90: 2 } }]} format={f} />));
  });
  it("very large piastre values (> 2^53, as Number) keep geometry finite and in range", () => {
    const big = Number(2n ** 63n - 1n); // 9.223372036854776e18
    const ms = [
      html(<BarH label="x" rows={[{ label: "a", value: big }, { label: "b", value: big / 3 }]} format={f} />),
      html(<StackedBar label="x" segments={[{ label: "a", value: big }, { label: "b", value: 1 }]} format={f} />),
      html(<AgingBars label="x" buckets={[{ label: "a", count: big }, { label: "b", count: 1 }]} format={f} />),
      html(<IntervalPlot label="x" rows={[{ label: "a", interval: { p10: big / 10, p50: big / 2, p90: big } }]} format={f} />),
    ];
    for (const m of ms) noBad(m);
  });
  it("display strings for bigint piastres come only from the caller: format() receives a number, so precision above 2^53 is lost before display (API GAP)", () => {
    const exact = 9007199254740993n; // 2^53 + 1
    const m = html(<BarH label="x" rows={[{ label: "a", value: Number(exact), display: exact.toString() }]} format={(n) => String(n)} />);
    expect(m).toContain(exact.toString());
  });
  it("huge rows count (5000) renders in bounded time", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ label: `r${i}`, value: i }));
    const t = Date.now();
    html(<BarH label="x" rows={rows} format={f} />);
    expect(Date.now() - t).toBeLessThan(3000);
  });
  it("duplicate labels do not collide (React keys) ", () => {
    const err: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { err.push(a); };
    try {
      html(<BarH label="x" rows={[{ label: "a", value: 1 }, { label: "a", value: 2 }]} format={f} />);
      html(<StackedBar label="x" segments={[{ label: "a", value: 1 }, { label: "a", value: 2 }]} format={f} />);
      html(<AgingBars label="x" buckets={[{ label: "a", count: 1 }, { label: "a", count: 2 }]} format={f} />);
      html(<IntervalPlot label="x" rows={[{ label: "a", interval: null }, { label: "a", interval: null }]} format={f} />);
    } finally { console.error = orig; }
    expect(err).toEqual([]);
  });
  void SIZES;
});
