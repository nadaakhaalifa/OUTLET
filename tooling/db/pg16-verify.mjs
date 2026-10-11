// Real-Postgres checks that PGlite cannot do (single backend): run by run-on-postgres16.sh after
// every migration in packages/db/migrations has been applied. Uses node-postgres Pool with many
// real connections, logs in as a NOSUPERUSER NOBYPASSRLS role and SET LOCAL ROLE app_user, so RLS
// and grants are in force. Prints PASS/FAIL lines and exits non-zero on any failure.
//
// Env: PGPORT_X (required), API_PKG (path to apps/api/package.json, for resolving "pg"),
//      UNITS (100), ATTEMPTS (10000), CONNS (100)
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(process.env.API_PKG);
const { Pool, Client } = require("pg");

const PORT = Number(process.env.PGPORT_X);
const UNITS = Number(process.env.UNITS ?? 100);
const ATTEMPTS = Number(process.env.ATTEMPTS ?? 10000);
const CONNS = Number(process.env.CONNS ?? 100);
const cfg = { host: "127.0.0.1", port: PORT, database: "outlet" };

let pass = 0;
let fail = 0;
const ok = (m) => { pass += 1; console.log(`PASS  ${m}`); };
const bad = (m, d) => { fail += 1; console.log(`FAIL  ${m}`); if (d) console.log(`      ${d}`); };
const check = (cond, m, d) => (cond ? ok(m) : bad(m, d));

const hex = (n, w) => n.toString(16).padStart(w, "0");
const uuid = (ns, n) => `00000000-${hex(ns, 4)}-4000-8000-${hex(n, 12)}`;

const admin = new Client({ ...cfg, user: "postgres" });
await admin.connect();
const q = async (t, p) => (await admin.query(t, p)).rows;

const hasFn = async (name) => (await q("select count(*)::int n from pg_proc where proname = $1", [name]))[0].n > 0;
const hasTable = async (name) => (await q("select to_regclass($1) is not null as t", [`public.${name}`]))[0].t;

// App-style transaction: login role, SET LOCAL ROLE app_user, system app.role, 2 s statement timeout.
const appPool = new Pool({ ...cfg, user: "app_login", max: CONNS + 8 });
await Promise.all(Array.from({ length: CONNS + 8 }, () => appPool.query("select 1")));
async function tx(client, fn, role = "system", userId = "") {
  await client.query("begin");
  try {
    await client.query("set local role app_user");
    await client.query("select set_config('app.role',$1,true), set_config('app.user_id',$2,true), set_config('statement_timeout','5000',true)", [role, userId]);
    const r = await fn(client);
    await client.query("commit");
    return r;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
}
const withConn = async (fn) => { const c = await appPool.connect(); try { return await fn(c); } finally { c.release(); } };
const codeOf = (e) => (e && e.code ? String(e.code) : "unknown");

// ---------------------------------------------------------------- 1. inventory storm
console.log("== inventory: 100 units, 10000 reserve+claim attempts, pooled connections ==");
if (!(await hasFn("inventory_reserve"))) {
  bad("inventory functions present", "inventory_reserve missing: migration 0016 not applied");
} else {
  const USER = uuid(0x701, 1), LOC = uuid(0xa10, 1), STORE = uuid(0xa01, 1), STD = "00000000-0000-4000-8000-000000000501", POLICY = "00000000-0000-4000-8000-000000000601";
  await q("insert into users (id, status) values ($1,'active') on conflict do nothing", [USER]);
  await q("insert into locations (id, store_id, kind, name) values ($1,$2,'SELLER_WAREHOUSE','pg16') on conflict do nothing", [LOC, STORE]);
  const sku = uuid(0x1f00, 1);
  await q(`select inventory_apply_stock_sync($1::uuid,$2::uuid,$3::uuid,$4::uuid,'set',$5,'received','pg16-stock',null,null,'system','pg16',now())`, [sku, LOC, STD, STORE, UNITS]);
  const plan = JSON.stringify([{ sku_id: sku, location_id: LOC, pool_id: STD, store_id: STORE, qty: 1 }]);
  const fp = `${sku}:${LOC}:${STD}:1`;
  const tally = { claimed: 0, insufficient: 0, other: 0 };
  const errors = {};
  const lat = [];
  let next = 0;
  const t0 = performance.now();
  const worker = async () => {
    const c = await appPool.connect();
    try {
      for (;;) {
        const i = next++;
        if (i >= ATTEMPTS) return;
        const og = uuid(0x2f00, i + 1);
        try {
          const s = performance.now();
          const res = await tx(c, async (k) => (await k.query(
            "select inventory_reserve($1::uuid,$2::uuid,$3::uuid,$4::jsonb,600,$5::uuid,'CARD_WINDOW',$6,now()) as r",
            [uuid(0x3f00, i + 1), og, USER, plan, POLICY, fp])).rows[0].r);
          lat.push(performance.now() - s);
          if (res.status === "insufficient") { tally.insufficient += 1; continue; }
          if (res.status !== "reserved") { tally.other += 1; continue; }
          const cl = await tx(c, async (k) => (await k.query("select inventory_claim($1::uuid, now()) as r", [og])).rows[0].r);
          if (cl.status === "claimed") tally.claimed += 1; else tally.other += 1;
        } catch (e) {
          const k = codeOf(e);
          errors[k] = (errors[k] ?? 0) + 1;
        }
      }
    } finally { c.release(); }
  };
  await Promise.all(Array.from({ length: CONNS }, () => worker()));
  const secs = (performance.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  const p = (x) => lat[Math.min(lat.length - 1, Math.floor(lat.length * x))]?.toFixed(1);
  const st = (await q(`select count(*) filter (where state='CLAIMED')::int claimed, count(*) filter (where state='RESERVED')::int reserved,
      count(*) filter (where state='AVAILABLE')::int available from inventory_units where sku_id=$1`, [sku]))[0];
  const lvl = (await q("select on_hand, committed from inventory_levels where sku_id=$1", [sku]))[0];
  const errCount = Object.values(errors).reduce((a, b) => a + b, 0);
  console.log(`      attempts=${ATTEMPTS} conns=${CONNS} elapsed=${secs.toFixed(1)}s reserve p50=${p(0.5)}ms p95=${p(0.95)}ms p99=${p(0.99)}ms`);
  console.log(`      claimed=${tally.claimed} insufficient=${tally.insufficient} other=${tally.other} errors=${JSON.stringify(errors)}`);
  check(st.claimed === UNITS, `exactly ${UNITS} units claimed (got ${st.claimed})`);
  check(tally.claimed === UNITS && tally.insufficient === ATTEMPTS - UNITS && tally.other === 0 && errCount === 0,
    `client view: ${UNITS} claimed, ${ATTEMPTS - UNITS} insufficient, 0 other, 0 errors (deadlock/timeout)`,
    JSON.stringify({ tally, errors }));
  check(lvl.committed === st.claimed && lvl.on_hand === UNITS && st.reserved === 0 && st.available === 0,
    "levels consistent: committed = claimed, on_hand unchanged, no leaked reservations", JSON.stringify({ lvl, st }));
}

// ---------------------------------------------------------------- 2. cart save race
console.log("== cart: compare-and-set save race ==");
if (!(await hasTable("carts"))) bad("cart tables present", "0015 missing");
else {
  const u = uuid(0xc01, 1);
  await q("insert into users (id, status) values ($1,'active') on conflict do nothing", [u]);
  const cartId = uuid(0xc02, 1);
  await q("insert into carts (id, user_id, version) values ($1,$2,0)", [cartId, u]);
  const N = 40;
  // Same shape as KyselyCartRepository.save: CAS bump, then replace lines, all in one transaction.
  const save = (i) => withConn((c) => tx(c, async (k) => {
    const b = await k.query("update carts set version = version + 1 where id=$1 and user_id=$2 and version=0 returning id", [cartId, u]);
    if (b.rowCount === 0) return false;
    await k.query("delete from cart_lines where cart_id=$1", [cartId]);
    await k.query("insert into cart_lines (id, cart_id, sku_id, store_id, qty, price_at_add_amount) values ($1,$2,$3,$4,1,100)",
      [uuid(0xc03, i + 1), cartId, uuid(0xc04, i + 1), uuid(0xa01, 1)]);
    return true;
  }, "customer", u));
  const results = await Promise.allSettled(Array.from({ length: N }, (_, i) => save(i)));
  const won = results.filter((r) => r.status === "fulfilled" && r.value === true).length;
  const threw = results.filter((r) => r.status === "rejected");
  const lines = (await q("select count(*)::int n from cart_lines where cart_id=$1", [cartId]))[0].n;
  const ver = (await q("select version from carts where id=$1", [cartId]))[0].version;
  check(won === 1 && threw.length === 0 && lines === 1 && ver === 1,
    `${N} concurrent saves at version 0: exactly 1 wins, 1 line, version 1 (won=${won} threw=${threw.length} lines=${lines} version=${ver})`,
    threw[0] ? String(threw[0].reason) : "");
  // 50-line cap under concurrent direct inserts into one cart (trigger locks the parent row).
  await q("delete from cart_lines where cart_id=$1", [cartId]);
  const ins = await Promise.allSettled(Array.from({ length: 80 }, (_, i) => withConn((c) => tx(c, (k) =>
    k.query("insert into cart_lines (id, cart_id, sku_id, store_id, qty, price_at_add_amount) values ($1,$2,$3,$4,1,100)",
      [uuid(0xc05, i + 1), cartId, uuid(0xc06, i + 1), uuid(0xa01, 1)]), "customer", u))));
  const cnt = (await q("select count(*)::int n from cart_lines where cart_id=$1", [cartId]))[0].n;
  const rej = ins.filter((r) => r.status === "rejected");
  check(cnt === 50 && rej.length === 30 && rej.every((r) => codeOf(r.reason) === "23514"),
    `80 concurrent line inserts: exactly 50 stored, 30 rejected by cap (stored=${cnt} rejected=${rej.length}, codes=${[...new Set(rej.map((r) => codeOf(r.reason)))]})`);
  // getOrCreate race: unique(user_id) must collapse to one cart.
  const u2 = uuid(0xc01, 2);
  await q("insert into users (id, status) values ($1,'active') on conflict do nothing", [u2]);
  const goc = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => withConn((c) => tx(c, (k) =>
    k.query("insert into carts (id, user_id, version) values ($1,$2,0) on conflict (user_id) do nothing", [uuid(0xc07, i + 1), u2]), "customer", u2))));
  const carts = (await q("select count(*)::int n from carts where user_id=$1", [u2]))[0].n;
  check(carts === 1 && goc.every((r) => r.status === "fulfilled"), `20 concurrent getOrCreate: one cart, no errors (carts=${carts})`);
}

// ---------------------------------------------------------------- 3. frequency-cap reserve race
console.log("== notifications: frequency-cap reserve race ==");
if (!(await hasTable("notification_frequency_counters"))) bad("notification tables present", "0018 missing");
else {
  const CAP = 3;
  const day = "2026-10-10";
  // Same shape as KyselyFrequencyStore.reserve; `locked` toggles the advisory lock (negative control).
  const reserve = (user, locked) => withConn((c) => tx(c, async (k) => {
    if (locked) await k.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`notification_frequency:${user}:push`]);
    const n = (await k.query("select coalesce(sum(marketing_count),0)::int n from notification_frequency_counters where user_id=$1 and channel='push' and day >= $2::date", [user, day])).rows[0].n;
    if (n >= CAP) return false;
    await k.query(`insert into notification_frequency_counters (user_id, channel, day, marketing_count) values ($1,'push',$2::date,1)
      on conflict (user_id, channel, day) do update set marketing_count = notification_frequency_counters.marketing_count + 1`, [user, day]);
    return true;
  }, "system"));
  for (const locked of [true, false]) {
    const user = uuid(0xf01, locked ? 1 : 2);
    await q("insert into users (id, status) values ($1,'active') on conflict do nothing", [user]);
    const r = await Promise.allSettled(Array.from({ length: 60 }, () => reserve(user, locked)));
    const admitted = r.filter((x) => x.status === "fulfilled" && x.value === true).length;
    const errs = r.filter((x) => x.status === "rejected").length;
    const stored = (await q("select coalesce(sum(marketing_count),0)::int n from notification_frequency_counters where user_id=$1", [user]))[0].n;
    if (locked) check(admitted === CAP && stored === CAP && errs === 0, `with advisory lock: 60 concurrent reserves, cap ${CAP}: admitted=${admitted} stored=${stored} errors=${errs}`);
    else console.log(`INFO  negative control (no advisory lock): admitted=${admitted} stored=${stored} errors=${errs} (> ${CAP} shows the test can detect the race)`);
  }
}

// ---------------------------------------------------------------- 4. push token uniqueness
console.log("== notifications: push-token uniqueness ==");
if (!(await hasTable("notification_push_tokens"))) bad("push token table present", "0018 missing");
else {
  const upsert = (user, install, token) => withConn((c) => tx(c, async (k) => {
    await k.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [token]); // mirrors KyselyPushTokenRepository.upsert
    await k.query(`update notification_push_tokens set deactivated_at = now(), updated_at = now()
      where token = $1 and deactivated_at is null and not (user_id = $2 and install_id = $3)`, [token, user, install]);
    await k.query(`insert into notification_push_tokens (user_id, install_id, platform, token, updated_at) values ($1,$2,'ios',$3,now())
      on conflict (user_id, install_id) do update set platform = excluded.platform, token = excluded.token, deactivated_at = null, updated_at = excluded.updated_at`,
    [user, install, token]);
  })); // system role, as KyselyPushTokenRepository (inTx sets app.role=system); a customer role cannot see the other owner's row under RLS
  const token = "ExponentPushToken[race-token-0001]";
  const users = Array.from({ length: 20 }, (_, i) => uuid(0xe01, i + 1));
  for (const u of users) await q("insert into users (id, status) values ($1,'active') on conflict do nothing", [u]);
  const r = await Promise.allSettled(users.map((u, i) => upsert(u, uuid(0xe02, i + 1), token)));
  const active = (await q("select count(*)::int n from notification_push_tokens where md5(token)=md5($1) and deactivated_at is null", [token]))[0].n;
  const codes = {};
  r.filter((x) => x.status === "rejected").forEach((x) => { const k = codeOf(x.reason); codes[k] = (codes[k] ?? 0) + 1; });
  check(active <= 1, `20 users register the same token concurrently: at most one active row (active=${active})`);
  const rejected = Object.values(codes).reduce((a, b) => a + b, 0);
  check(rejected === 0, `no registration surfaced a unique-violation to the caller (rejected=${rejected} codes=${JSON.stringify(codes)})`,
    rejected ? "upsert is update-then-insert under READ COMMITTED: the loser of the race gets 23505 and the caller sees an error instead of a retry/hand-over" : "");
  // one user, same install: idempotent repeat
  const same = await Promise.allSettled(Array.from({ length: 20 }, () => upsert(users[0], uuid(0xe02, 1), "ExponentPushToken[same-0002]")));
  const rows = (await q("select count(*)::int n from notification_push_tokens where user_id=$1 and install_id=$2", [users[0], uuid(0xe02, 1)]))[0].n;
  check(rows === 1 && same.every((x) => x.status === "fulfilled"), `20 concurrent re-registrations of one (user, install): one row, no errors (rows=${rows})`);
}

// ---------------------------------------------------------------- 5. referral reward cap race
console.log("== referrals: reward cap race (cap 2, 6 concurrent settles) ==");
if (!(await hasTable("referrals"))) bad("referral tables present", "0026 missing");
else {
  const CAP = 2;
  const settleOnce = (referralId, referrerId, msg, locked, consumer) => withConn((c) => tx(c, async (k) => {
    // Same shape as KyselyReferralStore.settle: inbox row, per-referrer advisory lock, recount, guarded update.
    const seen = await k.query("insert into inbox_processed (consumer, message_id) values ($1,$2::uuid) on conflict do nothing returning message_id", [consumer, msg]);
    if (seen.rowCount === 0) return "duplicate";
    let status = "rewarded", reason = null, amount = 10000;
    if (locked) await k.query("select pg_advisory_xact_lock(hashtext($1))", ["referrals:" + referrerId]);
    const n = (await k.query("select count(*) filter (where settled_at >= now() - interval '365 days')::int n from referrals where referrer_id=$1 and status='rewarded'", [referrerId])).rows[0].n;
    if (n >= CAP) { status = "rejected"; reason = "cap_reached"; amount = null; }
    const u = await k.query(`update referrals set status=$2, reject_reason=$3, reward_amount=$4::bigint, reward_currency=$5, settled_at=now()
      where id=$1 and status='attributed' returning id`, [referralId, status, reason, amount, amount === null ? null : "EGP"]);
    return u.rowCount === 0 ? "already" : status;
  }, "system"));
  for (const locked of [true, false]) {
    const t = locked ? 1 : 2;
    const referrer = uuid(0xd01, t);
    await q("insert into users (id, status) values ($1,'active') on conflict do nothing", [referrer]);
    const codeId = uuid(0xd02, t);
    const code = locked ? "ABCDEFGH" : "JKMNPQRS";
    await q("insert into referral_codes (id, owner_user_id, code) values ($1,$2,$3)", [codeId, referrer, code]);
    const refs = [];
    for (let i = 0; i < 6; i += 1) {
      const referee = uuid(0xd03, t * 100 + i);
      const rid = uuid(0xd04, t * 100 + i);
      await q("insert into users (id, status) values ($1,'active') on conflict do nothing", [referee]);
      await q("insert into referrals (id, code_id, referrer_id, referee_id, status) values ($1,$2,$3,$4,'attributed')", [rid, codeId, referrer, referee]);
      refs.push(rid);
    }
    const r = await Promise.allSettled(refs.map((rid, i) => settleOnce(rid, referrer, uuid(0xd05, t * 100 + i), locked, "referrals.pg16")));
    const errs = r.filter((x) => x.status === "rejected");
    const rows = (await q("select status, count(*)::int n from referrals where referrer_id=$1 group by status", [referrer]));
    const by = Object.fromEntries(rows.map((x) => [x.status, x.n]));
    if (locked) check((by.rewarded ?? 0) === CAP && (by.rejected ?? 0) === 6 - CAP && errs.length === 0,
      `cap ${CAP}, 6 concurrent settles with advisory lock: rewarded=${by.rewarded ?? 0} rejected=${by.rejected ?? 0} errors=${errs.length}`, errs[0] ? String(errs[0].reason) : "");
    else console.log(`INFO  negative control (no advisory lock): rewarded=${by.rewarded ?? 0} rejected=${by.rejected ?? 0} errors=${errs.length} (> ${CAP} rewarded shows the race is observable)`);
    if (locked) {
      // Re-delivery of the same message ids must change nothing (inbox dedupe).
      const again = await Promise.allSettled(refs.map((rid, i) => settleOnce(rid, referrer, uuid(0xd05, t * 100 + i), true, "referrals.pg16")));
      const dup = again.filter((x) => x.status === "fulfilled" && x.value === "duplicate").length;
      check(dup === 6, `redelivered messages are all deduplicated by the inbox (duplicates=${dup})`);
    }
  }
}

// ---------------------------------------------------------------- 6. wishlist cross-owner save
console.log("== wishlists: cross-owner save ==");
if (!(await hasTable("wishlist_items"))) bad("wishlist tables present", "0014 missing");
else {
  const A = uuid(0xb01, 1), B = uuid(0xb01, 2), WL = uuid(0xb02, 1), WLB = uuid(0xb02, 2);
  for (const u of [A, B]) await q("insert into users (id, status) values ($1,'active') on conflict do nothing", [u]);
  await q("insert into wishlists (id, user_id, intent, title) values ($1,$2,'need','a'),($3,$4,'need','b')", [WL, A, WLB, B]);
  const item = (id, wl, owner, who, role = "customer") => withConn((c) => tx(c, (k) => k.query(
    "insert into wishlist_items (id, wishlist_id, user_id, product_id, added_amount) values ($1,$2,$3,$4,100)",
    [id, wl, owner, uuid(0xb03, 1)]), role, who));
  const attempt = async (label, fn, wantCode) => {
    try { await fn(); bad(label, "insert succeeded"); } catch (e) { check(codeOf(e) === wantCode, `${label} -> ${codeOf(e)}`, `want ${wantCode}: ${e.message}`); }
  };
  await attempt("B inserts item into A's wishlist claiming owner A (RLS WITH CHECK)", () => item(uuid(0xb04, 1), WL, A, B), "42501");
  await attempt("B inserts item into A's wishlist claiming owner B (composite FK)", () => item(uuid(0xb04, 2), WL, B, B), "23503");
  await attempt("system inserts item with mismatched owner (composite FK still holds)", () => item(uuid(0xb04, 3), WL, B, "", "system"), "23503");
  const own = await item(uuid(0xb04, 4), WL, A, A).then(() => true, () => false);
  check(own, "owner A can save into own wishlist");
  const seen = await withConn((c) => tx(c, async (k) => (await k.query("select count(*)::int n from wishlist_items where wishlist_id=$1", [WL])).rows[0].n, "customer", B));
  check(seen === 0, `B sees 0 items of A's wishlist (saw ${seen})`);
  const upd = await withConn((c) => tx(c, async (k) => (await k.query("update wishlist_items set note='pwn' where wishlist_id=$1", [WL])).rowCount, "customer", B));
  const del = await withConn((c) => tx(c, async (k) => (await k.query("delete from wishlist_items where wishlist_id=$1", [WL])).rowCount, "customer", B));
  check(upd === 0 && del === 0, `B cannot update or delete A's items (updated=${upd} deleted=${del})`);
  const still = (await q("select count(*)::int n from wishlist_items where wishlist_id=$1 and note is distinct from 'pwn'", [WL]))[0].n;
  check(still === 1, "A's item is intact");
  const race = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => withConn((c) => tx(c, (k) => k.query(
    "insert into wishlist_items (id, wishlist_id, user_id, product_id, added_amount) values ($1,$2,$3,$4,100)",
    [uuid(0xb04, 100 + i), WL, B, uuid(0xb05, i + 1)]), "customer", B))));
  check(race.every((x) => x.status === "rejected" && codeOf(x.reason) === "23503"), "20 concurrent cross-owner saves all rejected");
}

await appPool.end();
await admin.end();

// ---------------------------------------------------------------- 7. RLS: other tenant sees nothing
// Done in a throw-away copy of the database so that CHECK constraints can be dropped to seed
// one synthetic row per table (triggers and FKs are skipped with session_replication_role=replica).
console.log("== RLS: foreign tenant ids see nothing (stores, orders, returns, analytics, money tables) ==");
{
  const sys = new Client({ ...cfg, database: "postgres", user: "postgres" });
  await sys.connect();
  await sys.query("drop database if exists outlet_rls");
  await sys.query("create database outlet_rls template outlet");
  await sys.end();
  const seed = new Client({ ...cfg, database: "outlet_rls", user: "postgres" });
  await seed.connect();
  const TENANT_USER = uuid(0x9a01, 1), TENANT_STORE = uuid(0x9a02, 1);
  const OTHER_USER = uuid(0x9b01, 1), OTHER_STORE = uuid(0x9b02, 1);
  const TARGETS = ["stores", "store_activity_events", "user_favorite_stores", "order_groups", "seller_orders", "order_lines", "order_buyer_contacts",
    "order_status_history", "returns", "return_evidence", "return_disputes", "returner_standing", "seller_analytics_facts", "seller_analytics_stock",
    "seller_analytics_freshness", "shipments", "tax_documents", "carts", "cart_lines", "wishlists", "referrals", "refunds", "credit_lots",
    "payment_intents", "checkout_sagas", "reviews", "promotion_redemptions", "size_profiles", "saved_searches", "notification_preferences",
    "dsar_requests", "inventory_levels", "price_claims"];
  const present = (await seed.query("select table_name from information_schema.tables where table_schema='public' and table_name = any($1)", [TARGETS])).rows.map((r) => r.table_name);
  const missing = TARGETS.filter((t) => !present.includes(t));
  if (missing.length) console.log(`INFO  tables not present (skipped): ${missing.join(", ")}`);
  // Drop CHECK constraints in the copy so one generic row can be inserted per table.
  for (const r of (await seed.query(`select conrelid::regclass::text t, conname from pg_constraint where contype='c' and connamespace='public'::regnamespace and conrelid::regclass::text = any($1)`, [present])).rows)
    await seed.query(`alter table ${r.t} drop constraint "${r.conname}"`);
  const userCols = new Set(["user_id", "owner_user_id", "buyer_id", "customer_id", "actor_user_id", "author_id", "reviewer_id", "referrer_id", "subject_user_id"]);
  const storeCols = new Set(["store_id", "seller_id", "seller_store_id"]);
  const val = (col, type, n, t = "") => {
    if (t === "stores" && col === "id") return `'${TENANT_STORE}'`;
    if (userCols.has(col)) return `'${TENANT_USER}'`;
    if (storeCols.has(col)) return `'${TENANT_STORE}'`;
    if (col === "id" && type === "uuid") return `'${uuid(0x9c01, n)}'`;
    switch (type) {
      case "uuid": return `'${uuid(0x9c02, n)}'`;
      case "boolean": return "false";
      case "smallint": case "integer": case "bigint": case "numeric": return "1";
      case "timestamp with time zone": case "timestamp without time zone": return "now()";
      case "date": return "current_date";
      case "jsonb": case "json": return "'{}'";
      case "bytea": return "'\\x00'";
      case "ARRAY": return "'{}'";
      case "inet": return "'127.0.0.1'";
      case "interval": return "'1 day'";
      default: return "'x'";
    }
  };
  let n = 0;
  const seeded = [];
  await seed.query("set session_replication_role = replica");
  for (const t of present) {
    const cols = (await seed.query(`select column_name, data_type, udt_name, column_default, is_nullable, is_generated, identity_generation from information_schema.columns
      where table_schema='public' and table_name=$1 order by ordinal_position`, [t])).rows;
    const pick = cols.filter((c) => c.is_generated !== "ALWAYS" && c.identity_generation === null && c.udt_name !== "tsvector" &&
      (c.is_nullable === "NO" && c.column_default === null || userCols.has(c.column_name) || storeCols.has(c.column_name) || c.column_name === "id"));
    n += 1;
    const colsSql = pick.map((c) => `"${c.column_name}"`).join(",");
    const valsSql = pick.map((c) => {
      if (c.data_type === "USER-DEFINED") return `(select enumlabel from pg_enum e join pg_type ty on ty.oid=e.enumtypid where ty.typname='${c.udt_name}' limit 1)::${c.udt_name}`;
      return val(c.column_name, c.data_type === "character" ? "text" : c.data_type, n, t);
    }).join(",");
    try {
      await seed.query(pick.length ? `insert into ${t} (${colsSql}) values (${valsSql})` : `insert into ${t} default values`);
      seeded.push(t);
    } catch (e) { console.log(`INFO  could not seed ${t}: ${e.message}`); }
  }
  await seed.query("set session_replication_role = origin");
  const total = {};
  for (const t of seeded) total[t] = (await seed.query(`select count(*)::int n from ${t}`)).rows[0].n;
  await seed.end();
  const app = new Pool({ host: "127.0.0.1", port: PORT, database: "outlet_rls", user: "app_login", max: 4 });
  const asTenant = async (t, role, user, stores) => {
    const c = await app.connect();
    try {
      await c.query("begin");
      await c.query("set local role app_user");
      await c.query("select set_config('app.role',$1,true), set_config('app.user_id',$2,true), set_config('app.store_ids',$3,true)", [role, user, stores]);
      const r = await c.query(`select count(*)::int n from ${t}`);
      await c.query("rollback");
      return r.rows[0].n;
    } catch (e) { await c.query("rollback").catch(() => {}); return `ERR ${codeOf(e)} ${e.message}`; } finally { c.release(); }
  };
  const leaks = [];
  const publicByDesign = new Set();
  for (const t of seeded) {
    if (total[t] === 0) continue;
    const foreignCust = await asTenant(t, "customer", OTHER_USER, OTHER_STORE);
    const foreignSeller = await asTenant(t, "seller", OTHER_USER, OTHER_STORE);
    const anon = await asTenant(t, "", "", "");
    const own = await asTenant(t, "customer", TENANT_USER, TENANT_STORE);
    const ownSeller = await asTenant(t, "seller", TENANT_USER, TENANT_STORE);
    const bad1 = [foreignCust, foreignSeller, anon].some((v) => v !== 0);
    console.log(`      ${t.padEnd(28)} rows=${total[t]} foreign-customer=${foreignCust} foreign-seller=${foreignSeller} anonymous=${anon} | owner=${own} own-store=${ownSeller}`);
    if (bad1) leaks.push(`${t}: customer=${foreignCust} seller=${foreignSeller} anon=${anon}`);
    else publicByDesign.add(t);
  }
  check(seeded.length > 0, `seeded ${seeded.length} of ${present.length} present tables with one synthetic row each`);
  check(leaks.length === 0, `no table leaks a row to a foreign customer, foreign seller or anonymous session (${publicByDesign.size} tables checked)`, leaks.join("; "));
  await app.end();
  const sys2 = new Client({ ...cfg, database: "postgres", user: "postgres" });
  await sys2.connect();
  await sys2.query("drop database if exists outlet_rls");
  await sys2.end();
}

console.log(`\nnode checks: passed=${pass} failed=${fail}`);
process.exit(fail === 0 ? 0 : 1);
