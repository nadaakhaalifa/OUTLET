import { afterAll, describe, expect, it } from "vitest";
import { AnalyticsProducers, FakeKeyer, InventoryLevelChanged, StaticGate } from "../../analytics-ingest";
import { DEFAULT_TTL_POLICIES } from "../domain/core";
import { LOC_A, SKU_A1, STORE_A as INV_STORE_A, U, USER_1 } from "../test/fixtures";
import { createInventoryDatabase } from "../test/pglite-db";
import { STANDARD_POOL_ID } from "./in-memory";
import { KyselyInventoryStore } from "./kysely-store";

const T0 = 1_800_000_000_000;
const open: { destroy(): Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describe("inventory producer (inventory.level_changed)", () => {
  async function inv(on: boolean) {
    const { pg, db } = await createInventoryDatabase();
    open.push(db);
    await pg.exec(`insert into users (id, status) values ('${USER_1}', 'active')`);
    await pg.exec(`insert into locations (id, store_id, kind, name) values ('${LOC_A}', '${INV_STORE_A}', 'SELLER_WAREHOUSE', 'A main')`);
    const gate = new StaticGate(on);
    const store = new KyselyInventoryStore(db, new AnalyticsProducers({ gate, keyer: new FakeKeyer() }));
    const events = async () =>
      (await pg.query<{ p: Record<string, unknown> }>(`select payload as p from outbox_events where event_type = 'inventory.level_changed' order by occurred_at, id`)).rows.map((r) => InventoryLevelChanged.parse(r.p));
    const sync = (qty: number, key: string) =>
      store.applySync({ skuId: SKU_A1, locationId: LOC_A, poolId: STANDARD_POOL_ID, storeId: INV_STORE_A, mode: "set", quantity: qty, reason: "received", idempotencyKey: key, actorType: "seller", actorId: "s1", nowMs: T0 });
    const reserve = (og: number) =>
      store.reserve({
        reservationId: U(0x50000 + og), orderGroupId: U(0x9000 + og), userId: USER_1, nowMs: T0,
        plan: {
          lines: [{ skuId: SKU_A1, locationId: LOC_A, poolId: STANDARD_POOL_ID, storeId: INV_STORE_A, qty: 2 }],
          ttlSeconds: 600, ttlPolicyId: DEFAULT_TTL_POLICIES[0]?.id ?? "", poolKind: "STANDARD", holdReason: "CARD_WINDOW",
          fingerprint: `${SKU_A1}:${LOC_A}:${STANDARD_POOL_ID}:2`,
        },
      });
    return { store, events, sync, reserve, og: U(0x9000 + 1) };
  }

  it("BLOCKED: stock changes commit and append nothing", async () => {
    const i = await inv(false);
    await i.sync(5, "k1");
    expect((await i.reserve(1)).status).toBe("reserved");
    expect((await i.store.claim(i.og, T0)).status).toBe("claimed");
    expect(await i.events()).toEqual([]);
  });

  it("ALLOWED: sync, claim and unclaim each write one event with the summed totals; a replay writes none", async () => {
    const i = await inv(true);
    await i.sync(5, "k1");
    await i.sync(5, "k1"); // idempotent replay
    expect((await i.reserve(1)).status).toBe("reserved");
    expect((await i.store.claim(i.og, T0)).status).toBe("claimed");
    expect((await i.store.claim(i.og, T0 + 1)).status).toBe("already_claimed");
    expect((await i.store.unclaim(i.og, "cancelled", T0 + 2)).status).toBe("unclaimed");
    const ev = await i.events();
    expect(ev.map((e) => [e.on_hand_total, e.committed_total])).toEqual([[5, 0], [5, 2], [5, 0]]);
    for (const e of ev) {
      expect(e.sku_id).toBe(SKU_A1);
      expect(e.store_id).toBe(INV_STORE_A);
    }
  });
});
