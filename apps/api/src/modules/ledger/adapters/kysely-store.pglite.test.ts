import { randomUUID } from "node:crypto";
import { createTestDatabaseUpTo } from "@outlet/db";
import { sha256Hex } from "@outlet/idempotency";
import { sql, type Kysely } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { createIdGenerator, nodeCsprng } from "../../../platform";
import {
  KyselyOutboxStore,
  KyselyTransactionRunner,
  createPgliteDatabase,
  type DbTx,
  type PgliteInstance,
} from "../../../platform/db";
import { IntegrityJob } from "../application/integrity-job";
import { PostingService } from "../application/posting-service";
import type { LedgerDbTx } from "./kysely-store";
import { KyselyIntegritySnapshots, KyselyLedgerReadModel, KyselyLedgerStore, ledgerTxOf } from "./kysely-store";
import { InMemoryProjection } from "./in-memory";
import { SCOPE, describeLedgerContract, orderCmd, type BoundPosting, type LedgerHarness } from "../test/contract";

const open: Kysely<Record<string, never>>[] = [];

class Clock {
  private ms = Date.UTC(2026, 9, 11, 10);
  nowMs(): number {
    this.ms += 1;
    return this.ms;
  }
}

const fresh = async (): Promise<LedgerHarness> => {
  const raw = await createTestDatabaseUpTo(31);
  await raw.exec(`create table ledger_test_state (label text not null)`);
  await raw.exec(`grant insert, select on ledger_test_state to app_user`);
  const db = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  const clock = new Clock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const runner = new KyselyTransactionRunner({
    db: db as never,
    outbox: new KyselyOutboxStore(db as never),
    clock,
    ids,
  });
  let giftCards = true;
  const projection = new InMemoryProjection();
  const service = new PostingService<LedgerDbTx>({
    store: new KyselyLedgerStore<LedgerDbTx>(),
    clock,
    ids,
    sha256: sha256Hex,
    flags: { giftCardSalesEnabled: () => giftCards },
  });
  const job = new IntegrityJob({
    snapshots: new KyselyIntegritySnapshots(db),
    projection,
    sha256: sha256Hex,
    pageSize: 2,
  });
  return {
    run: (fn) =>
      runner.run(
        { session: { userId: randomUUID(), role: "customer" }, process: "checkout.commit", profile: "default" },
        async (tx: DbTx) => {
          const ledgerTx = ledgerTxOf(tx);
          const bound: BoundPosting = {
            postCommand: (c) => service.postCommand(ledgerTx, c),
            reversal: (id) => service.reversal(ledgerTx, id),
            markState: async (label) => {
              await sql`insert into ledger_test_state (label) values (${label})`.execute(tx.db);
            },
            emitCaller: async (type) => {
              await tx.emit({ aggregateType: "order_group", aggregateId: randomUUID(), eventType: type, payload: {} });
            },
          };
          return fn(bound);
        },
      ),
    reads: new KyselyLedgerReadModel(db),
    setGiftCardFlag: (on) => {
      giftCards = on;
    },
    integrity: () => job.run(),
    committedState: async () => (await raw.query<{ label: string }>(`select label from ledger_test_state`)).rows.map((r) => r.label),
    outboxTypes: async () =>
      (await raw.query<{ t: string }>(`select event_type as t from outbox_events order by occurred_at, id`)).rows.map((r) => r.t),
    tamperPostingAmount: async (id) => {
      await raw.exec(`alter table postings disable trigger user`);
      await raw.query(`update postings set amount = amount + 1 where id = (select min(id) from postings where entry_id = $1)`, [id]);
      await raw.exec(`alter table postings enable trigger user`);
    },
    setProjection: (rows) => {
      projection.data.splice(0, projection.data.length, ...rows);
    },
  };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeLedgerContract("kysely/pglite", fresh);

describe("KyselyLedgerStore specifics", () => {
  it("the database refuses a hand-written unbalanced entry even if the application is bypassed", async () => {
    const raw = await createTestDatabaseUpTo(31);
    await raw.exec(`insert into ledger_accounts (type, owner_type, owner_id, sub_key, currency)
                    values ('psp_clearing','psp','paymob','','EGP'), ('platform_commission','platform','','','EGP')`);
    await raw.exec("begin");
    await raw.exec(`insert into journal_entries (id, kind, idempotency_key, occurred_at, ref_type, ref_id)
                    values ('00000000-0000-4000-8000-0000000000b1','x','bypass', now(),'t','1')`);
    await raw.exec(`insert into postings (entry_id, account_id, amount, currency)
                    select '00000000-0000-4000-8000-0000000000b1', id, 100, 'EGP' from ledger_accounts where type='psp_clearing'`);
    await expect(raw.exec("commit")).rejects.toThrow();
    await raw.exec("rollback").catch(() => undefined);
  });

  it("the chain table is append-only, refuses a fork, and RLS hides the ledger from non-finance roles", async () => {
    const raw = await createTestDatabaseUpTo(31);
    const db = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
    open.push(db);
    const reads = new KyselyLedgerReadModel(db);
    const clock = new Clock();
    const runner = new KyselyTransactionRunner({
      db: db as never,
      outbox: new KyselyOutboxStore(db as never),
      clock,
      ids: createIdGenerator(clock, nodeCsprng),
    });
    const service = new PostingService<LedgerDbTx>({
      store: new KyselyLedgerStore<LedgerDbTx>(),
      clock,
      ids: createIdGenerator(clock, nodeCsprng),
      sha256: sha256Hex,
      flags: { giftCardSalesEnabled: () => false },
    });
    await runner.run({ session: { userId: randomUUID(), role: "customer" }, process: "checkout.commit" }, (tx: DbTx) =>
      service.postCommand(ledgerTxOf(tx), orderCmd("og_x")),
    );
    await expect(raw.exec(`update ledger_entry_chain set prev_hash = repeat('a',64)`)).rejects.toThrow();
    await expect(raw.exec(`delete from ledger_entry_chain`)).rejects.toThrow();
    const head = await raw.query<{ prev_hash: string; entry_id: string }>(`select prev_hash, entry_id from ledger_entry_chain`);
    await raw.exec(`begin;
      insert into journal_entries (id, kind, idempotency_key, occurred_at, ref_type, ref_id)
        values ('00000000-0000-4000-8000-0000000000b2','x','fork', now(),'t','1');
      insert into postings (entry_id, account_id, amount, currency)
        select '00000000-0000-4000-8000-0000000000b2', id, 1, 'EGP' from ledger_accounts where type='psp_clearing';
      insert into postings (entry_id, account_id, amount, currency)
        select '00000000-0000-4000-8000-0000000000b2', id, -1, 'EGP' from ledger_accounts where type='platform_commission';
      commit;`);
    await expect(
      raw.query(`insert into ledger_entry_chain (entry_id, prev_hash, entry_hash)
                 values ('00000000-0000-4000-8000-0000000000b2', $1, repeat('b',64))`, [head.rows[0]?.prev_hash]),
    ).rejects.toThrow();
    const asCustomer = await reads.balances({ actorId: randomUUID(), role: "customer" as never }, { limit: 10 }).catch(() => []);
    expect(asCustomer).toEqual([]);
    expect(SCOPE.role).toBe("finance");
  });
});
