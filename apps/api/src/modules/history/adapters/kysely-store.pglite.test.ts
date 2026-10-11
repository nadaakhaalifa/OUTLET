import { afterAll, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { KyselyHistoryStore, type HistoryDb } from "./kysely-store";
import { createDatabase } from "../test/pglite-db";
import { describeHistoryStoreContract } from "../test/repository-contract";

const open: HistoryDb[] = [];
let seq = 0;
const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(100_000 + ++seq).padStart(12, "0")}` };

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeHistoryStoreContract("kysely/pglite", async () => {
  const { pg, db } = await createDatabase();
  open.push(db);
  return {
    store: new KyselyHistoryStore(db, ids),
    ensureUser: async (id: string) => {
      await pg.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
    outboxTypes: async () => (await pg.query<{ event_type: string }>(`select event_type from outbox_events order by id`)).rows.map((r) => r.event_type),
  };
});
