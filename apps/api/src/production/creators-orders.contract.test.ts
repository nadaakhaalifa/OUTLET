import { describe, expect, it } from "vitest";
import { CreatorEventConsumer, type LineClosedMessage } from "../modules/creators";
import { FakeOrderIntake, InMemoryOrderRepository, OrderCommands, PlaceOrders } from "../modules/orders";
import { createIdGenerator, nodeCsprng } from "../platform";
import { assertCreatorsOrdersPrerequisites, MODULE_BINDINGS, MissingLineReturnsError } from "./bindings";

const DAY = 86_400_000;
const T0 = 1_800_000_000_000;
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

class Clock {
  ms = T0;
  nowMs(): number {
    return this.ms;
  }
}

/**
 * Cross-module contract, at the composition layer (the only place both modules may be seen together):
 * the real orders producer writes `order_line.closed`; the real creators consumer must accept every
 * payload (never "invalid") and read the return gate the orders module states.
 */
describe("orders order_line.closed -> creators consumer contract", () => {
  async function closeOrder(withReturns: boolean) {
    const clock = new Clock();
    const ids = createIdGenerator(clock, nodeCsprng);
    const repo = new InMemoryOrderRepository(clock, () => ids.uuidV7());
    const commands = new OrderCommands({
      repo,
      clock,
      ids,
      ...(withReturns ? { lineReturns: { openReturnsByLine: async () => new Map<string, number>() } } : {}),
    });
    const intake = new FakeOrderIntake(new PlaceOrders(repo, clock));
    await intake.placeOrder({ groupId: U(100), userId: U(1), paidAtMs: clock.ms, stores: [{ sellerOrderId: U(201), storeId: U(300), lines: 2 }] });
    return { clock, repo, commands };
  }

  it("a closed order's payloads parse in the creators consumer and carry open_returns=0 when lineReturns is bound", async () => {
    const { clock, repo, commands } = await closeOrder(true);
    await commands.accept({ sellerOrderId: U(201), scope: { kind: "seller", userId: U(11), storeIds: [U(300)] } as never, actorId: U(11), idempotencyKey: "a" });
    await commands.pack({ sellerOrderId: U(201), scope: { kind: "seller", userId: U(11), storeIds: [U(300)] } as never, actorId: U(11), idempotencyKey: "p" });
    await commands.markShipped({ sellerOrderId: U(201), commandKey: "s" });
    await commands.markDelivered({ sellerOrderId: U(201), deliveredAtMs: clock.ms, commandKey: "d" });
    clock.ms += 34 * DAY;
    expect(await commands.closeDelivered(10)).toMatchObject({ closed: 1, failed: 0 });
    const seen: LineClosedMessage[] = [];
    const consumer = new CreatorEventConsumer(
      { execute: async (m: LineClosedMessage) => { seen.push(m); return { kind: "ignored" } as never; } },
      { execute: async () => ({ kind: "ignored" }) as never },
      { execute: async () => ({ kind: "ignored" }) as never },
    );
    const closed = repo.outbox.filter((e) => e.type === "order_line.closed");
    expect(closed).toHaveLength(2);
    for (const [i, e] of closed.entries()) {
      expect(await consumer.handle({ messageId: U(900 + i), type: e.type, payload: { ...e.payload, order_line_id: U(700 + i) } })).toBe("handled");
    }
    expect(seen).toHaveLength(2);
    for (const m of seen) {
      expect(m.openReturns).toBe(0);
      expect(m.returnWindowEndsAtMs).not.toBeNull();
      expect(m.orderGroupId).toBe(U(100));
    }
  });

  it("without lineReturns the same payload states open_returns=null (creators then defer)", async () => {
    const { clock, repo, commands } = await closeOrder(false);
    const scope = { kind: "seller", userId: U(11), storeIds: [U(300)] } as never;
    await commands.accept({ sellerOrderId: U(201), scope, actorId: U(11), idempotencyKey: "a" });
    await commands.pack({ sellerOrderId: U(201), scope, actorId: U(11), idempotencyKey: "p" });
    await commands.markShipped({ sellerOrderId: U(201), commandKey: "s" });
    await commands.markDelivered({ sellerOrderId: U(201), deliveredAtMs: clock.ms, commandKey: "d" });
    clock.ms += 34 * DAY;
    await commands.closeDelivered(10);
    const e = repo.outbox.find((x) => x.type === "order_line.closed");
    expect(e?.payload["open_returns"]).toBeNull();
  });
});

describe("creators prerequisites on orders (bindings check)", () => {
  it("creators blocked: no requirement; creators composed without lineReturns: fails composition", () => {
    expect(MODULE_BINDINGS["creators"]?.status).toBe("blocked");
    expect(() => assertCreatorsOrdersPrerequisites(MODULE_BINDINGS, {})).not.toThrow();
    const composed = { ...MODULE_BINDINGS, creators: { status: "composed" as const } };
    expect(() => assertCreatorsOrdersPrerequisites(composed, {})).toThrow(MissingLineReturnsError);
    expect(() => assertCreatorsOrdersPrerequisites(composed, { lineReturns: {} })).not.toThrow();
  });
});
