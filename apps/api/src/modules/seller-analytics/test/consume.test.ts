import { describe, expect, it } from "vitest";
import { InMemoryAnalyticsStore, InMemoryEventSource, StaticProductStoreLookup } from "../adapters/in-memory";
import { RANGE, STORE_A, P1, U, ev, NOW } from "./repository-contract";
import { ConsumeSellerAnalytics } from "../application/consume";

const setup = () => {
  const source = new InMemoryEventSource();
  const store = new InMemoryAnalyticsStore();
  const lookup = new StaticProductStoreLookup();
  return { source, store, lookup, consumer: new ConsumeSellerAnalytics(source, store, lookup, { nowMs: () => NOW }) };
};
const envelope = (id: number, name: string, properties: Record<string, unknown>) => ({
  event_id: U(id),
  name,
  occurred_at: new Date(NOW - 1000).toISOString(),
  pseudonymous_id: "pseudonymous-id-001",
  origin: "client",
  purpose: "analytics",
  schema_version: 1,
  properties,
});

describe("ConsumeSellerAnalytics", () => {
  it("maps store-carrying analytics envelopes and is idempotent on redelivery", async () => {
    const { source, store, lookup, consumer } = setup();
    lookup.set(P1, STORE_A);
    const msgs = [
      envelope(1, "store_viewed", { store_id: STORE_A, world: "local", source: "feed" }),
      envelope(2, "product_viewed", { product_id: P1, store_id: STORE_A, source: "search" }),
      envelope(3, "add_to_bag", { product_id: P1, sku_id: U(30), store_id: STORE_A, quantity: 1, source: "pdp" }),
      envelope(4, "wishlist_added", { product_id: P1, intent: "want" }),
    ];
    source.push(...msgs.map((m) => ({ messageId: m.event_id, body: m })));
    expect(await consumer.run()).toMatchObject({ polled: 4, applied: 4, rejected: 0, ignored: 0 });
    source.push(...msgs.map((m) => ({ messageId: m.event_id, body: m })));
    expect(await consumer.run()).toMatchObject({ applied: 0, duplicates: 4 });
    const range = { fromMs: NOW - DAYMS, toMs: NOW + 1 };
    expect(await store.trafficTotals(STORE_A, range)).toMatchObject({ storeViews: 1, productViews: 1 });
    const f = await store.funnelByProduct(STORE_A, range);
    expect(f[0]?.counts).toMatchObject({ view: 1, bag: 1, save: 1 });
  });

  it("ignores envelopes without a store, drops a wishlist add for an unknown product, and counts poison", async () => {
    const { source, consumer } = setup();
    source.push(
      { messageId: U(1), body: envelope(1, "checkout_started", { bag_line_count: 1, store_count: 1, total_minor: "1" }) },
      { messageId: U(2), body: envelope(2, "wishlist_added", { product_id: U(77), intent: "need" }) },
      { messageId: U(3), body: { nonsense: true } },
      { messageId: U(4), body: "not an object" },
    );
    expect(await consumer.run()).toMatchObject({ polled: 4, applied: 0, ignored: 2, rejected: 2 });
    expect(source.acked).toHaveLength(4);
  });

  it("accepts domain events directly and does not ack when the store throws", async () => {
    const { source, store, consumer } = setup();
    const e = ev({ kind: "impression", productId: P1 }, { id: U(9) });
    source.push({ messageId: e.messageId, body: e });
    expect((await consumer.run()).applied).toBe(1);
    expect(RANGE.fromMs).toBeLessThan(RANGE.toMs);
    const failing = new ConsumeSellerAnalytics(
      source,
      { ...store, ingest: async () => { throw new Error("db down"); } } as unknown as InMemoryAnalyticsStore,
      new StaticProductStoreLookup(),
      { nowMs: () => NOW },
    );
    const e2 = ev({ kind: "impression", productId: P1 }, { id: U(10) });
    source.push({ messageId: e2.messageId, body: e2 });
    await expect(failing.run()).rejects.toThrow("db down");
    expect(source.acked).not.toContain(e2.messageId);
  });
});
const DAYMS = 86_400_000;
