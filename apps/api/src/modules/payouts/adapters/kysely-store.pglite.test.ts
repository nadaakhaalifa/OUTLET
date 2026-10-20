import { afterAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { KyselyPayoutStore, type PayoutsDb } from "./kysely-store";
import { describePayoutScenarios } from "../test/scenarios";
import { createPayoutsDatabase, pinUpdatedAt } from "../test/db";
import { CUTOFF, FINANCE_1, STORE_A, STORE_B, T0, TestClock, U, addOrder, kit, seedStore } from "../test/fixtures";

const open: Kysely<Record<string, never>>[] = [];

const fresh = async () => {
  const raw = await createPayoutsDatabase();
  await pinUpdatedAt(raw, T0);
  const db: PayoutsDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  // Fixed scenario clock; the DB trigger stamps updated_at from the same fixed instant (see pinUpdatedAt).
  const clock = new TestClock(T0);
  const store = new KyselyPayoutStore(db, clock);
  return {
    raw,
    store,
    clock,
    propertyRuns: 3,
    ensureUser: async (id: string) => {
      await raw.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
    outboxTypes: async () =>
      (await raw.query<{ t: string }>(`select event_type as t from outbox_events order by occurred_at, ctid`)).rows.map((r) => r.t),
  };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describePayoutScenarios("kysely/pglite", fresh);

describe("KyselyPayoutStore specifics", () => {
  it("rolls state, history and outbox back together when an event is rejected by the database", async () => {
    const c = await fresh();
    await c.ensureUser(FINANCE_1);
    const k = kit(c.store, c.clock);
    seedStore(k, STORE_A);
    addOrder(k, 1, 80_000n);
    await k.commands.schedule();
    const p = (await c.store.list({ scope: { kind: "system" }, after: null, limit: 1 })).items[0];
    if (p === undefined) throw new Error("no payout");
    const res = c.store.apply({
      payoutId: p.id,
      expectedVersion: 0,
      commandKey: "approve:boom",
      from: "SCHEDULED",
      to: "APPROVED",
      event: "APPROVE",
      actorType: "FINANCE",
      actorId: FINANCE_1,
      reasonCode: null,
      nowMs: T0,
      historyId: U(900),
      patch: { approvedBy: FINANCE_1, approvedAtMs: T0, holdReason: null },
      releaseLines: false,
      // violates outbox_events.event_type CHECK
      events: [{ id: U(901), type: "NOT A VALID TYPE", aggregateId: p.id, occurredAtMs: T0, payload: {} }],
    });
    await expect(res).rejects.toThrow();
    const after = await c.store.get(p.id, { kind: "system" });
    expect(after?.status).toBe("SCHEDULED");
    expect(after?.version).toBe(0);
    expect(await c.store.hasCommand(p.id, "approve:boom")).toBe(false);
    expect(await c.outboxTypes()).toEqual(["payout.scheduled"]);
  });

  it("the database refuses to leave a terminal state, change an amount or re-activate a released line", async () => {
    const c = await fresh();
    await c.ensureUser(FINANCE_1);
    const k = kit(c.store, c.clock);
    seedStore(k, STORE_A);
    addOrder(k, 1, 80_000n);
    await k.commands.schedule();
    const p = (await c.store.list({ scope: { kind: "system" }, after: null, limit: 1 })).items[0];
    if (p === undefined) throw new Error("no payout");
    await expect(c.raw.query(`update payouts set amount = 1, eligible_total = 1 where id = $1`, [p.id])).rejects.toThrow(/immutable/);
    await c.raw.query(`update payouts set status = 'CANCELLED' where id = $1`, [p.id]);
    await expect(c.raw.query(`update payouts set status = 'SCHEDULED' where id = $1`, [p.id])).rejects.toThrow(/terminal state/);
    await c.raw.query(`update payout_lines set active = false where payout_id = $1`, [p.id]);
    await expect(c.raw.query(`update payout_lines set active = true where payout_id = $1`, [p.id])).rejects.toThrow(/re-activated/);
    await expect(c.raw.query(`delete from payout_lines`)).rejects.toThrow(/not allowed/);
  });

  it("one active payout per seller order and per store and cycle, enforced by the database", async () => {
    const c = await fresh();
    const k = kit(c.store, c.clock);
    seedStore(k, STORE_A);
    addOrder(k, 1, 80_000n);
    await k.commands.schedule();
    const p = (await c.store.list({ scope: { kind: "system" }, after: null, limit: 1 })).items[0];
    if (p === undefined) throw new Error("no payout");
    const line = p.lines[0];
    if (line === undefined) throw new Error("no line");
    await c.raw.query(
      `insert into payouts (id, store_id, cycle_key, cutoff_at, amount, eligible_total, line_count) values ($1,$2,'2026-10-04',now(),100,100,1)`,
      [U(950), STORE_A],
    );
    await expect(
      c.raw.query(`insert into payout_lines (payout_id, store_id, source_type, source_id, amount) values ($1,$2,'seller_order',$3,100)`, [U(950), STORE_A, line.sourceId]),
    ).rejects.toThrow(/payout_lines_active_order_uq/);
    await expect(
      c.raw.query(
        `insert into payouts (id, store_id, cycle_key, cutoff_at, amount, eligible_total, line_count) values ($1,$2,$3,now(),100,100,1)`,
        [U(951), STORE_A, p.cycleKey],
      ),
    ).rejects.toThrow(/payouts_store_cycle_uq/);
    expect(CUTOFF).toBeGreaterThan(0);
  });

  it("status history and attempts are append-only", async () => {
    const c = await fresh();
    await c.ensureUser(FINANCE_1);
    const k = kit(c.store, c.clock);
    seedStore(k, STORE_A);
    addOrder(k, 1, 80_000n);
    await k.commands.schedule();
    const p = (await c.store.list({ scope: { kind: "system" }, after: null, limit: 1 })).items[0];
    if (p === undefined) throw new Error("no payout");
    await k.commands.approve({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "a" });
    await expect(c.raw.query(`delete from payout_status_history`)).rejects.toThrow(/append-only/);
    await c.store.recordAttempt(p.id, { attemptNo: 1, outcome: "unavailable", code: "x", providerRef: null, atMs: T0 });
    await expect(c.raw.query(`update payout_attempts set code = 'y'`)).rejects.toThrow(/append-only/);
  });
});

describe("balanceTotals under RLS (app_user)", () => {
  it("sums ON_HOLD and in-transit payouts of one store with a single aggregate, and a seller scope cannot see another store", async () => {
    const c = await fresh();
    const k = kit(c.store, c.clock);
    seedStore(k, STORE_A);
    seedStore(k, STORE_B);
    addOrder(k, 1, 80_000n);
    addOrder(k, 2, 50_000n, { storeId: STORE_B });
    k.risk.held.add(STORE_B);
    await k.commands.schedule();
    const seller = (storeId: string) => ({ kind: "seller" as const, userId: U(77), storeIds: [storeId] });
    expect(await c.store.balanceTotals(seller(STORE_A), STORE_A)).toEqual({ held: 0n, inTransit: 80_000n });
    expect(await c.store.balanceTotals(seller(STORE_B), STORE_B)).toEqual({ held: 50_000n, inTransit: 0n });
    // Row level security: store A's seller scope reads nothing of store B even when asking for it.
    expect(await c.store.balanceTotals(seller(STORE_A), STORE_B)).toEqual({ held: 0n, inTransit: 0n });
    expect(await c.store.balanceTotals({ kind: "system" }, STORE_B)).toEqual({ held: 50_000n, inTransit: 0n });
  });
});
