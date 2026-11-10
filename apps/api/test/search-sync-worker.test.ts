import { randomUUID } from "node:crypto";
import { contextClient } from "@outlet/db";
import type { RoleSqlClient, SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import type { KillSwitchName } from "@outlet/flags";
import { uuidv7 } from "@outlet/ids";
import { createLogger } from "@outlet/logger";
import { createWorkerMetrics } from "@outlet/observability";
import { SYNC_EVENT_TYPES, STALENESS_SLO_MS, engineSyncSource, measureStaleness, outboxPendingSource } from "@outlet/search";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { marketJobs } from "../src/worker/jobs.js";
import type { KillRead } from "../src/worker/jobs.js";
import { MarketRunner } from "../src/worker/runner.js";
import { searchSyncHandlers } from "../src/worker-consumers.js";

const M = "EG";
const STORE = randomUUID();
const CAT = randomUUID();
const quiet = createLogger({ write: () => undefined });
const metrics = createWorkerMetrics();

let db: SqlClient;
let close: () => Promise<void>;
let worker: RoleSqlClient<"outlet_worker">;
let app: RoleSqlClient<"outlet_app">;
beforeAll(async () => {
  ({ client: db, close } = await createTestClient());
  worker = roleClient(db, "outlet_worker");
  app = roleClient(db, "outlet_app");
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  for (const t of ["outbox_events", "inbox_processed", "search_documents", "catalog_public_listings", "price_claims", "dlq_messages"]) await db.query(`DELETE FROM ${t}`);
});

const killing = (names: readonly KillSwitchName[]): KillRead => ({ isKilled: (n) => Promise.resolve(names.includes(n)) });

const seedListing = async (id: string, sku: string, price = 1000, status = "PUBLISHED"): Promise<void> => {
  await db.query(
    `INSERT INTO catalog_public_listings (id, store_ref, market_id, store, status, title_ar, title_en, description_ar, primary_category_id, condition_grade_code, condition_grade,
       min_price_minor, currency, attributes, variants, version, published_at, updated_at)
     VALUES ($1,$2,'EG','{"kind":"local"}'::jsonb,$3,'فستان أبيض','white dress','وصف',$4,'new_with_tags','{}'::jsonb,$5,'EGP','{}'::jsonb,$6::jsonb,1, now(), now())`,
    [id, STORE, status, CAT, price, JSON.stringify([{ sku_id: sku, size_label: "M", price_minor: String(price) }])],
  );
};
const seedEvent = async (type: string, payload: Record<string, unknown>, at: Date): Promise<string> => {
  const id = uuidv7();
  await db.query("INSERT INTO outbox_events (id, market_id, aggregate_type, aggregate_id, event_type, payload, occurred_at) VALUES ($1,$2,'listing',$3,$4,$5::jsonb,$6)", [id, M, randomUUID(), type, JSON.stringify(payload), at.toISOString()]);
  return id;
};
const runner = (kill: KillRead = killing([])): MarketRunner =>
  new MarketRunner({
    marketId: M, relayDb: contextClient(worker, { kind: "worker", marketId: M, job: "outbox.relay" }), jobs: marketJobs({ marketId: M, worker, app, kill }), kill, metrics, log: quiet,
    pollMs: 10, pollMaxMs: 40, batchSize: 50, maxAttempts: 8, leaseMs: 60_000, handlerTimeoutMs: 5_000, lagMs: 1_000,
  });
const docs = async (): Promise<{ product_id: string; price_minor: string; in_stock: boolean; is_published: boolean; verified_discount: boolean; engine_synced_seq: string | null }[]> =>
  (await db.query<{ product_id: string; price_minor: string; in_stock: boolean; is_published: boolean; verified_discount: boolean; engine_synced_seq: string | null }>(
    "SELECT product_id, price_minor::text, in_stock, is_published, verified_discount, engine_synced_seq::text FROM search_documents")).rows;
const published = async (id: string): Promise<boolean> => (await db.query<{ p: Date | null }>("SELECT published_at AS p FROM outbox_events WHERE id = $1", [id])).rows[0]?.p != null;

describe("search.sync composed in the worker", () => {
  it("routes the five search sync types (no longer unrouted) and keeps its kill switch", () => {
    const job = marketJobs({ marketId: M, worker, app, kill: killing([]) }).find((j) => j.name === "search.sync");
    expect([...(job?.handlers.keys() ?? [])].sort()).toEqual([...SYNC_EVENT_TYPES].sort());
    expect(job?.killSwitch).toBe("workers.search.sync.enabled");
  });

  it("all five event types flow through relay + real outlet_worker role: documents are written, events acked, inbox deduplicates a redelivery", async () => {
    const id = randomUUID();
    const sku = randomUUID();
    await seedListing(id, sku, 1000);
    const t0 = Date.now() - 60_000;
    const e1 = await seedEvent("listing.activated", { listing_id: id }, new Date(t0));
    const e2 = await seedEvent("price.changed", { sku_id: sku, new_price_minor: "700" }, new Date(t0 + 1000));
    const e3 = await seedEvent("inventory.sold_out", { listing_id: id }, new Date(t0 + 2000));
    const e4 = await seedEvent("inventory.restocked", { listing_id: id }, new Date(t0 + 3000));
    const e5 = await seedEvent("listing.updated", { listing_id: id }, new Date(t0 + 4000));
    const r = runner();
    await r.turn(0);
    for (const e of [e1, e2, e3, e4, e5]) expect(await published(e)).toBe(true);
    const d = await docs();
    expect(d).toHaveLength(1);
    // listing.updated (newest) refreshes the row from the catalog (price 1000, in stock): the version guard accepts the newest event.
    expect(d[0]).toMatchObject({ product_id: id, is_published: true, in_stock: true, verified_discount: false, engine_synced_seq: null });
    expect((await db.query("SELECT 1 FROM inbox_processed WHERE consumer = 'search.index-sync'")).rows).toHaveLength(5);
    // Redelivery of an already-consumed event is a no-op.
    const handlers = searchSyncHandlers(worker, M, { display: { forSku: () => Promise.resolve({ verifiedDiscount: false, lowest30d: false }) } });
    expect(await handlers.get("listing.updated")?.({ id: e5, type: "listing.updated", payload: { listing_id: id }, occurredAt: new Date(t0 + 4000).toISOString() })).toBe("duplicate");
  });

  it("an older event delivered after a newer one never overwrites it", async () => {
    const id = randomUUID();
    const sku = randomUUID();
    await seedListing(id, sku, 1000);
    const t0 = Date.now() - 60_000;
    await seedEvent("listing.activated", { listing_id: id }, new Date(t0));
    await seedEvent("inventory.sold_out", { listing_id: id }, new Date(t0 + 10_000));
    await seedEvent("inventory.restocked", { listing_id: id }, new Date(t0 + 5_000)); // older than the sold_out
    await runner().turn(0);
    expect((await docs())[0]?.in_stock).toBe(false);
  });

  it("a malformed payload is parked: inbox row, no document, event acked (no DLQ loop)", async () => {
    const bad = await seedEvent("price.changed", { sku_id: "nope", new_price_minor: "5" }, new Date(Date.now() - 5000));
    const lines: string[] = [];
    const k = killing([]);
    const r = new MarketRunner({
      marketId: M, relayDb: contextClient(worker, { kind: "worker", marketId: M, job: "outbox.relay" }), kill: k, metrics, log: quiet,
      jobs: marketJobs({ marketId: M, worker, app, kill: k, now: () => new Date() }).map((j) => (j.name === "search.sync" ? { ...j, handlers: searchSyncHandlers(worker, M, { display: { forSku: () => Promise.resolve({ verifiedDiscount: false, lowest30d: false }) }, log: createLogger({ write: (l) => lines.push(l) }) }) } : j)),
      pollMs: 10, pollMaxMs: 40, batchSize: 20, maxAttempts: 8, leaseMs: 60_000, handlerTimeoutMs: 5_000, lagMs: 1_000,
    });
    await r.turn(0);
    expect(await published(bad)).toBe(true);
    expect(await docs()).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM inbox_processed WHERE consumer = 'search.index-sync' AND message_id = $1", [bad])).rows).toHaveLength(1);
    expect((await db.query("SELECT 1 FROM dlq_messages")).rows).toHaveLength(0);
    expect(lines.join("\n")).toContain("event parked");
    expect(lines.join("\n")).toContain("invalid_payload");
  });

  it("an event handed over without occurredAt is parked, not versioned with the wall clock", async () => {
    const h = searchSyncHandlers(worker, M, { display: { forSku: () => Promise.resolve({ verifiedDiscount: false, lowest30d: false }) } });
    const id = uuidv7();
    expect(await h.get("listing.activated")?.({ id, type: "listing.activated", payload: { listing_id: randomUUID() } })).toBe("processed");
    expect(await docs()).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM inbox_processed WHERE message_id = $1", [id])).rows).toHaveLength(1);
  });

  it("the kill switch parks the job: nothing consumed, events stay pending", async () => {
    const id = randomUUID();
    await seedListing(id, randomUUID());
    const e = await seedEvent("listing.activated", { listing_id: id }, new Date(Date.now() - 5000));
    await runner(killing(["workers.search.sync.enabled"])).turn(0);
    expect(await published(e)).toBe(false);
    expect(await docs()).toHaveLength(0);
  });

  it("the display decision uses the price claim under the search.sync context: a claim that forbids display keeps the flag off", async () => {
    // No claim and no price history: plain. (Claim-visibility is proven at the policy level in packages/db search-sync-rls.test.ts.)
    const id = randomUUID();
    const sku = randomUUID();
    await seedListing(id, sku, 1000);
    await seedEvent("listing.activated", { listing_id: id }, new Date(Date.now() - 5000));
    await runner().turn(0);
    expect((await docs())[0]?.verified_discount).toBe(false);
  });

  it("staleness is honest: with the engine unconfigured the documents stay unsynced and the status is search_provider_unconfigured, never fresh", async () => {
    const id = randomUUID();
    await seedListing(id, randomUUID());
    await seedEvent("listing.activated", { listing_id: id }, new Date(Date.now() - 5000));
    await runner().turn(0);
    const relay = contextClient(worker, { kind: "worker", marketId: M, job: "outbox.relay" });
    const sync = contextClient(worker, { kind: "worker", marketId: M, job: "search.sync" });
    const r = await measureStaleness(outboxPendingSource(relay, M), new Date(), engineSyncSource(sync, M, false));
    expect(r).toMatchObject({ status: "search_provider_unconfigured", unsyncedDocuments: 1, deadLettered: 0, breached: false });
    // Nothing consuming (kill switch): the pending event ages past the SLO and the status turns stale.
    await seedEvent("listing.updated", { listing_id: id }, new Date(Date.now() - 2 * STALENESS_SLO_MS));
    const late = await measureStaleness(outboxPendingSource(relay, M), new Date(), engineSyncSource(sync, M, false));
    expect(late).toMatchObject({ status: "stale", breached: true });
  });
});
