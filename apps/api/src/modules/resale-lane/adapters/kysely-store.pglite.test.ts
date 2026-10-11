import { afterAll, beforeAll } from "vitest";
import { KyselyResaleStore, type ResaleDb } from "./kysely-store";
import { createResaleDatabase, type PgliteLike } from "../test/pglite-db";
import { runResaleStoreContract } from "../test/repository-contract";

let pg: PgliteLike;
let db: ResaleDb;
let n = 0;
beforeAll(async () => {
  ({ pg, db } = await createResaleDatabase());
}, 60_000);
afterAll(async () => {
  await db.destroy();
});

runResaleStoreContract("Postgres (PGlite)", async () => {
  await pg.exec(`delete from resale_proceeds; delete from resale_listings;`);
  const baseline = (await pg.query<{ n: string }>(`select count(*)::text as n from outbox_events`)).rows[0]?.n ?? "0";
  const store = new KyselyResaleStore(db, { uuidV7: () => `00000000-0000-7000-8000-${String(700_000 + ++n).padStart(12, "0")}` });
  return {
    store,
    ensureUser: async (id) => {
      await pg.query(`insert into users (id, status) values ($1,'active') on conflict (id) do nothing`, [id]);
    },
    eventTypes: async () => {
      const r = await pg.query<{ event_type: string }>(`select event_type from outbox_events order by occurred_at, id offset ${Number(baseline)}`);
      return r.rows.map((x) => x.event_type);
    },
  };
});
