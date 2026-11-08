import { describe, expect, it } from "vitest";
import { MeilisearchAdapter, meiliFilter } from "../src/adapters/meilisearch.js";
import { OpenSearchAdapter, openSearchFilter } from "../src/adapters/opensearch.js";
import { TypesenseAdapter, typesenseFilter } from "../src/adapters/typesense.js";
import { HttpError, asArray, asRecord, requestJson } from "../src/adapters/http.js";
import { generateFixtures } from "../src/fixtures.js";
import type { FetchLike, SearchDoc } from "../src/port.js";

interface Call { method: string; url: string; body: string | undefined }

const fake = (respond: (c: Call) => { status?: number; body?: unknown }): { f: FetchLike; calls: Call[] } => {
  const calls: Call[] = [];
  const f: FetchLike = (url, init) => {
    const call: Call = { method: init?.method ?? "GET", url, body: init?.body };
    calls.push(call);
    const r = respond(call);
    const status = r.status ?? 200;
    const text = r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(text) });
  };
  return { f, calls };
};
const docs: SearchDoc[] = generateFixtures(3);
const filters = { maxPriceMinor: 150000, category: "dress", brand: "zara", inStockOnly: true };

describe("http helpers", () => {
  it("parses JSON, tolerates empty and invalid bodies, throws HttpError", async () => {
    expect(await requestJson(fake(() => ({ body: { a: 1 } })).f, "GET", "u", {})).toEqual({ a: 1 });
    expect(await requestJson(fake(() => ({})).f, "GET", "u", {})).toEqual({});
    expect(await requestJson(fake(() => ({ body: "not json" })).f, "POST", "u", {}, "x")).toEqual({});
    await expect(requestJson(fake(() => ({ status: 500, body: "boom" })).f, "GET", "u", {})).rejects.toBeInstanceOf(HttpError);
    expect(await requestJson(fake(() => ({ status: 404 })).f, "DELETE", "u", {}, undefined, [404])).toEqual({});
    expect(asRecord(3)).toEqual({});
    expect(asArray("x")).toEqual([]);
  });
});

describe("TypesenseAdapter", () => {
  it("builds filters, indexes via NDJSON import and maps hits", async () => {
    expect(typesenseFilter(filters)).toBe("price_minor:<=150000 && category:=dress && brand:=zara && in_stock:=true");
    expect(typesenseFilter({})).toBe("");
    const { f, calls } = fake((c) => (c.url.includes("/search?") ? { body: { hits: [{ document: { id: "p1" }, text_match: 7 }] } } : c.url.endsWith("/health") ? { body: { ok: true } } : {}));
    const a = new TypesenseAdapter({ fetch: f });
    expect(await a.health()).toBe(true);
    await a.index(docs);
    expect(calls.some((c) => c.url.includes("/documents/import") && (c.body ?? "").split("\n").length === 3)).toBe(true);
    const res = await a.search("dress", filters, 5);
    expect(res.hits).toEqual([{ id: "p1", score: 7 }]);
    expect(calls.at(-1)?.url).toContain("filter_by=");
    await a.search("dress", {});
    expect(calls.at(-1)?.url).not.toContain("filter_by");
  });
  it("reports unhealthy on failure and import errors", async () => {
    expect(await new TypesenseAdapter({ fetch: fake(() => ({ status: 503 })).f }).health()).toBe(false);
    const bad = fake((c) => (c.url.includes("/import") ? { status: 400 } : {}));
    await expect(new TypesenseAdapter({ fetch: bad.f }).index(docs)).rejects.toThrow("import failed");
  });
});

describe("MeilisearchAdapter", () => {
  it("builds filters, waits for tasks and maps hits", async () => {
    expect(meiliFilter(filters)).toBe('price_minor <= 150000 AND category = "dress" AND brand = "zara" AND in_stock = true');
    let polls = 0;
    const { f, calls } = fake((c) => {
      if (c.url.includes("/tasks/")) { polls += 1; return { body: { status: polls === 1 ? "processing" : "succeeded" } }; }
      if (c.url.endsWith("/search")) return { body: { hits: [{ id: "p2", _rankingScore: 0.9 }] } };
      if (c.url.endsWith("/health")) return { body: { status: "available" } };
      return { body: { taskUid: 1 } };
    });
    const a = new MeilisearchAdapter({ fetch: f, pollMs: 1, apiKey: "k" });
    expect(await a.health()).toBe(true);
    await a.index(docs);
    expect(polls).toBeGreaterThan(1);
    expect(await a.search("dress", filters)).toEqual({ hits: [{ id: "p2", score: 0.9 }] });
    await a.search("dress", {});
    expect(calls.at(-1)?.body).not.toContain("filter");
  });
  it("fails on a failed task and unhealthy server", async () => {
    const failing = fake((c) => (c.url.includes("/tasks/") ? { body: { status: "failed" } } : { body: { taskUid: 9 } }));
    await expect(new MeilisearchAdapter({ fetch: failing.f, pollMs: 1 }).index(docs)).rejects.toThrow("failed");
    expect(await new MeilisearchAdapter({ fetch: fake(() => ({ status: 500 })).f }).health()).toBe(false);
  });
  it("times out when tasks never finish", async () => {
    const stuck = fake((c) => (c.url.includes("/tasks/") ? { body: { status: "processing" } } : { body: { taskUid: 2 } }));
    await expect(new MeilisearchAdapter({ fetch: stuck.f, pollMs: 0 }).index(docs)).rejects.toThrow("timed out");
  });
});

describe("OpenSearchAdapter", () => {
  it("builds filters, bulk-indexes and maps hits", async () => {
    expect(openSearchFilter(filters)).toHaveLength(4);
    expect(openSearchFilter({})).toEqual([]);
    const { f, calls } = fake((c) => {
      if (c.url.endsWith("/_search")) return { body: { hits: { hits: [{ _id: "p3", _score: 2 }] } } };
      if (c.url.endsWith("/_cluster/health")) return { body: { status: "yellow" } };
      if (c.url.includes("/_bulk")) return { body: { errors: false } };
      return {};
    });
    const a = new OpenSearchAdapter({ fetch: f });
    expect(await a.health()).toBe(true);
    await a.index(docs);
    expect(calls.find((c) => c.url.includes("_bulk"))?.body?.endsWith("\n")).toBe(true);
    expect(await a.search("dress", filters)).toEqual({ hits: [{ id: "p3", score: 2 }] });
  });
  it("surfaces bulk errors and red clusters", async () => {
    const bad = fake((c) => (c.url.includes("_bulk") ? { body: { errors: true } } : {}));
    await expect(new OpenSearchAdapter({ fetch: bad.f }).index(docs)).rejects.toThrow("bulk");
    expect(await new OpenSearchAdapter({ fetch: fake(() => ({ body: { status: "red" } })).f }).health()).toBe(false);
  });
});

describe.skipIf(process.env.SEARCH_BAKEOFF_LIVE === undefined)("live engines (SEARCH_BAKEOFF_LIVE=1)", () => {
  it.each([
    ["typesense", () => new TypesenseAdapter()],
    ["meilisearch", () => new MeilisearchAdapter()],
    ["opensearch", () => new OpenSearchAdapter()],
  ] as const)("%s indexes and finds a doc", async (_n, make) => {
    const a = make();
    expect(await a.health()).toBe(true);
    const all = generateFixtures(200);
    await a.index(all);
    const target = all[0];
    const res = await a.search(target?.titleEn.split(" ").slice(0, 2).join(" ") ?? "", {});
    expect(res.hits.length).toBeGreaterThan(0);
  });
});
