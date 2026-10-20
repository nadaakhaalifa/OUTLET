import { afterAll, describe, expect, it } from "vitest";
import { InMemoryGiftCardStore } from "../adapters/in-memory";
import { KyselyGiftCardStore, type GiftCardDb } from "../adapters/kysely-store";
import { createGiftCardDatabase } from "./pglite-db";
import { describeGiftCardStoreContract } from "./repository-contract";

const open: GiftCardDb[] = [];
let n = 0;
const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}` };

describeGiftCardStoreContract("in-memory", async () => {
  const store = new InMemoryGiftCardStore();
  return { store, ensureUser: async () => undefined, outboxCount: async () => store.outbox.length };
});

describeGiftCardStoreContract("kysely/pglite", async () => {
  const { pg, db } = await createGiftCardDatabase();
  open.push(db);
  return {
    store: new KyselyGiftCardStore(db, ids),
    ensureUser: async (id: string) => {
      await pg.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
    outboxCount: async () => Number((await pg.query<{ n: string }>(`select count(*)::text as n from outbox_events`)).rows[0]?.n),
  };
});

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describe("kysely store specifics", () => {
  it("opens a database with the 0037 schema", async () => {
    const { pg, db } = await createGiftCardDatabase();
    open.push(db);
    const r = await pg.query<{ n: string }>(`select count(*)::text as n from information_schema.tables where table_name like 'gift_%'`);
    expect(Number(r.rows[0]?.n)).toBe(5);
  });
});
