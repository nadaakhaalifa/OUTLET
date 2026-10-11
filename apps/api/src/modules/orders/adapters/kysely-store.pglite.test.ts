import { afterAll, describe, expect, it } from "vitest";
import { createTestDatabaseUpTo } from "@outlet/db";
import type { Kysely } from "kysely";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { KyselyOrderRepository, type OrdersDb } from "./kysely-store";
import { describeOrderRepositoryContract } from "../test/repository-contract";
import { ORDER_A, STAFF_A, STORE_A, T0, TestClock, kit, placeTwoStoreGroup, sellerScope } from "../test/fixtures";

const open: Kysely<Record<string, never>>[] = [];

const fresh = async () => {
  const raw = await createTestDatabaseUpTo(19);
  const db: OrdersDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  const clock = new TestClock();
  return {
    raw,
    clock,
    repo: new KyselyOrderRepository(db, clock),
    ensureUser: async (id: string) => {
      await raw.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
    outboxTypes: async () =>
      (await raw.query<{ t: string }>(`select event_type as t from outbox_events order by occurred_at, id`)).rows.map(
        (r) => r.t,
      ),
    historyCount: async (id: string) =>
      Number(
        (await raw.query<{ n: string }>(`select count(*)::text as n from order_status_history where seller_order_id = $1`, [id]))
          .rows[0]?.n,
      ),
  };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeOrderRepositoryContract("kysely/pglite", fresh);

describe("KyselyOrderRepository specifics", () => {
  it("rolls state, history and outbox back together when an event is rejected by the database", async () => {
    const c = await fresh();
    await c.ensureUser("00000000-0000-4000-8000-000000000001");
    const k = kit(c.repo, c.clock);
    await placeTwoStoreGroup(k);
    const res = c.repo.applyTransition({
      sellerOrderId: ORDER_A,
      scope: sellerScope(STAFF_A, STORE_A),
      expectedVersion: 0,
      commandKey: "accept:boom",
      transition: {
        from: "PAID",
        to: "ACCEPTED",
        event: "SELLER_ACCEPT",
        actorType: "SELLER",
        reasonCode: null,
        stamps: { acceptedAtMs: T0, dispatchByMs: T0 + 1 },
      },
      actorId: STAFF_A,
      nowMs: T0,
      historyId: "00000000-0000-4000-8000-0000000aaaa1",
      // violates outbox_events.event_type CHECK
      events: [
        {
          id: "00000000-0000-4000-8000-0000000aaaa2",
          type: "NOT A VALID TYPE",
          aggregateType: "seller_order",
          aggregateId: ORDER_A,
          occurredAtMs: T0,
          payload: {},
        },
      ],
      rollup: () => null,
    });
    await expect(res).rejects.toThrow();
    const o = await c.repo.getSellerOrder(ORDER_A, { kind: "system" });
    expect(o?.status).toBe("PAID");
    expect(o?.version).toBe(0);
    expect(await c.historyCount(ORDER_A)).toBe(0);
    expect(await c.outboxTypes()).toEqual(["seller_order.placed", "seller_order.placed"]);
  });

  it("the database refuses to leave a terminal state even if the application is bypassed", async () => {
    const c = await fresh();
    await c.ensureUser("00000000-0000-4000-8000-000000000001");
    await placeTwoStoreGroup(kit(c.repo, c.clock));
    await c.raw.query(`update seller_orders set status = 'CANCELLED' where id = $1`, [ORDER_A]);
    await expect(c.raw.query(`update seller_orders set status = 'ACCEPTED' where id = $1`, [ORDER_A])).rejects.toThrow(
      /terminal state/,
    );
  });

  it("status history is append-only", async () => {
    const c = await fresh();
    await c.ensureUser("00000000-0000-4000-8000-000000000001");
    const k = kit(c.repo, c.clock);
    await placeTwoStoreGroup(k);
    await k.commands.accept({
      sellerOrderId: ORDER_A,
      scope: sellerScope(STAFF_A, STORE_A),
      actorId: STAFF_A,
      idempotencyKey: "h",
    });
    await expect(c.raw.query(`delete from order_status_history`)).rejects.toThrow(/append-only/);
  });
});
