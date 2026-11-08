import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "@outlet/ids";
import { INVENTORY_RELEASE_REQUIRED_EVENT, RejectedOrderInventoryRelease } from "../src/index.js";
import { buildWorld, intentOf, paidWebhook, quoteAndPlace } from "./fixtures.js";
import type { World } from "./fixtures.js";

let w: World;
beforeAll(async () => { w = await buildWorld(); });
afterAll(async () => { await w.close(); });

describe("RejectedOrderInventoryRelease", () => {
  it("emits inventory.release_required once per event (inbox) with the cancelled lines", async () => {
    const sku = await w.seedSku(w.stores[0], 50_000n, 3);
    const userId = await w.newUser();
    await w.fillBag(userId, [{ sku, qty: 2 }]);
    const { place } = await quoteAndPlace(w, userId, "card");
    const placed = await place();
    await w.webhooks.handle(paidWebhook(w, await intentOf(w, placed.orderGroupId), randomUUID()));
    const so = (await w.raw.query<{ id: string; store_id: string }>("SELECT id, store_id FROM seller_orders WHERE order_group_id = $1", [placed.orderGroupId])).rows[0];
    if (so === undefined) throw new Error("no order");
    await w.raw.query("UPDATE seller_orders SET status = 'REJECTED_BY_SELLER' WHERE id = $1", [so.id]);
    await w.raw.query("UPDATE order_lines SET status = 'cancelled' WHERE seller_order_id = $1", [so.id]);
    const consumer = new RejectedOrderInventoryRelease(w.workerClient, "EG");
    const ev = { id: uuidv7(), payload: { seller_order_id: so.id, user_id: userId, order_group_id: placed.orderGroupId, store_id: so.store_id } };
    expect(await consumer.handle(ev)).toBe("processed");
    expect(await consumer.handle(ev)).toBe("duplicate");
    const out = await w.raw.query<{ payload: { lines: { sku_id: string; qty: number }[]; reservation_id: string | null } }>("SELECT payload FROM outbox_events WHERE event_type = $1 AND aggregate_id = $2", [INVENTORY_RELEASE_REQUIRED_EVENT, so.id]);
    expect(out.rows.length).toBe(1);
    expect(out.rows[0]?.payload.lines).toEqual([{ sku_id: sku.skuId, qty: 2 }]);
    expect(out.rows[0]?.payload.reservation_id).not.toBeNull();
    await expect(consumer.handle({ id: uuidv7(), payload: { seller_order_id: "x" } })).rejects.toThrow();
  });
  it("tolerates a missing order group (null reservation, no lines)", async () => {
    const consumer = new RejectedOrderInventoryRelease(w.workerClient, "EG", { now: () => new Date(), newId: () => uuidv7() });
    const userId = await w.newUser();
    const id = randomUUID();
    expect(await consumer.handle({ id: uuidv7(), payload: { seller_order_id: id, user_id: userId, order_group_id: randomUUID(), store_id: w.stores[0] } })).toBe("processed");
    const r = await w.raw.query<{ payload: { reservation_id: unknown; lines: unknown[] } }>("SELECT payload FROM outbox_events WHERE aggregate_id = $1", [id]);
    expect(r.rows[0]?.payload).toMatchObject({ reservation_id: null, lines: [] });
  });
});
