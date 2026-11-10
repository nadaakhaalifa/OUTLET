import type { PGlite } from "@electric-sql/pglite";
import { brandClient } from "@outlet/db";
import type { SqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { createLogger } from "@outlet/logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SearchSyncConsumer, SYNC_EVENT_TYPES, SearchProviderUnconfiguredError, UnconfiguredSearchEngine, isValidSyncPayload, reconcileEngine } from "../src/index.js";
import type { EngineDocument, SearchEnginePort } from "../src/index.js";
import { makeDb, seedListing } from "./helpers.js";

let pg: PGlite;
let client: SqlClient;
let consumer: SearchSyncConsumer;
const lines: string[] = [];
let verified = false;
const T = (n: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const ev = (type: string, payload: Record<string, unknown>, at: string | undefined) => ({ id: uuidv7(), type, payload, ...(at === undefined ? {} : { occurredAt: at }) });
const doc = async (id: string) => (await client.query<{ price_minor: string; in_stock: boolean; is_published: boolean; verified_discount: boolean; engine_synced_seq: string | null; seq: string }>(
  "SELECT price_minor::text, in_stock, is_published, verified_discount, engine_synced_seq::text, seq::text FROM search_documents WHERE product_id = $1", [id])).rows[0];

beforeAll(async () => {
  ({ db: pg, client } = await makeDb());
  consumer = new SearchSyncConsumer(brandClient<"outlet_worker">(client), "eg", { forSku: () => Promise.resolve({ verifiedDiscount: verified, lowest30d: false }) }, createLogger({ write: (l) => lines.push(l) }));
});
afterAll(async () => {
  await pg.close();
});

describe("SearchSyncConsumer", () => {
  it("handles each of the five event types and is idempotent per event id", async () => {
    const id = uuidv7();
    const sku = uuidv7();
    await seedListing(client, { id, titleAr: "فستان", price: 1000, sku });
    const activated = ev("listing.activated", { listing_id: id }, T(10));
    expect(await consumer.handle(activated)).toBe("processed");
    expect((await doc(id))?.is_published).toBe(true);
    expect(await consumer.handle(activated)).toBe("duplicate");
    verified = true;
    expect(await consumer.handle(ev("price.changed", { sku_id: sku, new_price_minor: "700" }, T(20)))).toBe("processed");
    expect(await doc(id)).toMatchObject({ price_minor: "700", verified_discount: true });
    verified = false;
    expect(await consumer.handle(ev("inventory.sold_out", { listing_id: id }, T(30)))).toBe("processed");
    expect((await doc(id))?.in_stock).toBe(false);
    expect(await consumer.handle(ev("inventory.restocked", { listing_id: id }, T(40)))).toBe("processed");
    expect((await doc(id))?.in_stock).toBe(true);
    await seedListing(client, { id, titleAr: "فستان جديد", price: 900, sku, status: "PAUSED" });
    expect(await consumer.handle(ev("listing.updated", { listing_id: id }, T(50)))).toBe("processed");
    expect((await doc(id))).toMatchObject({ is_published: false });
  });

  it("parks a malformed payload, an unknown type and an event without occurredAt: inbox row, log, no document, no throw", async () => {
    const before = lines.length;
    const bad = [ev("price.changed", { sku_id: "nope", new_price_minor: "5" }, T(1)), ev("listing.activated", {}, T(1)), ev("order_group.placed", {}, T(1)), ev("listing.activated", { listing_id: uuidv7() }, undefined), ev("listing.activated", { listing_id: uuidv7() }, "not-a-date")];
    for (const e of bad) {
      expect(await consumer.handle(e)).toBe("processed");
      expect((await client.query("SELECT 1 FROM inbox_processed WHERE consumer = 'search.index-sync' AND message_id = $1", [e.id])).rows).toHaveLength(1);
      expect(await consumer.handle(e)).toBe("duplicate");
    }
    const logged = lines.slice(before).join("\n");
    for (const r of ["invalid_payload", "unknown_type", "missing_occurred_at"]) expect(logged).toContain(r);
    expect((await client.query("SELECT 1 FROM search_documents WHERE product_id IS NULL")).rows).toHaveLength(0);
  });

  it("isValidSyncPayload mirrors the per-type shapes", () => {
    expect(SYNC_EVENT_TYPES.every((t) => !isValidSyncPayload(t, {}))).toBe(true);
    expect(isValidSyncPayload("inventory.sold_out", { listing_id: uuidv7() })).toBe(true);
    expect(isValidSyncPayload("price.changed", { sku_id: uuidv7(), new_price_minor: "0" })).toBe(false);
    expect(isValidSyncPayload("other.type", { listing_id: uuidv7() })).toBe(false);
  });
});

describe("reconcileEngine", () => {
  const recording = (fail = false): { engine: SearchEnginePort; seen: EngineDocument[] } => {
    const seen: EngineDocument[] = [];
    return { seen, engine: { configured: true, index: (d) => (fail ? Promise.reject(new Error("down")) : (seen.push(d), Promise.resolve())) } };
  };
  it("an unconfigured engine sends nothing, marks nothing and reports every document pending", async () => {
    const n = Number((await client.query<{ n: string }>("SELECT count(*)::text AS n FROM search_documents")).rows[0]?.n);
    expect(n).toBeGreaterThan(0);
    expect(await reconcileEngine(client, "eg", new UnconfiguredSearchEngine())).toEqual({ indexed: 0, failed: 0, pending: n });
    expect((await client.query("SELECT 1 FROM search_documents WHERE engine_synced_seq IS NOT NULL")).rows).toHaveLength(0);
    await expect(new UnconfiguredSearchEngine().index()).rejects.toBeInstanceOf(SearchProviderUnconfiguredError);
  });
  it("a failing engine leaves documents pending; a working one marks the mirrored seq; a newer seq stays pending", async () => {
    const down = await reconcileEngine(client, "eg", recording(true).engine);
    expect(down).toMatchObject({ indexed: 0, failed: 1 });
    expect(down.pending).toBe(1);
    const ok = recording();
    expect(await reconcileEngine(client, "eg", ok.engine)).toEqual({ indexed: 1, failed: 0, pending: 0 });
    expect(ok.seen[0]).toMatchObject({ marketId: "eg", titleAr: expect.any(String) as string });
    const id = ok.seen[0]?.productId ?? "";
    expect((await doc(id))?.engine_synced_seq).toBe((await doc(id))?.seq);
    // A newer event makes the document pending again (seq moved ahead of the mirrored one).
    await consumer.handle(ev("inventory.sold_out", { listing_id: id }, T(99)));
    expect(await reconcileEngine(client, "eg", new UnconfiguredSearchEngine())).toMatchObject({ pending: 1 });
  });
});
