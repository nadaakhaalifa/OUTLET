import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgingBars, BarH, IntervalPlot, StackedBar } from "./index";

const f = (n: number): string => `#${n}`;
const all = (): string[] => [
  html(<BarH label="Top" rows={[{ label: "A", value: 5 }, { label: "B", value: null }]} format={f} notLoadedText="not loaded" />),
  html(<StackedBar label="States" segments={[{ label: "x", value: 2 }, { label: "y", value: 1 }]} format={f} formatShare={(n) => `${Math.round(n * 100)}%`} />),
  html(<AgingBars label="Aging" buckets={[{ label: "<1d", count: 2 }, { label: ">3d", count: 3 }]} format={f} referenceBoundary={1} referenceLabel="limit" />),
  html(<IntervalPlot label="Forecast" rows={[{ label: "S", interval: { p10: 1, p50: 2, p90: 4 } }, { label: "T", interval: null }]} format={f} unavailableText="too little history" />),
];

describe("Phase B charts", () => {
  it("never emit a style attribute and are keyboard-focusable named images", () => {
    for (const m of all()) {
      expect(m).not.toMatch(/\sstyle=/);
      expect(m).toContain('role="img"');
      expect(m).toContain('tabindex="0"');
      expect(m).toContain("aria-labelledby");
    }
  });
  it("direct labels and formatted values come from props", () => {
    const [a, s, g, i] = all();
    expect(a).toContain(">#5<");
    expect(a).toContain("not loaded");
    expect(s).toContain("x: #2 (67%)");
    expect(g).toContain(">limit<");
    expect(g).toContain('class="uw-ch-late"');
    expect(i).toContain("#1 / #2 / #4");
    expect(i).toContain("too little history");
  });
  it("stacked segments differ by pattern, not only colour", () => {
    expect(all()[1]).toMatch(/fill="url\(#uwc\w+-p1\)"/);
  });
  it("description is wired through aria-describedby", () => {
    const m = html(<BarH label="L" description="Largest is A." rows={[{ label: "A", value: 1 }]} format={f} />);
    expect(m).toContain("aria-describedby");
    expect(m).toContain("Largest is A.");
  });
  it("empty, no_data_yet and not_configured draw text only, no numbers or svg", () => {
    for (const state of ["empty", "no_data_yet", "not_configured"] as const) {
      const m = html(<AgingBars label="x" buckets={[{ label: "a", count: 9 }]} format={f} state={state} stateText="Nothing yet" />);
      expect(m).toContain("Nothing yet");
      expect(m).not.toContain("<svg");
      expect(m).not.toContain("#9");
    }
  });
  it("stale draws the chart greyed with the stale text", () => {
    const m = html(<StackedBar label="x" segments={[{ label: "a", value: 1 }]} format={f} state="stale" stateText="Last updated 3h ago" />);
    expect(m).toContain("uw-ch-stale");
    expect(m).toContain("Last updated 3h ago");
    expect(m).toContain("<svg");
  });
  it("mirror flips text anchors for RTL", () => {
    const m = html(<BarH label="L" mirror rows={[{ label: "A", value: 1 }]} format={f} />);
    expect(m).toContain('text-anchor="end"');
  });
  it("is deterministic and survives empty and constant data", () => {
    expect(all()).toEqual(all());
    const m = html(<AgingBars label="x" buckets={[]} format={f} />) + html(<IntervalPlot label="x" rows={[]} format={f} />) + html(<BarH label="x" rows={[{ label: "a", value: 0 }]} format={f} />);
    expect(m).not.toMatch(/NaN|Infinity/);
  });
});
