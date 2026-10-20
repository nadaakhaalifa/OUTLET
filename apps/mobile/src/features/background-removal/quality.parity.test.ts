import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assessQuality } from "./quality";

interface Case { name: string; stats: Record<string, number>; score: number; reasons: string[] }
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../../tooling/media/bg-benchmark/fixtures/quality-cases.json"), "utf8"),
) as { cases: Case[] };

describe("quality score parity with apps/api product-media domain", () => {
  it("has fixture cases", () => expect(fixture.cases.length).toBeGreaterThan(10));
  for (const c of fixture.cases) {
    it(c.name, () => {
      const s = c.stats;
      const a = assessQuality({
        coverage: s.coverage!, borderTouch: s.border_touch!, components: s.components!, holeRatio: s.hole_ratio!,
        softEdgeRatio: s.soft_edge_ratio!, subjectBrightRatio: s.subject_bright_ratio!, borderBrightRatio: s.border_bright_ratio!,
      });
      expect(a.score).toBe(c.score);
      expect([...a.reasons]).toEqual(c.reasons);
    });
  }
  it("matches the API source text of the scoring function", () => {
    const strip = (t: string): string => {
      const i = t.indexOf("export function assessQuality");
      const j = t.indexOf("export const isReady");
      return t.slice(i, j).replace(/\s+/g, " ").trim();
    };
    const api = readFileSync(resolve(__dirname, "../../../../api/src/modules/product-media/domain/quality.ts"), "utf8");
    const mob = readFileSync(resolve(__dirname, "./quality.ts"), "utf8");
    expect(strip(mob)).toBe(strip(api));
  });
});
