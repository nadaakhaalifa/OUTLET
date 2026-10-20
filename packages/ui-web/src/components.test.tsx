import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { nextFocusTarget } from "./Dialog";
import { Badge, BulletChart, Card, ChartFrame, DataTable, KpiTile, Skeleton, Sparkline, Waterfall, sortRows } from "./index";

interface Row { id: string; name: string; rev: number }
const rows: Row[] = [{ id: "a", name: "Alpha", rev: 3 }, { id: "b", name: "Beta", rev: 10 }];
const cols = [
  { key: "name", header: "Store", cell: (r: Row) => r.name },
  { key: "rev", header: "Revenue", numeric: true, sortable: true, cell: (r: Row) => String(r.rev) },
];
const base = { caption: "Revenue by store", columns: cols, rows, rowKey: (r: Row) => r.id };

describe("no inline style attributes anywhere (admin CSP)", () => {
  it("renders every component without style=", () => {
    const out = [
      html(<Card title="T">x</Card>),
      html(<Badge tone="bad">Late</Badge>),
      html(<Skeleton width={50} label="Loading" />),
      html(<DataTable {...base} state="loading" loadingLabel="Loading" />),
      html(<KpiTile label="GMV" value="1" state="error" stateMessage="e" />),
      html(<Sparkline values={[1, 2, 3]} label="s" />),
      html(<BulletChart value={5} target={8} bands={[4, 7, 10]} label="b" valueText="5" />),
      html(<Waterfall steps={[{ label: "A", value: 10, kind: "total" }, { label: "B", value: -3, kind: "delta" }]} label="w" format={String} />),
      html(<ChartFrame title="t" summary="s" chart={<i />} table={base} viewAsTableLabel="Table" demoLabel="Demo" />),
    ].join("");
    expect(out).not.toMatch(/\sstyle=/);
  });
});

describe("DataTable", () => {
  it("has caption, scoped headers, numeric alignment class and aria-sort", () => {
    const m = html(<DataTable {...base} onSort={() => undefined} sort={{ key: "rev", dir: "desc" }} />);
    expect(m).toContain("<caption>Revenue by store</caption>");
    expect(m).toContain('scope="col"');
    expect(m).toContain('scope="row"');
    expect(m).toContain('class="uw-num"');
    expect(m).toContain('aria-sort="descending"');
  });
  it("marks unsorted sortable columns aria-sort=none and leaves others without", () => {
    const m = html(<DataTable {...base} onSort={() => undefined} />);
    expect(m.match(/aria-sort="none"/g)).toHaveLength(1);
  });
  it("renders explicit loading, empty and error states", () => {
    expect(html(<DataTable {...base} state="loading" loadingLabel="Loading" />)).toContain('aria-busy="true"');
    expect(html(<DataTable {...base} state="empty" emptyMessage="No orders in this window; widen the dates." />)).toContain("No orders in this window");
    const e = html(<DataTable {...base} state="error" errorMessage="Could not load" />);
    expect(e).toContain('role="alert"');
    expect(e).not.toContain("Alpha");
  });
  it("sortRows is stable, numeric-aware and does not mutate", () => {
    const input = [{ v: 10 }, { v: 2 }, { v: 2 }, { v: 7 }];
    expect(sortRows(input, (r) => r.v, "asc").map((r) => r.v)).toEqual([2, 2, 7, 10]);
    expect(sortRows(input, (r) => r.v, "desc").map((r) => r.v)).toEqual([10, 7, 2, 2]);
    expect(input.map((r) => r.v)).toEqual([10, 2, 2, 7]);
  });
});

describe("KpiTile", () => {
  const delta = { direction: "down" as const, text: "-3.0% vs previous 7 days", directionLabel: "Decrease", tone: "good" as const };
  it("shows delta as glyph plus words, definition, and as-of time", () => {
    const m = html(<KpiTile label="Return rate" value="4.1%" delta={delta} definition={{ summaryLabel: "Definition", text: "Returns / delivered" }} asOf={{ text: "As of 10:15", iso: "2026-10-16T10:15:00Z" }} />);
    expect(m).toContain("▼");
    expect(m).toContain("Decrease: ");
    expect(m).toContain("-3.0% vs previous 7 days");
    expect(m).toContain("Returns / delivered");
    expect(m).toContain('dateTime="2026-10-16T10:15:00Z"');
  });
  it("loading hides the value; error hides it unless keepLastValue; stale keeps it only when asked", () => {
    expect(html(<KpiTile label="L" value="99" state="loading" loadingLabel="Loading" />)).not.toContain("99");
    expect(html(<KpiTile label="L" value="99" state="error" stateMessage="Failed" />)).not.toContain("99");
    expect(html(<KpiTile label="L" value="99" state="error" stateMessage="Failed" keepLastValue />)).toContain("99");
    expect(html(<KpiTile label="L" value="99" state="stale" stateMessage="Old" />)).not.toContain("99");
    expect(html(<KpiTile label="L" value="99" state="stale" stateMessage="Old" keepLastValue />)).toContain("Old");
  });
  it("empty state says why", () => {
    expect(html(<KpiTile label="L" value="0" state="empty" stateMessage="Fewer than 50 orders: not shown." />)).toContain("Fewer than 50 orders");
  });
});

describe("Badge", () => {
  it("carries a glyph and text for every tone (not colour alone)", () => {
    for (const tone of ["neutral", "ok", "warn", "bad", "info"] as const) {
      const m = html(<Badge tone={tone}>Label</Badge>);
      expect(m).toContain('aria-hidden="true"');
      expect(m).toContain("Label");
    }
    const glyphs = new Set(["neutral", "ok", "warn", "bad", "info"].map((t) => /uw-badge-glyph" aria-hidden="true">(.)</.exec(html(<Badge tone={t as "ok"}>x</Badge>))?.[1]));
    expect(glyphs.size).toBe(5);
  });
});

describe("ChartFrame", () => {
  it("is a figure with figcaption summary, a toggle, and the same data as a table", () => {
    const m = html(<ChartFrame title="Revenue" summary="Rose from 3 to 10." chart={<svg />} table={base} viewAsTableLabel="View as table" />);
    expect(m).toContain("<figure");
    expect(m).toContain("<figcaption>");
    expect(m).toContain("Rose from 3 to 10.");
    expect(m).toContain("View as table");
    expect(m).toContain('aria-pressed="false"');
  });
  it("labels demo data visibly", () => {
    expect(html(<ChartFrame title="t" summary="s" chart={null} table={base} viewAsTableLabel="a" demoLabel="Demo data" />)).toContain("Demo data");
  });
});

describe("hand-written charts", () => {
  it("name themselves with role=img and a label", () => {
    expect(html(<Sparkline values={[1, 3, 2]} label="Trend" />)).toMatch(/role="img" aria-label="Trend"/);
    expect(html(<BulletChart value={5} target={8} bands={[4, 7, 10]} label="Fill" valueText="5" targetText="8" />)).toContain('aria-label="Fill: 5 / 8"');
  });
  it("waterfall prints value text on each bar and hatches decreases", () => {
    const m = html(<Waterfall steps={[{ label: "Gross", value: 100, kind: "total" }, { label: "Fees", value: -20, kind: "delta" }, { label: "Net", value: 80, kind: "total" }]} label="w" format={(n) => `E${n}`} />);
    expect(m).toContain(">E100<");
    expect(m).toContain(">E80<");
    expect(m).toContain("<pattern");
    expect(m).toMatch(/fill="url\(#/);
  });
});

describe("Dialog focus wrap", () => {
  const el = (n: string): HTMLElement => ({ n }) as unknown as HTMLElement;
  const [a, b, c] = [el("a"), el("b"), el("c")];
  it("wraps forward from last and backward from first, leaves the middle alone", () => {
    const active = (x: HTMLElement): Element => x as unknown as Element;
    expect(nextFocusTarget([a, b, c], active(c), false)).toBe(a);
    expect(nextFocusTarget([a, b, c], active(a), true)).toBe(c);
    expect(nextFocusTarget([a, b, c], active(b), false)).toBeNull();
    expect(nextFocusTarget([a, b, c], null, false)).toBe(a);
    expect(nextFocusTarget([], null, false)).toBeNull();
  });
});
