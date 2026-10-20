import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryOrderRepository } from "../adapters/in-memory";
import { OrderDeliveryConsumer, OrderNotYetShippedError } from "../application/delivery-events";
import { ORDER_A, STAFF_A, STORE_A, TestClock, kit, placeTwoStoreGroup, sellerScope, type Kit } from "./fixtures";

const M = (n: number): string => `00000000-0000-4000-8000-${String(800 + n).padStart(12, "0")}`;
const DAY = 86_400_000;

describe("OrderDeliveryConsumer (shipment.delivered -> DELIVERED, then closure)", () => {
  let clock: TestClock;
  let repo: InMemoryOrderRepository;
  let k: Kit;
  let c: OrderDeliveryConsumer;
  beforeEach(async () => {
    clock = new TestClock();
    let n = 0;
    repo = new InMemoryOrderRepository(clock, () => `00000000-0000-4000-8000-${String(950_000 + n++).padStart(12, "0")}`);
    k = kit(repo, clock);
    c = new OrderDeliveryConsumer(k.commands);
    await placeTwoStoreGroup(k);
  });
  const ship = async () => {
    const s = sellerScope(STAFF_A, STORE_A);
    await k.commands.accept({ sellerOrderId: ORDER_A, scope: s, actorId: STAFF_A, idempotencyKey: "a" });
    await k.commands.pack({ sellerOrderId: ORDER_A, scope: s, actorId: STAFF_A, idempotencyKey: "p" });
    await k.commands.markShipped({ sellerOrderId: ORDER_A, commandKey: "s" });
  };
  const evt = (n: number, over: object = {}) => ({
    messageId: M(n),
    type: "shipment.delivered",
    occurredAtMs: clock.nowMs(),
    payload: { seller_order_id: ORDER_A, delivered_at: new Date(clock.nowMs() - 1000).toISOString(), courier: "bosta", cod: false },
    ...over,
  });

  it("delivers a shipped order at the courier-confirmed time, once, and a redelivery is a no-op", async () => {
    await ship();
    expect(await c.handle(evt(1))).toBe("handled");
    const o = await repo.getSellerOrder(ORDER_A, { kind: "system" });
    expect(o).toMatchObject({ status: "DELIVERED", deliveredAtMs: clock.nowMs() - 1000 });
    const events = repo.outbox.filter((e) => e.type === "seller_order.delivered").length;
    expect(await c.handle(evt(1))).toBe("handled");
    expect(repo.outbox.filter((e) => e.type === "seller_order.delivered")).toHaveLength(events);
    // a different message for an order already delivered is acknowledged, not retried
    expect(await c.handle(evt(2))).toBe("ignored");
  });

  it("an order not yet shipped asks for a retry; unknown orders and malformed payloads do not", async () => {
    await expect(c.handle(evt(1))).rejects.toBeInstanceOf(OrderNotYetShippedError);
    expect(await c.handle(evt(2, { payload: { seller_order_id: M(99), delivered_at: null } }))).toBe("ignored");
    expect(await c.handle(evt(3, { payload: { seller_order_id: "nope" } }))).toBe("invalid");
    expect(await c.handle(evt(4, { type: "shipment.picked_up" }))).toBe("ignored");
    expect((await repo.getSellerOrder(ORDER_A, { kind: "system" }))?.status).toBe("PAID");
  });

  it("end to end: delivered, window elapsed, closed once, order_line.closed per line, nothing on the second sweep", async () => {
    await ship();
    await c.handle(evt(1));
    clock.advance(40 * DAY);
    expect(await k.commands.closeDelivered(10)).toMatchObject({ closed: 1 });
    expect(repo.outbox.filter((e) => e.type === "order_line.closed")).toHaveLength(2);
    expect(await k.commands.closeDelivered(10)).toMatchObject({ closed: 0 });
    expect(repo.outbox.filter((e) => e.type === "order_line.closed")).toHaveLength(2);
  });
});
