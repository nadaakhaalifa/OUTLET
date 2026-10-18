import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { PRODUCTION_RUNTIME, type ProductionRuntime } from "./compose";
import { createProductionRelay } from "./relay";
import { bootProduction, type ProductionTestApp } from "./test/test-support";

type Handler = { handle(e: { messageId: string; type: string; payload: unknown; occurredAtMs?: number }): Promise<unknown> };

/**
 * Delivery of the commerce events (order_group.paid, order_line.closed, order_line.refunded,
 * payment_method.removed) through the production relay and inbox, on Postgres (PGlite): routing,
 * fan-out with separate inbox consumers, redelivery with one effect, and retry on a throwing consumer.
 */
describe("commerce events through the production relay (PGlite)", () => {
  let t: ProductionTestApp;
  beforeAll(async () => {
    t = await bootProduction();
  }, 120_000);
  afterAll(async () => {
    await t.app.close();
  });

  const insert = async (id: string, type: string, payload: object): Promise<void> => {
    await t.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.role', 'system', true)`.execute(trx);
      await sql`INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload)
        VALUES (${id}::uuid, 'agg', ${id}::uuid, ${type}, ${JSON.stringify(payload)}::jsonb)`.execute(trx);
    });
  };
  const state = async (id: string): Promise<{ published: boolean; attempts: number }> =>
    t.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.role', 'system', true)`.execute(trx);
      const r = await sql<{ p: boolean; a: number }>`SELECT (published_at IS NOT NULL) AS p, publish_attempts AS a FROM outbox_events WHERE id = ${id}::uuid`.execute(trx);
      return { published: r.rows[0]?.p ?? false, attempts: r.rows[0]?.a ?? -1 };
    });
  const unpublish = async (id: string): Promise<void> => {
    await t.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.role', 'system', true)`.execute(trx);
      await sql`UPDATE outbox_events SET published_at = NULL, next_attempt_at = NULL WHERE id = ${id}::uuid`.execute(trx);
    });
  };
  const inbox = async (consumer: string, id: string): Promise<number> =>
    t.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.role', 'system', true)`.execute(trx);
      const r = await sql<{ n: string }>`SELECT count(*)::text AS n FROM inbox_processed WHERE consumer = ${consumer} AND message_id = ${id}::uuid`.execute(trx);
      return Number(r.rows[0]?.n ?? 0);
    });

  const recorder = (log: string[], name: string, failing: { on: boolean } = { on: false }): Handler => ({
    handle: async (e) => {
      log.push(`${name}:${e.type}:${e.messageId}`);
      if (failing.on) throw new Error("boom");
    },
  });

  it("routes each type to its owners; order_group.paid reaches both creators and auto-buy, once each", async () => {
    const runtime = t.app.get<ProductionRuntime>(PRODUCTION_RUNTIME, { strict: false });
    const log: string[] = [];
    const relay = createProductionRelay(runtime, { autoBuyEvents: recorder(log, "autobuy"), creatorEvents: recorder(log, "creators") });
    const paid = "0190a000-0000-7000-8000-0000000000c1";
    const closed = "0190a000-0000-7000-8000-0000000000c2";
    const refunded = "0190a000-0000-7000-8000-0000000000c3";
    const removed = "0190a000-0000-7000-8000-0000000000c4";
    const price = "0190a000-0000-7000-8000-0000000000c5";
    await insert(paid, "order_group.paid", { user_id: paid });
    await insert(closed, "order_line.closed", {});
    await insert(refunded, "order_line.refunded", {});
    await insert(removed, "payment_method.removed", {});
    await insert(price, "price.changed", {});
    expect(await relay.runOnce()).toMatchObject({ published: 5 });
    expect([...log].sort()).toEqual(
      [
        `autobuy:order_group.paid:${paid}`,
        `creators:order_group.paid:${paid}`,
        `creators:order_line.closed:${closed}`,
        `creators:order_line.refunded:${refunded}`,
        `autobuy:payment_method.removed:${removed}`,
        `autobuy:price.changed:${price}`,
      ].sort(),
    );
    expect(await inbox("auto-buy.relay", paid)).toBe(1);
    expect(await inbox("creators.relay", paid)).toBe(1);
    expect(await inbox("creators.relay", removed)).toBe(0);

    // redelivery (an at-least-once broker, a replay by clearing published_at): one effect only
    const before = log.length;
    for (const id of [paid, closed, refunded, removed, price]) await unpublish(id);
    expect(await relay.runOnce()).toMatchObject({ published: 5 });
    expect(log.length).toBe(before);
  });

  it("a throwing creators consumer retries the message; auto-buy, already committed, is not re-run", async () => {
    const runtime = t.app.get<ProductionRuntime>(PRODUCTION_RUNTIME, { strict: false });
    const log: string[] = [];
    const failing = { on: true };
    const relay = createProductionRelay(runtime, {
      autoBuyEvents: recorder(log, "autobuy"),
      creatorEvents: recorder(log, "creators", failing),
    });
    const id = "0190a000-0000-7000-8000-0000000000d1";
    await insert(id, "order_group.paid", { user_id: id });
    expect(await relay.runOnce()).toMatchObject({ retryScheduled: 1 });
    expect(await state(id)).toEqual({ published: false, attempts: 1 });
    expect(await inbox("auto-buy.relay", id)).toBe(1);
    expect(await inbox("creators.relay", id)).toBe(0);
    expect(log.filter((l) => l.startsWith("autobuy"))).toHaveLength(1);

    failing.on = false;
    // make the retry due now
    await t.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.role', 'system', true)`.execute(trx);
      await sql`UPDATE outbox_events SET next_attempt_at = NULL WHERE id = ${id}::uuid`.execute(trx);
    });
    expect(await relay.runOnce()).toMatchObject({ published: 1 });
    expect(await inbox("creators.relay", id)).toBe(1);
    expect(log.filter((l) => l.startsWith("autobuy"))).toHaveLength(1);
    expect(log.filter((l) => l.startsWith("creators"))).toHaveLength(2);
  });

  it("without a composed consumer the events are acknowledged unrouted (creators is blocked in production)", async () => {
    const runtime = t.app.get<ProductionRuntime>(PRODUCTION_RUNTIME, { strict: false });
    const relay = createProductionRelay(runtime, { creatorEvents: null });
    const id = "0190a000-0000-7000-8000-0000000000d2";
    await insert(id, "order_line.closed", {});
    expect(await relay.runOnce()).toMatchObject({ published: 1 });
    expect(relay.publisher.unroutedCounts().get("order_line.closed")).toBe(1);
  });
});
