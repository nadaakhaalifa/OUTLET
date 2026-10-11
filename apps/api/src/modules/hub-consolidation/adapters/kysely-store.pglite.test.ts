import { afterAll, beforeAll } from "vitest";
import { KyselyHubStore } from "./kysely-store";
import { createHubResaleDatabase, type PgliteLike } from "../test/pglite-db";
import { runHubStoreContract } from "../test/repository-contract";
import type { HubDb } from "./kysely-store";

let pg: PgliteLike;
let db: HubDb;
let n = 0;
beforeAll(async () => {
  ({ pg, db } = await createHubResaleDatabase());
}, 60_000);
afterAll(async () => {
  await db.destroy();
});

runHubStoreContract("Postgres (PGlite)", async () => {
  await pg.exec(
    `truncate hub_receipts, hub_legs, consolidated_shipments, hub_order_groups, hubs restart identity cascade`,
  ).catch(async () => {
    await pg.exec(`delete from hub_receipts; update hub_legs set consolidation_id = null; delete from hub_legs; delete from consolidated_shipments; delete from hub_order_groups; delete from hubs;`);
  });
  // The outbox guard forbids deleting unpublished rows: count only what this test writes.
  const baseline = (await pg.query<{ n: string }>(`select count(*)::text as n from outbox_events`)).rows[0]?.n ?? "0";
  const store = new KyselyHubStore(db, {
    uuidV7: () => `00000000-0000-7000-8000-${String(900_000 + ++n).padStart(12, "0")}`,
  });
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
