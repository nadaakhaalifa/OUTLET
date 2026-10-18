import { describe, expect, it } from "vitest";
import { CatalogIndexSource } from "../adapters/catalog-index-source";
import { InMemorySearchIndex } from "../adapters/in-memory";
import { SearchSyncConsumer } from "../application/sync";
import { StaleIndexSourceError, type SearchSyncOutcome } from "../domain/ports";
import { P, req } from "./index-contract";
import { BRAND, FakeSnapshots, listed, unlisted } from "./snapshot-fixtures";

const NOW = 1_800_000_000_000;

function setup() {
  const snaps = new FakeSnapshots();
  const index = new InMemorySearchIndex();
  const outcomes: { o: SearchSyncOutcome; lag: number | null }[] = [];
  const consumer = new SearchSyncConsumer({
    source: new CatalogIndexSource(snaps),
    writer: index,
    metrics: { record: (o, lag) => void outcomes.push({ o, lag }) },
    clock: { nowMs: () => NOW },
  });
  let n = 0;
  const msg = (type: string, productId: string, version: number, occurredAtMs = NOW - 2000) => ({
    messageId: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    type,
    payload: { name: type, productId, storeId: "x", version, status: "active" },
    occurredAtMs,
  });
  const ids = async (filter = {}): Promise<string[]> => (await index.search(req({ filter }))).hits.map((h) => h.productId).sort();
  return { snaps, index, consumer, outcomes, msg, ids };
}

describe("SearchSyncConsumer", () => {
  it("indexes an active product with its brand and the catalog price, and reports lag", async () => {
    const t = setup();
    t.snaps.set(listed(1));
    await t.consumer.handle(t.msg("product.created", P(1), 1));
    expect(await t.ids({ brandIds: [BRAND] })).toEqual([P(1)]);
    expect(await t.ids({ brandIds: ["00000000-0000-4000-d000-0000000000ff"] })).toEqual([]);
    expect(t.outcomes).toEqual([{ o: "indexed", lag: 2 }]);
  });

  it("a product without a brand is indexed with no brand and never matches a brand filter", async () => {
    const t = setup();
    t.snaps.set(listed(1, { brandId: null, brand: null }));
    await t.consumer.handle(t.msg("product.created", P(1), 1));
    expect(await t.ids()).toEqual([P(1)]);
    expect(await t.ids({ brandIds: [BRAND] })).toEqual([]);
  });

  it("removes the document when the product is no longer active (status change)", async () => {
    const t = setup();
    t.snaps.set(listed(1));
    await t.consumer.handle(t.msg("product.created", P(1), 1));
    t.snaps.set(unlisted(1, 2));
    await t.consumer.handle(t.msg("product.status_changed", P(1), 2));
    expect(await t.ids()).toEqual([]);
    expect(t.outcomes.map((x) => x.o)).toEqual(["indexed", "removed"]);
  });

  it("removes the document when the product vanished", async () => {
    const t = setup();
    t.snaps.set(listed(1));
    await t.consumer.handle(t.msg("product.created", P(1), 1));
    t.snaps.map.delete(P(1));
    await t.consumer.handle(t.msg("product.updated", P(1), 2));
    expect(await t.ids()).toEqual([]);
  });

  it("duplicate and replayed events converge to the same single document", async () => {
    const t = setup();
    t.snaps.set(listed(1, { version: 3 }));
    const m = t.msg("product.updated", P(1), 3);
    await t.consumer.handle(m);
    await t.consumer.handle(m);
    await t.consumer.handle(t.msg("product.updated", P(1), 3));
    expect(await t.ids()).toEqual([P(1)]);
  });

  it("out of order: a late old event re-reads the current state and cannot resurrect a delisted product", async () => {
    const t = setup();
    t.snaps.set(listed(1, { version: 1 }));
    t.snaps.set(unlisted(1, 3));
    // v3 (delist) arrives first, then the old v1 'created'
    await t.consumer.handle(t.msg("product.status_changed", P(1), 3));
    await t.consumer.handle(t.msg("product.created", P(1), 1));
    expect(await t.ids()).toEqual([]);
  });

  it("out of order the other way: an old event after a newer index write keeps the newest title", async () => {
    const t = setup();
    t.snaps.set(listed(1, { version: 5, title: { ar: "جديد" } }));
    await t.consumer.handle(t.msg("product.updated", P(1), 5));
    await t.consumer.handle(t.msg("product.updated", P(1), 2));
    const hit = await t.index.suggest("جديد", 5);
    expect(hit).toEqual(["جديد"]);
  });

  it("a catalog read older than the event is not written: it throws so the relay retries", async () => {
    const t = setup();
    t.snaps.set(listed(1, { version: 1 }));
    await expect(t.consumer.handle(t.msg("product.updated", P(1), 2))).rejects.toBeInstanceOf(StaleIndexSourceError);
    expect(await t.ids()).toEqual([]);
    expect(t.outcomes.map((x) => x.o)).toEqual(["stale_retry"]);
    t.snaps.set(listed(1, { version: 2 }));
    await t.consumer.handle(t.msg("product.updated", P(1), 2));
    expect(await t.ids()).toEqual([P(1)]);
  });

  it("an out-of-stock or vacationing listing is indexed as not in stock (excluded from results)", async () => {
    const t = setup();
    t.snaps.set(listed(1, { storeOpen: false }));
    t.snaps.set(listed(2, { skus: [{ ...listed(2).skus[0]!, available: false }] }));
    await t.consumer.handle(t.msg("product.updated", P(1), 1));
    await t.consumer.handle(t.msg("product.updated", P(2), 1));
    expect(await t.ids()).toEqual([]);
  });

  it("a product with no verified evidence is indexed with no discount; a verified block carries its percentage", async () => {
    const t = setup();
    t.snaps.set(listed(1));
    t.snaps.set(
      listed(2, {
        skus: [{ ...listed(2).skus[0]!, priceBlock: { badge: "verified_discount", referencePrice: { amount: 200_000n, currency: "EGP" }, discountPct: 25, claimId: "c" } }],
      }),
    );
    // a verified badge missing its reference is dropped to null
    t.snaps.set(listed(3, { skus: [{ ...listed(3).skus[0]!, priceBlock: { badge: "verified_discount", referencePrice: null, discountPct: 40, claimId: "c" } }] }));
    for (const n of [1, 2, 3]) await t.consumer.handle(t.msg("product.updated", P(n), 1));
    expect(await t.ids({ verifiedDiscountOnly: true })).toEqual([P(2)]);
  });

  it("ignores other event types and acknowledges malformed payloads without writing", async () => {
    const t = setup();
    t.snaps.set(listed(1));
    await t.consumer.handle({ messageId: "00000000-0000-4000-8000-000000000099", type: "order_group.paid", payload: {} });
    await t.consumer.handle({ messageId: "00000000-0000-4000-8000-000000000098", type: "product.updated", payload: { productId: "nope" } });
    expect(t.snaps.calls).toBe(0);
    expect(await t.ids()).toEqual([]);
    expect(t.outcomes.map((x) => x.o)).toEqual(["invalid"]);
  });

  it("concurrent events for one product are applied in arrival order", async () => {
    const t = setup();
    t.snaps.set(listed(1, { version: 1 }));
    const slow = new SearchSyncConsumer({
      source: {
        load: async (id) => {
          const before = t.snaps.map.get(id);
          await new Promise((r) => setTimeout(r, before !== undefined && before.version === 1 ? 20 : 0));
          return new CatalogIndexSource(t.snaps).load(id);
        },
      },
      writer: t.index,
      metrics: { record: () => undefined },
      clock: { nowMs: () => NOW },
    });
    const a = slow.handle(t.msg("product.updated", P(1), 1));
    t.snaps.set(unlisted(1, 2));
    const b = slow.handle(t.msg("product.status_changed", P(1), 2));
    await Promise.all([a, b]);
    expect(await t.ids()).toEqual([]);
  });
});
