#!/usr/bin/env node
// ADR-0005 / master prompt 20.2 acceptance: N concurrent reserve+claim attempts on U units -> exactly U claimed, 0 oversold,
// no deadlocks. Needs REAL Postgres (PGlite is one connection; SKIP LOCKED contention cannot happen there). NOT run in CI here.
//
//   DATABASE_URL=postgres://owner@host/db  (migrated through 0013; used to seed and verify)
//   APP_DATABASE_URL=postgres://outlet_app@host/db  (optional; the attempts run as the RLS-bound app role, default DATABASE_URL)
//   UNITS=100 CONCURRENCY=10000 RUNS=1 POOL_SIZE=50 node packages/inventory/scripts/oversell-stress.mjs
//
// The attempt SQL is a copy of RESERVE_PICK_SQL (src/application/pool.ts) plus the claim statements of ReservationService.claimIn;
// a script cannot import the TypeScript sources. Keep them in sync (the unit tests pin the SQL through the service).
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(import.meta.dirname, "../../../apps/api/package.json"));
const pg = require("pg");

const UNITS = Number(process.env.UNITS ?? 100);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 10000);
const RUNS = Number(process.env.RUNS ?? 1);
const POOL_SIZE = Number(process.env.POOL_SIZE ?? 50);
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const app = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL, max: POOL_SIZE, application_name: "checkout.reserve" });
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const PICK = `WITH picked AS (SELECT id FROM inventory_units WHERE sku_id = $1 AND location_id = $2 AND state = 'available'
  ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
UPDATE inventory_units u SET state = 'reserved', reservation_id = $3, expires_at = now() + interval '10 minutes'
FROM picked WHERE u.sku_id = $1 AND u.location_id = $2 AND u.id = picked.id RETURNING u.id`;

const seed = async () => {
  const ids = { seller: randomUUID(), store: randomUUID(), loc: randomUUID(), product: randomUUID(), sku: randomUUID() };
  const q = (s, p) => admin.query(s, p);
  await q(`INSERT INTO sellers (id, home_market_id, market_id, legal_type, status) VALUES ($1,'EG','EG','sole_trader','draft')`, [ids.seller]);
  await q(`INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, kind, ships_from_country, status) VALUES ($1,$2,'EG',$3,'متجر','local','EG','ACTIVE')`, [ids.store, ids.seller, `stress-${ids.store.slice(0, 8)}`]);
  await q(`INSERT INTO inventory_locations (id, market_id, store_id) VALUES ($1,'EG',$2)`, [ids.loc, ids.store]);
  await q(`INSERT INTO products (id, store_id, market_id, primary_category_id, condition_grade_code) VALUES ($1,$2,'EG','00000000-0000-4000-8000-0000000c0011','new_with_tags')`, [ids.product, ids.store]);
  await q(`INSERT INTO skus (id, product_id, store_id, market_id, seller_sku, price_minor, currency) VALUES ($1,$2,$3,'EG',$4,10000,'EGP')`, [ids.sku, ids.product, ids.store, `S-${ids.sku}`]);
  await q(`INSERT INTO inventory_levels (sku_id, location_id, store_id, market_id, on_hand) VALUES ($1,$2,$3,'EG',$4)`, [ids.sku, ids.loc, ids.store, UNITS]);
  await q(`INSERT INTO inventory_units (sku_id, location_id, id, store_id, market_id) SELECT $1,$2,gen_random_uuid(),$3,'EG' FROM generate_series(1,$4)`, [ids.sku, ids.loc, ids.store, UNITS]);
  return ids;
};

const attempt = async (ids) => {
  const c = await app.connect();
  const user = randomUUID();
  const res = randomUUID();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('statement_timeout','2000',true)");
    // user context first (reservation row), then the store context for the stock rows, exactly as the service does
    await c.query(`SELECT set_config('app.ctx','user',true), set_config('app.current_market_id','EG',true), set_config('app.current_user_id',$1,true), set_config('app.current_store_id','',true)`, [user]);
    await c.query(`INSERT INTO reservations (id, market_id, user_id, order_group_ref, expires_at, store_ids) VALUES ($1,'EG',$2,$3, now() + interval '10 minutes', ARRAY[$4]::uuid[])`, [res, user, res, ids.store]);
    await c.query(`SELECT set_config('app.ctx','store',true), set_config('app.current_store_id',$1,true)`, [ids.store]);
    const got = (await c.query(PICK, [ids.sku, ids.loc, res])).rowCount;
    if (got !== 1) { await c.query("ROLLBACK"); return "sold_out"; }
    await c.query("UPDATE inventory_units SET state = 'claimed', expires_at = NULL WHERE sku_id = $1 AND location_id = $2 AND reservation_id = $3 AND state = 'reserved'", [ids.sku, ids.loc, res]);
    await c.query("UPDATE inventory_levels SET committed = committed + 1 WHERE sku_id = $1 AND location_id = $2", [ids.sku, ids.loc]);
    await c.query("COMMIT");
    return "claimed";
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    return e.code === "40P01" ? "deadlock" : `error:${e.code ?? e.message}`;
  } finally {
    c.release();
  }
};

let failed = false;
for (let run = 1; run <= RUNS; run++) {
  const ids = await seed();
  const t0 = Date.now();
  const out = await Promise.all(Array.from({ length: CONCURRENCY }, () => attempt(ids)));
  const tally = out.reduce((m, r) => ((m[r] = (m[r] ?? 0) + 1), m), {});
  const s = (await admin.query(`SELECT (count(*) FILTER (WHERE state='claimed'))::int claimed, (count(*) FILTER (WHERE state='reserved'))::int reserved, (count(*) FILTER (WHERE state='available'))::int available,
    (SELECT committed FROM inventory_levels WHERE sku_id = $1) committed FROM inventory_units WHERE sku_id = $1`, [ids.sku])).rows[0];
  const expectClaimed = Math.min(UNITS, CONCURRENCY);
  const ok = s.claimed === expectClaimed && s.committed === expectClaimed && s.reserved === 0 && !tally.deadlock && !Object.keys(tally).some((k) => k.startsWith("error"));
  console.log(`run ${run}/${RUNS} ${ok ? "PASS" : "FAIL"} ${Date.now() - t0}ms`, JSON.stringify({ tally, db: s }));
  failed ||= !ok;
}
await app.end();
await admin.end();
process.exit(failed ? 1 : 0);
