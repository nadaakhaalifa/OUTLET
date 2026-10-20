import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { ChartFrame, DataTable, KpiTile, Waterfall, sortRows } from "./index";
import { createDialogController, type DialogEl } from "./Dialog";
import { sortButtonName } from "./DataTable";
import { stepText } from "./charts";
import { bulletGeometry, sparklinePoints, waterfallGeometry } from "./geometry";

/** Minimal HTML nesting checker: reports a <p> that (implicitly) contains block content. */
function pNestingViolations(markup: string): string[] {
  const BLOCK = new Set(["div", "p", "details", "summary", "ul", "ol", "table", "section", "article", "figure", "h1", "h2", "h3", "form"]);
  const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "path", "circle", "rect", "line", "stop"]);
  const stack: string[] = [];
  const bad: string[] = [];
  for (const m of markup.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>/g)) {
    const [, close, rawName, , selfClose] = m;
    const name = (rawName ?? "").toLowerCase();
    if (close === "/") { const i = stack.lastIndexOf(name); if (i >= 0) stack.length = i; continue; }
    if (stack.includes("p") && BLOCK.has(name)) bad.push(`<${name}> inside <p>`);
    if (!VOID.has(name) && selfClose !== "/") stack.push(name);
  }
  return bad;
}

describe("H2 KpiTile markup nesting", () => {
  const tile = html(<KpiTile label="Orders" value="12" definition={{ summaryLabel: "What is this", text: "Paid orders." }} delta={{ direction: "up", text: "+1", directionLabel: "Increase" }} state="ready" asOf={{ text: "now", iso: "2026-01-01T00:00:00Z" }} />);
  it("the label wrapper is a div and no <p> contains block content", () => {
    expect(tile).toContain('<div class="uw-kpi-label">');
    expect(pNestingViolations(tile)).toEqual([]);
  });
  it("the checker catches the old invalid markup", () => {
    expect(pNestingViolations('<p class="uw-kpi-label"><details><p>x</p></details></p>').length).toBeGreaterThan(0);
  });
});

describe("M1 Waterfall prints the step value with sign", () => {
  const steps = [{ label: "Gross", value: 100, kind: "total" as const }, { label: "Fees", value: -20, kind: "delta" as const }, { label: "Adj", value: 5, kind: "delta" as const }, { label: "Net", value: 85, kind: "total" as const }];
  const m = html(<Waterfall steps={steps} label="w" format={String} />);
  it("shows -20 for a decrease, +5 for an increase and the plain total", () => {
    expect(m).toContain(">-20</text>");
    expect(m).toContain(">+5</text>");
    expect(m).toContain(">100</text>");
    expect(m).toContain(">85</text>");
    expect(m).not.toContain(">80</text>");
  });
  it("every bar has a text alternative (title)", () => {
    expect(m.match(/<title>/g)?.length).toBe(4);
    expect(m).toContain("<title>Fees: -20</title>");
  });
  it("sign is explicit even if the formatter drops it", () => {
    expect(stepText("down", -20, (n) => String(Math.abs(n)))).toBe("-20");
    expect(stepText("up", 5, String)).toBe("+5");
    expect(stepText("total", 100, String)).toBe("100");
    expect(stepText("up", 0, String)).toBe("0");
  });
  it("geometry exposes the step value", () => {
    expect(waterfallGeometry(steps, 400, 100).bars.map((b) => b.value)).toEqual([100, -20, 5, 85]);
  });
  it("L3 duplicate labels give unique keys (no React key warning)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    html(<Waterfall steps={[{ label: "A", value: 1, kind: "delta" }, { label: "A", value: 2, kind: "delta" }]} label="w" format={String} />);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("M2 ChartFrame toggle", () => {
  const table = { caption: "c", columns: [{ key: "a", header: "A", cell: (r: { a: string }) => r.a }], rows: [{ a: "x" }], rowKey: (r: { a: string }) => r.a };
  it("has a fixed label with aria-pressed (state is not also in the name)", () => {
    const m = html(<ChartFrame title="t" summary="s" chart={<svg />} table={table} viewAsTableLabel="View as table" />);
    expect(m).toContain('aria-pressed="false"');
    expect(m).toContain(">View as table</button>");
    expect(m).not.toContain("View chart");
  });
});

describe("L2 geometry hardening", () => {
  it("sparklinePoints drops NaN and Infinity", () => {
    const p = sparklinePoints([1, Number.NaN, 3, Infinity, -Infinity, 2], 100, 20);
    expect(p).toHaveLength(3);
    expect(p.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y))).toBe(true);
    expect(sparklinePoints([Number.NaN], 10, 10)).toEqual([]);
    expect(sparklinePoints([1, 2], 10, 10, { domain: [Number.NaN, 5] })).toHaveLength(2);
  });
  it("sparklinePoints survives a 200k-point series", () => {
    const big = Array.from({ length: 200_000 }, (_, i) => (i * 7919) % 1000);
    expect(sparklinePoints(big, 300, 40)).toHaveLength(200_000);
  });
  it("bullet bands are sorted and never negative, even unsorted or non-finite", () => {
    const g = bulletGeometry({ value: 50, bands: [100, 40, Number.NaN, 70], target: Infinity }, 200);
    expect(g.bands.every((b) => b.width >= 0 && Number.isFinite(b.x))).toBe(true);
    expect(g.bands.map((b) => b.width)).toEqual([80, 60, 60]);
    expect(Number.isFinite(g.measure.width)).toBe(true);
  });
  it("bulletGeometry({max:0}) has no NaN", () => {
    const g = bulletGeometry({ value: 5, bands: [1, 2, 3], max: 0 }, 100);
    expect(JSON.stringify(g)).not.toContain("null,");
    expect([g.measure.width, ...g.bands.flatMap((b) => [b.x, b.width])].every(Number.isFinite)).toBe(true);
  });
  it("property: bullet output is finite and non-negative for arbitrary doubles", () => {
    fc.assert(fc.property(fc.double(), fc.array(fc.double(), { maxLength: 6 }), fc.option(fc.double(), { nil: undefined }), (value, bands, max) => {
      const g = bulletGeometry({ value, bands, max }, 240);
      for (const b of g.bands) { expect(Number.isFinite(b.x)).toBe(true); expect(b.width).toBeGreaterThanOrEqual(0); }
      expect(Number.isFinite(g.measure.width)).toBe(true);
    }));
  });
  it("property: sparkline output is finite for arbitrary doubles incl. NaN/Infinity", () => {
    fc.assert(fc.property(fc.array(fc.double(), { maxLength: 40 }), (vs) => {
      for (const q of sparklinePoints(vs, 120, 32)) { expect(Number.isFinite(q.x)).toBe(true); expect(Number.isFinite(q.y)).toBe(true); }
    }));
  });
  it("waterfallGeometry handles a very large step list", () => {
    const steps = Array.from({ length: 150_000 }, (_, i) => ({ label: String(i), value: i % 2 === 0 ? 1 : -1, kind: "delta" as const }));
    expect(waterfallGeometry(steps, 1000, 100).bars).toHaveLength(150_000);
  });
});

describe("L3 DataTable", () => {
  const cols = [{ key: "n", header: "N", cell: (r: { n: string }) => r.n }];
  it("duplicate rowKey renders every row without a React key warning", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const m = html(<DataTable caption="c" columns={cols} rows={[{ n: "a" }, { n: "b" }, { n: "c" }]} rowKey={() => "same"} />);
    expect(m.match(/<tr>/g)?.length).toBe(4);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it("sortRows is a total order for NaN, Infinity and mixed types, and does not mutate", () => {
    const input = [3, Number.NaN, "b", -Infinity, 1, "a", Infinity, Number.NaN];
    const copy = [...input];
    const asc = sortRows(input, (v) => v, "asc");
    expect(input).toEqual(copy.map((v) => v) as never);
    expect(asc.slice(0, 4)).toEqual([-Infinity, 1, 3, Infinity]);
    expect(asc.slice(4, 6).every((v) => typeof v === "number" && Number.isNaN(v))).toBe(true);
    expect(asc.slice(6)).toEqual(["a", "b"]);
    const desc = sortRows(input, (v) => v, "desc");
    expect(desc.slice(0, 4)).toEqual([Infinity, 3, 1, -Infinity]);
    expect(desc.slice(6)).toEqual(["b", "a"]);
  });
  it("property: sortRows is deterministic and a permutation for arbitrary mixed values", () => {
    fc.assert(fc.property(fc.array(fc.oneof(fc.double(), fc.string())), (vs) => {
      const a = sortRows(vs, (v) => v, "asc");
      const b = sortRows([...vs].reverse().reverse(), (v) => v, "asc");
      expect(a).toHaveLength(vs.length);
      expect(a.map(String)).toEqual(b.map(String));
    }));
  });
  it("uses an explicit locale, default independent of the runtime", () => {
    expect(sortRows(["b", "a", "B", "A"], (v) => v, "asc")).toEqual(sortRows(["b", "a", "B", "A"], (v) => v, "asc", "en"));
    expect(sortRows(["z", "ä"], (v) => v, "asc", "sv")).toEqual(["z", "ä"]);
    expect(sortRows(["z", "ä"], (v) => v, "asc", "de")).toEqual(["ä", "z"]);
  });
});

describe("L5 DataTable sort semantics", () => {
  const rows = [{ n: "a" }];
  it("aria-sort only on columns that are sortable and wired", () => {
    const columns = [
      { key: "a", header: "Plain", cell: (r: { n: string }) => r.n },
      { key: "b", header: "Sortable", sortable: true, cell: (r: { n: string }) => r.n },
    ];
    const wired = html(<DataTable caption="c" columns={columns} rows={rows} rowKey={(r) => r.n} onSort={() => undefined} sort={{ key: "b", dir: "asc" }} />);
    expect(wired.match(/aria-sort/g)?.length).toBe(1);
    expect(wired).toContain('aria-sort="ascending"');
    const unwired = html(<DataTable caption="c" columns={columns} rows={rows} rowKey={(r) => r.n} />);
    expect(unwired).not.toContain("aria-sort");
  });
  it("accessible name keeps the visible header text (WCAG 2.5.3)", () => {
    expect(sortButtonName("Revenue", "Sort by Revenue")).toBe("Sort by Revenue");
    expect(sortButtonName("Revenue", "Order ascending")).toBe("Revenue, Order ascending");
    expect(sortButtonName("Revenue", undefined)).toBeUndefined();
    const m = html(<DataTable caption="c" columns={[{ key: "r", header: "Revenue", sortable: true, sortLabel: "Order ascending", cell: (r: { n: string }) => r.n }]} rows={rows} rowKey={(r) => r.n} onSort={() => undefined} />);
    expect(m).toContain('aria-label="Revenue, Order ascending"');
  });
});

/** Fake native dialog: close() queues the close event like the browser does. */
function fakeDialog() {
  const queue: (() => void)[] = [];
  let handler: () => void = () => undefined;
  const el: DialogEl & { shows: number } = {
    open: false, shows: 0,
    showModal() { el.open = true; el.shows += 1; },
    close() { if (!el.open) return; el.open = false; queue.push(() => handler()); },
  };
  return { el, bind: (h: () => void) => { handler = h; }, flush: () => { while (queue.length > 0) queue.shift()?.(); } };
}

describe("L4 Dialog close handling", () => {
  function setup(parentClosesOnClose: boolean) {
    const d = fakeDialog();
    const state = { open: true, closes: 0 };
    const deferred: (() => void)[] = [];
    const ctl = createDialogController(d.el, { getOpen: () => state.open, onClose: () => { state.closes += 1; if (parentClosesOnClose) state.open = false; }, defer: (f) => deferred.push(f) });
    d.bind(() => ctl.handleNativeClose());
    ctl.sync(true);
    return { d, state, ctl, flushDeferred: () => { while (deferred.length > 0) deferred.shift()?.(); } };
  }
  it("close button: onClose fires once, and the parent's follow-up sync does not fire it again", () => {
    const { d, state, ctl, flushDeferred } = setup(true);
    ctl.requestClose();
    d.flush();
    ctl.sync(state.open);
    d.flush();
    flushDeferred();
    expect(state.closes).toBe(1);
    expect(d.el.open).toBe(false);
  });
  it("Escape (native close event): onClose fires once", () => {
    const { d, state, ctl } = setup(true);
    d.el.open = false; // the browser closed it
    ctl.handleNativeClose();
    ctl.sync(state.open);
    d.flush();
    expect(state.closes).toBe(1);
  });
  it("a parent-driven close does not call onClose back", () => {
    const { d, state, ctl } = setup(true);
    state.open = false;
    ctl.sync(false);
    d.flush();
    expect(state.closes).toBe(0);
  });
  it("re-opens when the parent keeps open=true after a native close", () => {
    const { d, state, ctl, flushDeferred } = setup(false);
    d.el.open = false;
    ctl.handleNativeClose();
    flushDeferred();
    expect(state.closes).toBe(1);
    expect(d.el.open).toBe(true);
    expect(d.el.shows).toBe(2);
  });
  it("does not re-open when the parent closed it", () => {
    const { d, ctl, flushDeferred } = setup(true);
    d.el.open = false;
    ctl.handleNativeClose();
    flushDeferred();
    expect(d.el.open).toBe(false);
  });
});
