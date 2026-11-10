import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateFixtures } from "../src/fixtures.js";
import type { BakeoffQuery } from "../src/harness.js";
import { bigintToNumber } from "../src/budget.js";
import { analyzeQuery } from "../src/query.js";
import { isRelevant, type Judgment } from "../src/relevance.js";

const dir = new URL("../../../docs/search/", import.meta.url);
const jsonl = <T>(name: string): T[] =>
  readFileSync(new URL(name, dir), "utf8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as T);
const queries = jsonl<BakeoffQuery>("queries.v1.jsonl");
const judgments = jsonl<Judgment>("judgments.v1.jsonl");

describe("query corpus v1 (synthetic)", () => {
  it("has the ADR-0010 mix and every required field", () => {
    expect(queries).toHaveLength(500);
    expect(new Set(queries.map((q) => q.id)).size).toBe(500);
    expect(new Set(queries.map((q) => q.text)).size).toBe(500);
    for (const q of queries) {
      expect(q.source).toBe("synthetic");
      expect(["ar", "en", "franco", "mixed"]).toContain(q.script);
      expect(q.intent.length).toBeGreaterThan(0);
      expect(q.expected_normalized.length).toBeGreaterThan(0);
    }
    const count = (tag: string): number => queries.filter((q) => q.tags?.includes(tag) === true).length;
    expect(count("ar")).toBe(150);
    expect(count("en")).toBe(100);
    expect(count("franco")).toBe(100);
    expect(count("mixed")).toBe(50);
    expect(count("digits")).toBeGreaterThanOrEqual(30);
    expect(count("typo")).toBe(50);
    expect(queries.some((q) => /[٠-٩]/.test(q.text))).toBe(true);
    expect(queries.some((q) => /^[a-z0-9 ]*[a-z]*7[a-z]/.test(q.text))).toBe(true);
  });
  it("the shared pipeline reproduces expected_normalized and filters", () => {
    const wrong: string[] = [];
    for (const q of queries.filter((x) => x.tags?.includes("typo") !== true)) {
      const a = analyzeQuery(q.text);
      const price = a.maxPriceMinor === undefined ? undefined : bigintToNumber(a.maxPriceMinor);
      if (a.canonical !== q.expected_normalized || price !== q.expected_filters?.maxPriceMinor) wrong.push(q.text);
    }
    expect(wrong).toEqual([]);
    const typos = queries.filter((x) => x.tags?.includes("typo") === true);
    const ok = typos.filter((q) => analyzeQuery(q.text).canonical === q.expected_normalized).length;
    expect(ok / typos.length).toBeGreaterThanOrEqual(0.6);
  });
  it("has at least 60 judgments that reference real queries and match fixture docs", () => {
    expect(judgments.length).toBeGreaterThanOrEqual(60);
    const ids = new Set(queries.map((q) => q.id));
    const docs = generateFixtures(5000);
    let withHits = 0;
    for (const j of judgments) {
      expect(ids.has(j.queryId)).toBe(true);
      expect(j.patterns.length).toBeGreaterThan(0);
      if (docs.some((d) => isRelevant(d, j))) withHits += 1;
    }
    expect(withHits).toBeGreaterThanOrEqual(60);
  });
});

describe("fixtures", () => {
  it("are deterministic, at least 5k docs, bilingual", () => {
    const a = generateFixtures(5000);
    expect(a).toHaveLength(5000);
    expect(generateFixtures(5000)[4321]).toEqual(a[4321]);
    expect(new Set(a.map((d) => d.id)).size).toBe(5000);
    for (const d of a.slice(0, 50)) {
      expect(/\p{Script=Arabic}/u.test(d.titleAr)).toBe(true);
      expect(/[a-z]/.test(d.titleEn)).toBe(true);
      expect(Number.isInteger(d.priceMinor)).toBe(true);
    }
  });
});
