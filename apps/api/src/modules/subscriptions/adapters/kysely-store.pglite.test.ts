import { afterAll, describe, expect, it } from "vitest";
import { KyselySubscriptionStore, type PlusDb } from "./kysely-store";
import { createPlusDatabase } from "../test/pglite-db";
import { U, T0, describeSubscriptionStoreContract, invoice, plan } from "../test/repository-contract";
import { startPaid } from "../domain/bridge";

const open: PlusDb[] = [];
let seq = 0;
const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}` };

const fresh = async () => {
  const { pg, db } = await createPlusDatabase();
  open.push(db);
  return {
    pg,
    db,
    store: new KyselySubscriptionStore(db, ids),
    ensureUser: async (id: string) => {
      await pg.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
    eventTypes: async () => {
      const r = await pg.query<{ event_type: string }>(`select event_type from outbox_events order by id`);
      return r.rows.map((x) => x.event_type);
    },
  };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeSubscriptionStoreContract("kysely/pglite", fresh);

describe("KyselySubscriptionStore specifics", () => {
  it("outbox payloads carry ids, enums and string money only, never tokens", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    const p = plan(1);
    await c.store.savePlan(p, []);
    const s = startPaid({ id: U(201), userId: U(1), plan: p, pspTokenRef: "secret-token-ref", nowMs: T0 });
    await c.store.commit({
      subscription: { value: s, expectedVersion: null },
      invoices: [invoice(1, s.id, s.userId)],
      events: [
        { type: "plus.refunded", subscriptionId: s.id, userId: s.userId, invoiceId: U(301), amountMinor: "20000" },
      ],
    });
    const rows = await c.pg.query<{ payload: unknown; aggregate_type: string }>(`select payload, aggregate_type from outbox_events`);
    expect(JSON.stringify(rows.rows)).not.toContain("secret-token-ref");
    expect(rows.rows[0]?.aggregate_type).toBe("plus_subscription");
    expect(rows.rows[0]?.payload).toEqual({ subscriptionId: s.id, userId: s.userId, invoiceId: U(301), amountMinor: "20000" });
  });

  it("schema invariants: PAUSED needs paused_until, PAST_DUE needs grace, price must be positive", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    const p = plan(1);
    await c.store.savePlan(p, []);
    const s = startPaid({ id: U(201), userId: U(1), plan: p, pspTokenRef: "t", nowMs: T0 });
    await expect(
      c.store.commit({ subscription: { value: { ...s, status: "PAUSED", pausedUntilMs: null }, expectedVersion: null }, events: [] }),
    ).rejects.toThrow();
    await expect(
      c.store.commit({ subscription: { value: { ...s, id: U(202), status: "PAST_DUE", graceEndsAtMs: null }, expectedVersion: null }, events: [] }),
    ).rejects.toThrow();
    await expect(c.store.savePlan(plan(2, { version: 9, priceMinor: 0n }), [])).rejects.toThrow();
  });

  it("row level security: owners read their own rows only, writes are system only", async () => {
    const c = await fresh();
    for (const n of [1, 2]) await c.ensureUser(U(n));
    const p = plan(1);
    await c.store.savePlan(p, []);
    const s = startPaid({ id: U(201), userId: U(1), plan: p, pspTokenRef: "t", nowMs: T0 });
    await c.store.commit({
      subscription: { value: s, expectedVersion: null },
      invoices: [invoice(1, s.id, s.userId)],
      entitlements: { subscriptionId: s.id, rows: [{ userId: U(1), subscriptionId: s.id, group: "commerce_benefits", key: "free_delivery", validFromMs: T0, validToMs: T0 + 1000 }] },
      events: [],
    });
    await c.store.addSavings({ id: U(501), userId: U(1), orderGroupId: U(601), benefit: "free_delivery", amountSavedMinor: 1n, createdAtMs: T0, reversedAtMs: null }, []);
    const asUser = async (userId: string, stmt: string): Promise<{ rows: unknown[] }> => {
      await c.pg.exec(
        `set role app_user; select set_config('app.user_id', '${userId}', false); select set_config('app.role', 'user', false);`,
      );
      try {
        return await c.pg.query(stmt);
      } finally {
        await c.pg.exec(`reset role`);
      }
    };
    for (const table of ["subscriptions", "subscription_invoices", "entitlements", "plus_savings_ledger"]) {
      expect((await asUser(U(1), `select 1 from ${table}`)).rows).toHaveLength(1);
      expect((await asUser(U(2), `select 1 from ${table}`)).rows).toHaveLength(0);
    }
    expect((await asUser(U(2), `select 1 from plans`)).rows).toHaveLength(1);
    expect((await asUser(U(1), `select 1 from trial_claims`)).rows).toHaveLength(0);
    await expect(
      asUser(U(1), `update subscriptions set status = 'EXPIRED' where id = '${s.id}' returning id`),
    ).resolves.toEqual(expect.objectContaining({ rows: [] }));
    await expect(
      asUser(U(1), `insert into plus_savings_ledger (id, user_id, order_group_id, benefit, amount_saved, created_at) values ('${U(502)}', '${U(1)}', '${U(602)}', 'free_delivery', 5, now())`),
    ).rejects.toThrow();
  });
});
