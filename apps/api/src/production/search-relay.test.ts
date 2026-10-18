import { InboxConsumer, MemoryDatabase, type OutboxMessage } from "@outlet/outbox";
import { describe, expect, it } from "vitest";
import { RoutingPublisher, SearchEventsPublisher } from "./relay";

const msg = (type: string, id = "00000000-0000-4000-8000-000000000001"): OutboxMessage => ({
  messageId: id,
  occurredAt: new Date(1_800_000_000_000),
  aggregateType: "product",
  aggregateId: "00000000-0000-4000-b000-000000000001",
  eventType: type,
  eventVersion: 1,
  orderingKey: null,
  payload: { productId: "00000000-0000-4000-b000-000000000001", version: 1 },
  headers: {},
});

function setup() {
  const db = new MemoryDatabase();
  const inbox = new InboxConsumer({ uow: db, inbox: db, clock: { now: () => new Date(1_800_000_000_000) } });
  const handled: string[] = [];
  const state = { fail: false };
  const consumer = {
    handle: async (e: { messageId: string; type: string; occurredAtMs?: number }) => {
      handled.push(`${e.type}@${e.occurredAtMs}`);
      if (state.fail) throw new Error("catalog read behind the event");
    },
  };
  const never = { publish: async () => { throw new Error("wrong consumer"); } };
  const router = new RoutingPublisher(never, null, null, null, null, new SearchEventsPublisher(inbox, consumer));
  return { db, router, handled, state };
}

describe("search sync through the relay inbox", () => {
  it("routes the three catalog product events to the feeder and records message_id once", async () => {
    const { db, router, handled } = setup();
    await router.publish(msg("product.created", "00000000-0000-4000-8000-000000000001"));
    await router.publish(msg("product.updated", "00000000-0000-4000-8000-000000000002"));
    await router.publish(msg("product.status_changed", "00000000-0000-4000-8000-000000000003"));
    expect(handled).toHaveLength(3);
    expect(db.inboxSize()).toBe(3);
  });

  it("a redelivered message is a no-op (inbox dedupe)", async () => {
    const { router, handled } = setup();
    await router.publish(msg("product.updated"));
    await router.publish(msg("product.updated"));
    expect(handled).toHaveLength(1);
  });

  it("a throwing handler rolls the inbox row back so the retry runs it again", async () => {
    const { db, router, handled, state } = setup();
    state.fail = true;
    await expect(router.publish(msg("product.updated"))).rejects.toThrow();
    expect(db.inboxSize()).toBe(0);
    state.fail = false;
    await router.publish(msg("product.updated"));
    expect(handled).toHaveLength(2);
    expect(db.inboxSize()).toBe(1);
  });

  it("other event types are not routed to search", async () => {
    const { router, handled } = setup();
    await router.publish(msg("order_group.cancelled"));
    expect(handled).toHaveLength(0);
    expect(router.unroutedCounts().get("order_group.cancelled")).toBe(1);
  });
});
