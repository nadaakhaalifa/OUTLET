import { createTestDatabaseUpTo } from "@outlet/db";
import type { Kysely } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { KyselyRefundStore, type RefundsDb } from "../adapters/kysely-store";
import { SeqIds, SHOPPER_A, U } from "./fixtures";
import { describeRefundStoreContract, intakeNow, makeRefund } from "./store-contract";

const open: Kysely<Record<string, never>>[] = [];

const fresh = async () => {
  const raw = await createTestDatabaseUpTo(34);
  const db: RefundsDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  return {
    raw,
    store: new KyselyRefundStore(db, new SeqIds(0x40000)),
    ensureUser: async (id: string) => {
      await raw.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
    eventTypes: async () =>
      (await raw.query<{ t: string }>(`select event_type as t from outbox_events order by occurred_at, id`)).rows.map((r) => r.t),
  };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeRefundStoreContract("kysely/pglite", fresh);

describe("refunds migration 0034 constraints", () => {
  it("makes BNPL cash conversion structurally impossible", async () => {
    const w = await fresh();
    await w.ensureUser(SHOPPER_A);
    const r = makeRefund(1);
    await intakeNow(w.store, { consumer: "c", messageId: U(1), refund: r });
    await expect(
      w.raw.query(`update refund_legs set method = 'bnpl' where refund_id = $1`, [r.id]),
    ).rejects.toThrow();
    await expect(
      w.raw.query(`update refund_legs set channel = 'bnpl_cancel' where refund_id = $1`, [r.id]),
    ).rejects.toThrow();
  });

  it("has no top-up, withdrawal or transfer columns or tables", async () => {
    const w = await fresh();
    const cols = await w.raw.query<{ n: string }>(
      `select table_name || '.' || column_name as n from information_schema.columns
       where table_name in ('credit_lots','credit_holds','credit_hold_lines','credit_transactions')`,
    );
    expect(cols.rows.length).toBeGreaterThan(0);
    for (const c of cols.rows) expect(c.n).not.toMatch(/withdraw|top_?up|transfer|cash|payout/i);
  });
});

import { FakeCreditRestore, FakePayoutDetails, FakeRefundExecutor, FakeRefundFacts, InMemoryRefundLedger, SeqJitter } from "../adapters/fakes";
import { IntakeRefundIntent } from "../application/intake";
import { ProcessRefund, SweepRefunds } from "../application/process";
import { ORDER_GROUP_1, SELLER_ORDER_1, TestClock, facts, intent, tender } from "./fixtures";

describe("refund saga on Postgres", () => {
  it("intake, ledger-first processing and completion persist, outbox in the same unit, replay is a no-op", async () => {
    const w = await fresh();
    await w.ensureUser(SHOPPER_A);
    const clock = new TestClock();
    const store = w.store;
    const factsPort = new FakeRefundFacts();
    factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "bnpl", 6_000n), tender("t2", "cod", 4_000n)]));
    const ledger = new InMemoryRefundLedger();
    ledger.recognise(ORDER_GROUP_1);
    const credit = new FakeCreditRestore();
    const executor = new FakeRefundExecutor();
    const process = new ProcessRefund(store, ledger, credit, executor, new FakePayoutDetails(), clock, new SeqJitter(0));
    const intake = new IntakeRefundIntent(store, factsPort, new SeqIds(0x50000), clock);
    const created = await intake.execute(intent(1, { net: 10_000n, preference: "store_credit" }));
    expect(created.kind).toBe("created");
    expect((await intake.execute(intent(1, { net: 10_000n, preference: "store_credit" }))).kind).toBe("duplicate");
    await new SweepRefunds(store, process, clock).execute();
    const id = created.kind === "created" ? created.refundId : "";
    const done = await store.get(id);
    expect(done?.status).toBe("COMPLETED");
    // BNPL leg went to the provider, COD leg became credit; the BNPL portion never became credit
    expect(done?.legs.map((l) => [l.method, l.channel, l.amount])).toEqual([
      ["bnpl", "bnpl_cancel", 6_000n],
      ["cod", "store_credit", 4_000n],
    ]);
    expect([...credit.restored.values()].reduce((a, c) => a + c.amount, 0n)).toBe(4_000n);
    expect(await w.eventTypes()).toEqual(["refund.requested", "refund.approved", "refund.completed"]);
    expect((await store.listActionable(clock.nowMs(), 10)).length).toBe(0);
  });
});

describe("RLS on refunds and credit tables", () => {
  it("a shopper sees only their own rows and cannot write; system writes", async () => {
    const w = await fresh();
    await w.ensureUser(SHOPPER_A);
    await w.ensureUser(U(0xb1));
    await intakeNow(w.store, { consumer: "c", messageId: U(1), refund: makeRefund(1) });
    await w.raw.query(
      `insert into credit_lots (id, user_id, sub_key, granted, remaining, held, source_key, created_at)
       values ($1, $2, 'refund_credit', 100, 100, 0, 'src-rls', now())`,
      [U(0x66), SHOPPER_A],
    );
    const asUser = async (userId: string, role: string, sqlText: string) => {
      await w.raw.exec("BEGIN");
      try {
        await w.raw.exec("SET LOCAL ROLE app_user");
        await w.raw.query("select set_config('app.role',$1,true), set_config('app.user_id',$2,true)", [role, userId]);
        return await w.raw.query<{ n: string }>(sqlText);
      } finally {
        await w.raw.exec("ROLLBACK");
      }
    };
    const n = (r: { rows: { n: string }[] }) => Number(r.rows[0]?.n);
    expect(n(await asUser(SHOPPER_A, "shopper", "select count(*)::text as n from refunds"))).toBe(1);
    expect(n(await asUser(U(0xb1), "shopper", "select count(*)::text as n from refunds"))).toBe(0);
    expect(n(await asUser(U(0xb1), "shopper", "select count(*)::text as n from credit_lots"))).toBe(0);
    // an UPDATE by the shopper's own role touches no row (no update policy, or no grant at all)
    const upd = await asUser(SHOPPER_A, "shopper", "update credit_lots set remaining = 1000000 returning 1::text as n").catch(
      () => ({ rows: [] as { n: string }[] }),
    );
    expect(upd.rows).toHaveLength(0);
  });
});
