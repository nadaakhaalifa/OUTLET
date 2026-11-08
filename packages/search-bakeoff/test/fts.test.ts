import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresFtsAdapter, type PgLike } from "../src/adapters/postgres-fts.js";
import { generateFixtures } from "../src/fixtures.js";
import { runEngine, summaryTable, type BakeoffQuery } from "../src/harness.js";
import { createPgliteFts } from "../src/pglite.js";
import { bigintToNumber } from "../src/budget.js";
import { analyzeQuery } from "../src/query.js";
import { ndcgAtK, percentile, type Judgment } from "../src/relevance.js";
import type { SearchEnginePort } from "../src/port.js";

const docs = generateFixtures(1200);
let ctx: Awaited<ReturnType<typeof createPgliteFts>>;

beforeAll(async () => {
  ctx = await createPgliteFts();
  await ctx.adapter.index(docs);
});
afterAll(async () => ctx.close());

describe("PostgresFtsAdapter (PGlite)", () => {
  it("loads unaccent and pg_trgm and is healthy", async () => {
    expect(ctx.adapter.features).toEqual({ unaccent: true, trigram: true });
    expect(await ctx.adapter.health()).toBe(true);
  });
  it("finds the same products for the Arabic and English acceptance pair", async () => {
    const ar = analyzeQuery("فستان ابيض لينين تحت ١٥٠٠");
    const en = analyzeQuery("white linen dress under 1500");
    const f = { maxPriceMinor: bigintToNumber(ar.maxPriceMinor ?? 0n) };
    const a = await ctx.adapter.search(ar.engineQuery, f, 50);
    const b = await ctx.adapter.search(en.engineQuery, f, 50);
    expect(a.hits.map((h) => h.id)).toEqual(b.hits.map((h) => h.id));
    for (const h of a.hits) {
      const d = docs.find((x) => x.id === h.id);
      expect(d?.priceMinor).toBeLessThanOrEqual(150000);
      expect(d?.category).toBe("dress");
    }
  });
  it("applies category, brand and stock filters", async () => {
    const r = await ctx.adapter.search("dress", { category: "dress", brand: "zara", inStockOnly: true }, 20);
    for (const h of r.hits) {
      const d = docs.find((x) => x.id === h.id);
      expect([d?.brand, d?.inStock]).toEqual(["zara", true]);
    }
  });
  it("falls back to trigram matching for typos and returns nothing for gibberish or blanks", async () => {
    const typo = await ctx.adapter.search("dres", {}, 5);
    expect(typo.hits.length).toBeGreaterThan(0);
    expect((await ctx.adapter.search("qqqqzzzz", {})).hits).toEqual([]);
    expect((await ctx.adapter.search("   ", {})).hits).toEqual([]);
    expect((await ctx.adapter.search("1500", {})).hits).toEqual([]);
  });
  it("degrades without trigram and reports unhealthy on errors", async () => {
    const broken: PgLike = { exec: () => Promise.reject(new Error("x")), query: () => Promise.reject(new Error("down")) };
    const a = new PostgresFtsAdapter(broken);
    expect(await a.health()).toBe(false);
    await expect(a.index(docs)).rejects.toThrow();
    expect(a.features).toEqual({ unaccent: false, trigram: false });
  });
  it("works without extensions (plain simple config, exact matches only)", async () => {
    const calls: string[] = [];
    const stub: PgLike = {
      exec: (sql) => { calls.push(sql); return sql.includes("EXTENSION") ? Promise.reject(new Error("no ext")) : Promise.resolve(); },
      query: () => Promise.resolve({ rows: [] }),
    };
    const a = new PostgresFtsAdapter(stub);
    await a.index(docs.slice(0, 3));
    expect(calls.some((c) => c.includes("WITH unaccent"))).toBe(false);
    expect((await a.search("dress", {})).hits).toEqual([]);
  });
});

describe("harness", () => {
  const queries: BakeoffQuery[] = [
    { id: "a", text: "فستان ابيض", script: "ar", intent: "x", expected_normalized: "dress white", source: "synthetic" },
    { id: "b", text: "fostan abyad", script: "franco", intent: "x", expected_normalized: "dress white", source: "synthetic" },
    { id: "c", text: "whte dress", script: "en", intent: "x", expected_normalized: "dress white", tags: ["typo"], source: "synthetic" },
    { id: "d", text: "zzz", script: "en", intent: "x", expected_normalized: "", source: "synthetic" },
  ];
  const judgments: Judgment[] = ["a", "b", "c"].map((queryId) => ({ queryId, patterns: ["فستان|dress", "ابيض|white"], grade: 3, source: "synthetic" }));
  it("scores a real engine and renders the summary table", async () => {
    const run = await runEngine({ engine: ctx.adapter, docs, queries, judgments, date: "2026-11-08", passes: 2 });
    expect(run.queries).toBe(4);
    expect(run.judgedQueries).toBe(3);
    expect(run.recallAt10).toBeGreaterThan(0.6);
    expect(run.byScript.franco?.recallAt10).toBeGreaterThan(0.9);
    expect(run.typoHitRate).toBe(1);
    expect(run.zeroResultRate).toBeCloseTo(0.25, 2);
    expect(run.corpusSource).toBe("synthetic");
    expect(summaryTable([run])).toContain("| postgres-fts |");
  });
  it("handles an engine that returns nothing and unknown ids", async () => {
    let t = 0;
    const empty: SearchEnginePort = { name: "empty", index: () => Promise.resolve(), health: () => Promise.resolve(true), search: () => Promise.resolve({ hits: [{ id: "ghost", score: 1 }].slice(0, 0) }) };
    const ghost: SearchEnginePort = { ...empty, name: "ghost", search: () => Promise.resolve({ hits: [{ id: "ghost", score: 1 }] }) };
    const opts = { docs, queries, judgments, date: "d", passes: 1, now: () => (t += 1) };
    expect((await runEngine({ ...opts, engine: empty })).recallAt10).toBe(0);
    const g = await runEngine({ ...opts, engine: ghost });
    expect(g.zeroResultRate).toBe(0);
    expect(g.recallAt10).toBe(0);
  });
  it("metric helpers", () => {
    expect(ndcgAtK([true, false], 1)).toBe(1);
    expect(ndcgAtK([false], 0)).toBe(0);
    expect(percentile([], 95)).toBe(0);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
  });
});
