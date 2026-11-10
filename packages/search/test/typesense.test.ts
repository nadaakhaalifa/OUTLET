import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { brandClient } from "@outlet/db";
import type { SqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { createLogger } from "@outlet/logger";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BREAKER_OPEN_MS, SearchEngineCircuitOpenError, SearchSyncConsumer, TypesenseEngine, UnconfiguredSearchEngine, engineSyncSource, measureStaleness, outboxPendingSource, toTypesenseDocument } from "../src/index.js";
import type { EngineDocument } from "../src/index.js";
import { makeDb, seedListing } from "./helpers.js";

const KEY = "super-secret-key-123";
interface Seen { method: string; url: string; key: string | undefined; body: string }
let server: Server;
let url: string;
let seen: Seen[] = [];
let handler: (req: Seen, res: ServerResponse) => unknown = () => undefined;
let collectionExists = false;

const DOC: EngineDocument = {
  marketId: "eg", productId: uuidv7(), storeRef: "s1", categoryId: null, world: "local", titleAr: "فستان", titleEn: "Dress", searchText: "فستان dress", priceMinor: "70000", currency: "EGP",
  conditionGrade: "A", sizes: ["m"], verifiedDiscount: true, lowest30d: false, inStock: true, isPublished: true, seq: "1767225610000000",
};
const json = (res: ServerResponse, status: number, body: unknown): boolean => { res.writeHead(status, { "content-type": "application/json" }); res.end(typeof body === "string" ? body : JSON.stringify(body)); return true; };

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const s: Seen = { method: req.method ?? "", url: req.url ?? "", key: req.headers["x-typesense-api-key"] as string | undefined, body: Buffer.concat(chunks).toString() };
      seen.push(s);
      handler(s, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); });
beforeEach(() => {
  seen = [];
  collectionExists = false;
  handler = (s, res) => {
    if (s.method === "GET" && s.url === "/collections/outlet_products") return collectionExists ? json(res, 200, { name: "outlet_products" }) : json(res, 404, { message: "Not Found" });
    if (s.method === "POST" && s.url === "/collections") { collectionExists = true; return json(res, 201, { name: "outlet_products" }); }
    if (s.url.includes("/documents/import")) return json(res, 200, s.body.split("\n").map(() => JSON.stringify({ success: true })).join("\n"));
    if (s.url === "/health") return json(res, 200, { ok: true });
    json(res, 404, {});
  };
});

describe("TypesenseEngine", () => {
  it("ensureCollection is idempotent and sends the key header", async () => {
    const e = new TypesenseEngine({ url, apiKey: KEY });
    await e.ensureCollection();
    await e.ensureCollection();
    await new TypesenseEngine({ url, apiKey: KEY }).ensureCollection();
    expect(seen.filter((s) => s.method === "POST" && s.url === "/collections")).toHaveLength(1);
    expect(seen.every((s) => s.key === KEY)).toBe(true);
    const schema = JSON.parse(seen.find((s) => s.method === "POST")?.body ?? "{}") as { fields: { name: string; type: string }[] };
    expect(schema.fields.find((f) => f.name === "price_minor")?.type).toBe("int64");
  });

  it("upserts as JSONL with action=upsert and the allow-listed shape", async () => {
    const e = new TypesenseEngine({ url, apiKey: KEY });
    const r = await e.upsertDocuments([DOC, { ...DOC, productId: uuidv7() }]);
    expect(r).toEqual({ succeeded: 2, failed: [] });
    const imp = seen.find((s) => s.url.includes("/import"));
    expect(imp?.url).toContain("action=upsert");
    const lines = (imp?.body ?? "").split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ id: `eg:${DOC.productId}`, price_minor: 70000, seq: 1767225610000000, in_stock: true, sizes: ["m"] });
    expect(JSON.parse(lines[0] ?? "")).not.toHaveProperty("category_id");
  });

  it("mapper drops fields outside the allow-list (no PII reaches the engine)", () => {
    const withPii = { ...DOC, phone: "+201000000000", email: "a@b.c", buyerName: "x" };
    const d = toTypesenseDocument(withPii);
    expect(Object.keys(d)).not.toContain("phone");
    expect(JSON.stringify(d)).not.toMatch(/201000000000|a@b\.c|buyerName/);
  });

  it("reports partial import failures per document and index() throws on a rejected one", async () => {
    handler = (s, res) => {
      if (s.method === "GET") return json(res, 200, { name: "outlet_products" });
      json(res, 200, `${JSON.stringify({ success: true })}\n${JSON.stringify({ success: false, error: "Field `seq` must be int64" })}`);
    };
    const e = new TypesenseEngine({ url, apiKey: KEY });
    const r = await e.upsertDocuments([DOC, { ...DOC, productId: "p2" }]);
    expect(r.succeeded).toBe(1);
    expect(r.failed).toEqual([{ id: "eg:p2", error: "Field `seq` must be int64" }]);
    handler = (s, res) => (s.method === "GET" ? json(res, 200, { name: "outlet_products" }) : json(res, 200, JSON.stringify({ success: false, error: "x" })));
    await expect(new TypesenseEngine({ url, apiKey: KEY }).index(DOC)).rejects.toThrow("import_rejected");
  });

  it("deletes by id filter and parses the count", async () => {
    handler = (s, res) => (s.method === "GET" ? json(res, 200, { name: "outlet_products" }) : json(res, 200, { num_deleted: 2 }));
    expect(await new TypesenseEngine({ url, apiKey: KEY }).deleteDocuments(["eg:a", "eg:b"])).toBe(2);
    expect(decodeURIComponent(seen.find((s) => s.method === "DELETE")?.url ?? "")).toContain("filter_by=id:[`eg:a`,`eg:b`]");
  });

  it("health is true on ok and false on any failure", async () => {
    expect(await new TypesenseEngine({ url, apiKey: KEY }).health()).toBe(true);
    handler = (_s, res) => json(res, 500, {});
    expect(await new TypesenseEngine({ url, apiKey: KEY }).health()).toBe(false);
  });

  it("opens the breaker after 5 consecutive 429/5xx, stops calling, and closes after 60 s", async () => {
    let t = 1_000;
    const lines: string[] = [];
    handler = (_s, res) => json(res, 503, {});
    const e = new TypesenseEngine({ url, apiKey: KEY, now: () => t, log: createLogger({ write: (l) => lines.push(l) }) });
    for (let i = 0; i < 5; i++) await expect(e.index(DOC)).rejects.toThrow("http_503");
    const calls = seen.length;
    await expect(e.index(DOC)).rejects.toBeInstanceOf(SearchEngineCircuitOpenError);
    expect(seen.length).toBe(calls);
    t += BREAKER_OPEN_MS + 1;
    handler = (_s, res) => json(res, 429, {});
    await expect(e.index(DOC)).rejects.toThrow("http_429");
    expect(seen.length).toBe(calls + 1);
    expect(lines.join("\n")).not.toContain(KEY);
  });

  it("times out a hanging server", async () => {
    handler = () => undefined;
    await expect(new TypesenseEngine({ url, apiKey: KEY, timeoutMs: 50 }).ensureCollection()).rejects.toThrow("timeout");
  });

  it("fails on bad JSON and on a wrong shape, never echoing key or body", async () => {
    handler = (_s, res) => json(res, 200, "<html>not json</html>");
    const lines: string[] = [];
    const e = new TypesenseEngine({ url, apiKey: KEY, log: createLogger({ write: (l) => lines.push(l) }) });
    await expect(e.ensureCollection()).rejects.toThrow("bad_json");
    handler = (_s, res) => json(res, 200, { name: 5 });
    await expect(new TypesenseEngine({ url, apiKey: KEY }).ensureCollection()).rejects.toThrow("bad_shape");
    handler = (_s, res) => json(res, 401, { message: "bad key" });
    const err = await new TypesenseEngine({ url, apiKey: KEY, log: createLogger({ write: (l) => lines.push(l) }) }).ensureCollection().then(() => new Error("no throw"), (x: unknown) => x as Error);
    expect(err.message).toBe("search_engine_error:http_401");
    expect([...lines, err.message, String(err.stack)].join("\n")).not.toContain(KEY);
  });
});

describe("engine mirror from SearchSyncConsumer", () => {
  let pg: PGlite;
  let client: SqlClient;
  beforeAll(async () => { ({ db: pg, client } = await makeDb()); });
  afterAll(async () => { await pg.close(); });
  const display = { forSku: () => Promise.resolve({ verifiedDiscount: false, lowest30d: false }) };
  const ev = (id: string, at: string) => ({ id: uuidv7(), type: "listing.activated", payload: { listing_id: id }, occurredAt: at });
  const staleness = async (configured: boolean) =>
    measureStaleness(outboxPendingSource(client, "eg"), new Date("2026-01-01T00:02:00Z"), engineSyncSource(client, "eg", configured));
  const quiet = () => createLogger({ write: () => undefined });

  it("is search_provider_unconfigured without an engine and fresh only after a real mirror", async () => {
    const id = uuidv7();
    await seedListing(client, { id, titleAr: "فستان", price: 1000, sku: uuidv7() });
    const plain = new SearchSyncConsumer(brandClient<"outlet_worker">(client), "eg", display, quiet(), { engine: new UnconfiguredSearchEngine() });
    await plain.handle(ev(id, "2026-01-01T00:00:10Z"));
    expect((await staleness(false)).status).toBe("search_provider_unconfigured");
    expect(await staleness(true)).toMatchObject({ status: "stale", unsyncedDocuments: 1 });
    const real = new SearchSyncConsumer(brandClient<"outlet_worker">(client), "eg", display, quiet(), { engine: new TypesenseEngine({ url, apiKey: KEY }) });
    await real.handle(ev(id, "2026-01-01T00:00:20Z"));
    expect(seen.some((s) => s.url.includes("/import"))).toBe(true);
    expect(await staleness(true)).toMatchObject({ status: "fresh", unsyncedDocuments: 0 });
  });

  it("parks mirror failures to staleness (document stays pending, handle still succeeds) and honours the kill switch", async () => {
    const id = uuidv7();
    await seedListing(client, { id, titleAr: "قميص", price: 500, sku: uuidv7() });
    handler = (_s, res) => json(res, 503, {});
    const lines: string[] = [];
    const c = new SearchSyncConsumer(brandClient<"outlet_worker">(client), "eg", display, createLogger({ write: (l) => lines.push(l) }), { engine: new TypesenseEngine({ url, apiKey: KEY }) });
    expect(await c.handle(ev(id, "2026-01-01T00:00:21Z"))).toBe("processed");
    expect((await staleness(true)).unsyncedDocuments).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("engine mirror");
    seen = [];
    const killed = new SearchSyncConsumer(brandClient<"outlet_worker">(client), "eg", display, quiet(), { engine: new TypesenseEngine({ url, apiKey: KEY }), engineKilled: () => Promise.resolve(true) });
    await killed.handle(ev(id, "2026-01-01T00:00:22Z"));
    expect(seen).toHaveLength(0);
  });
});
