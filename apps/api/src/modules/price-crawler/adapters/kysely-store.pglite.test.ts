import { afterAll, beforeAll } from "vitest";
import { KyselyCrawlStore, type CrawlDb } from "./kysely-store";
import { createCrawlerDatabase, type PgliteLike } from "../test/pglite-db";
import { runCrawlStoreContract } from "../test/repository-contract";

let pg: PgliteLike;
let db: CrawlDb;
let n = 0;
beforeAll(async () => {
  ({ pg, db } = await createCrawlerDatabase());
}, 60_000);
afterAll(async () => {
  await db.destroy();
});

runCrawlStoreContract("Postgres (PGlite)", async () => {
  // Child tables first; incidents and config changes are append-only (forbid_mutation), so they stay.
  await pg.exec(`delete from product_matches; delete from channel_connections;`);
  await pg.exec(`select set_config('app.role', 'system', false)`);
  for (const t of ["channel_snapshots", "crawl_targets"]) await pg.exec(`delete from ${t}`).catch(() => undefined);
  await pg.exec(`update matching_config set tau_bp = 9200, shadow_only = true, version = 1 where id = 1`);
  const baseline = (await pg.query<{ n: string }>(`select count(*)::text as n from outbox_events`)).rows[0]?.n ?? "0";
  const store = new KyselyCrawlStore(db, { uuidV7: () => `00000000-0000-7000-8000-${String(800_000 + ++n).padStart(12, "0")}` });
  return {
    store,
    eventTypes: async () => {
      const r = await pg.query<{ event_type: string }>(`select event_type from outbox_events order by occurred_at, id offset ${Number(baseline)}`);
      return r.rows.map((x) => x.event_type);
    },
  };
});
