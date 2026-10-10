#!/usr/bin/env bash
# Concurrency proof for row-per-unit inventory (ADR-0005, spec 20.2) against a REAL, throw-away
# PostgreSQL 16 cluster. PGlite cannot do this: it is a single backend, so SKIP LOCKED, advisory
# locks and deadlock behaviour are not exercised there.
#
#   tooling/db/inventory-concurrency.sh
#
# What it does
#   1. initdb + start a cluster in a scratch directory (127.0.0.1 only, trust auth, random port)
#   2. applies migrations 0001..0011 and 0016 (the dependency set of inventory)
#   3. RUNS times (default 24): stock a fresh SKU with 100 units, then fire ATTEMPTS (default
#      10000) reserve attempts through CONNS (default 100) real connections, each followed by a
#      claim (or, in churn mode, a release for one in three). Asserts after every run.
#   4. greps the server log for "deadlock detected", counts SQLSTATE 40P01 / 57014 in clients
#   5. stops the cluster and deletes the scratch directory
#
# Run modes (cycled):
#   A  pool materialised before the storm        exact: 100 claimed, 9900 insufficient
#   B  pool NOT materialised (inline replenish)  exact: 100 claimed, 9900 insufficient
#   C  churn: one in three reservations released  safety only: <= 100 claimed, nothing leaked
#   D  sweeper storm: a sweeper loop treats every reservation as expired while claims race it,
#      so claims land as claimed, claimed_late or unavailable   safety only, same invariants
#   E  seller sync storm: a worker re-asserts on_hand=100 with fresh keys (and the pool-repair job
#      runs) while the storm is in flight   exact: 100 claimed, 9900 insufficient
#
# Env: PG_BIN, SCRATCH (parent of the cluster dir), RUNS, ATTEMPTS, CONNS, KEEP=1 keeps the cluster.
# This is evidence for the locking design on one machine. It is NOT a production load test and
# does not make the design "production verified".
set -u -o pipefail

# PG_BIN: explicit env wins; else the first PostgreSQL 16 bin dir found (Linux package, Postgres.app).
if [ -z "${PG_BIN:-}" ]; then
  for c in /usr/lib/postgresql/16/bin /Applications/Postgres.app/Contents/Versions/16/bin \
           /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@16/bin; do
    if [ -x "$c/initdb" ]; then PG_BIN="$c"; break; fi
  done
fi
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS="$ROOT/packages/db/migrations"
SCRATCH="${SCRATCH:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}}"
RUNS="${RUNS:-25}"
ATTEMPTS="${ATTEMPTS:-10000}"
CONNS="${CONNS:-100}"
UNITS=100

mkdir -p "$SCRATCH" || exit 2
WORK_DIR="$(mktemp -d "$SCRATCH/inventory-conc.XXXXXX")"
DATA="$WORK_DIR/data"
PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"

for b in initdb pg_ctl psql; do
  [ -x "$PG_BIN/$b" ] || { echo "missing $PG_BIN/$b"; rm -rf "$WORK_DIR"; exit 2; }
done

cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then echo "kept $WORK_DIR (port $PORT, server left running)"; return; fi
  "$PG_BIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
  echo "cluster stopped and $WORK_DIR deleted"
}
trap cleanup EXIT

P() { "$PG_BIN/psql" -X -q -h 127.0.0.1 -p "$PORT" -U postgres "$@"; }
PA() { "$PG_BIN/psql" -X -q -At -h 127.0.0.1 -p "$PORT" -U postgres -d outlet "$@"; }

echo "== cluster =="
"$PG_BIN/initdb" -D "$DATA" -U postgres --auth=trust --encoding=UTF8 --locale=C >/dev/null || exit 2
"$PG_BIN/pg_ctl" -D "$DATA" \
  -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c max_connections=$((CONNS + 60)) -c deadlock_timeout=200ms -c log_lock_waits=on" \
  -w -l "$WORK_DIR/pg.log" start >/dev/null || { cat "$WORK_DIR/pg.log"; exit 2; }
P -d postgres -c 'CREATE DATABASE outlet' >/dev/null || exit 2
echo "server: $(PA -c 'SHOW server_version') port $PORT max_connections $(PA -c 'SHOW max_connections')"
case "$(PA -c 'SHOW server_version_num')" in 16*) ;; *) echo "not PostgreSQL 16"; exit 2 ;; esac

echo "== migrations (0001..0011, 0016) =="
FILES="$(ls "$MIGRATIONS"/00[01][0-9]_*.sql | sort | grep -E '/00(0[1-9]|1[01]|16)_')"
for f in $FILES; do
  base="$(basename "$f")"
  if grep -Eq '^--[[:space:]]*no-transaction[[:space:]]*$' "$f"; then
    P -d outlet -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>"$WORK_DIR/err" || { echo "FAIL $base: $(cat "$WORK_DIR/err")"; exit 1; }
  else
    P -d outlet -v ON_ERROR_STOP=1 --single-transaction -f "$f" >/dev/null 2>"$WORK_DIR/err" || { echo "FAIL $base: $(cat "$WORK_DIR/err")"; exit 1; }
  fi
  echo "applied $base"
done

PA -c "INSERT INTO users (id, status) VALUES ('00000000-0000-4000-8000-000000000701', 'active')" >/dev/null
PA -c "INSERT INTO locations (id, store_id, kind, name) VALUES ('00000000-0000-4000-8000-000000000a10', '00000000-0000-4000-8000-000000000a01', 'SELLER_WAREHOUSE', 'conc')" >/dev/null

cat > "$WORK_DIR/storm.mjs" <<'NODE'
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(process.env.API_PKG);
const { Pool, Client } = require("pg");

const PORT = Number(process.env.PGPORT_X);
const RUNS = Number(process.env.RUNS);
const ATTEMPTS = Number(process.env.ATTEMPTS);
const CONNS = Number(process.env.CONNS);
const UNITS = Number(process.env.UNITS);

const USER = "00000000-0000-4000-8000-000000000701";
const LOC = "00000000-0000-4000-8000-000000000a10";
const STORE = "00000000-0000-4000-8000-000000000a01";
const STANDARD = "00000000-0000-4000-8000-000000000501";
const POLICY = "00000000-0000-4000-8000-000000000601";

const hex = (n, w) => n.toString(16).padStart(w, "0");
const uuid = (ns, n) => `00000000-${hex(ns, 4)}-4000-8000-${hex(n, 12)}`;

const cfg = { host: "127.0.0.1", port: PORT, user: "postgres", database: "outlet" };
const admin = new Client(cfg);
await admin.connect();

const pool = new Pool({ ...cfg, max: CONNS + 2 });
// warm every connection so the storm is about locking, not connection set-up
await Promise.all(Array.from({ length: CONNS + 2 }, () => pool.query("select 1")));

const q = (text, params) => admin.query(text, params).then((r) => r.rows);
const num = async (text, params) => Number((await q(text, params))[0].n);

const totals = { runs: 0, attempts: 0, claimed: 0, insufficient: 0, released: 0, errors: {}, deadlocks: 0, failures: [] };
const latencies = [];
const modes = ["A", "B", "C", "D", "E"];
const t0 = performance.now();

for (let run = 0; run < RUNS; run += 1) {
  const mode = modes[run % 5];
  const sku = uuid(0x1000 + run, 1);
  const base = 1_000_000 * (run + 1);

  await q(
    `select inventory_apply_stock_sync($1::uuid,$2::uuid,$3::uuid,$4::uuid,'set',$5,'received',$6,null,null,'system','conc',now()) as r`,
    [sku, LOC, STANDARD, STORE, UNITS, `conc-${run}`],
  );
  if (mode === "B") {
    await q(`delete from inventory_units where sku_id = $1 and state = 'AVAILABLE'`, [sku]);
  }
  const rowsBefore = await num(`select count(*)::int as n from inventory_units where sku_id = $1 and state = 'AVAILABLE'`, [sku]);

  const plan = JSON.stringify([{ sku_id: sku, location_id: LOC, pool_id: STANDARD, store_id: STORE, qty: 1 }]);
  const fingerprint = `${sku}:${LOC}:${STANDARD}:1`;
  const tally = { claimed: 0, late: 0, lost: 0, insufficient: 0, released: 0, other: 0, swept: 0 };
  const errors = {};
  let next = 0;

  const worker = async () => {
    const client = await pool.connect();
    try {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= ATTEMPTS) return;
        const og = uuid(0x2000 + run, i + 1);
        const rid = uuid(0x3000 + run, i + 1);
        try {
          const s = performance.now();
          await client.query("begin");
          await client.query("select set_config('app.role','system',true), set_config('statement_timeout','2000',true)");
          const r = await client.query(
            `select inventory_reserve($1::uuid,$2::uuid,$3::uuid,$4::jsonb,600,$5::uuid,'CARD_WINDOW',$6,now()) as r`,
            [rid, og, USER, plan, POLICY, fingerprint],
          );
          await client.query("commit");
          latencies.push(performance.now() - s);
          const res = r.rows[0].r;
          if (res.status === "insufficient") {
            tally.insufficient += 1;
            continue;
          }
          if (res.status !== "reserved") {
            tally.other += 1;
            continue;
          }
          const release = mode === "C" && i % 3 === 0;
          await client.query("begin");
          await client.query("select set_config('app.role','system',true)");
          if (release) {
            await client.query(`select inventory_release($1::uuid,'cancelled',now())`, [og]);
            tally.released += 1;
          } else {
            const c = await client.query(`select inventory_claim($1::uuid, now()) as r`, [og]);
            const cs = c.rows[0].r.status;
            if (cs === "claimed") tally.claimed += 1;
            else if (mode === "D" && cs === "claimed_late") tally.late += 1;
            else if (mode === "D" && cs === "unavailable") tally.lost += 1;
            else tally.other += 1;
          }
          await client.query("commit");
        } catch (e) {
          try {
            await client.query("rollback");
          } catch {
            /* connection may be unusable */
          }
          const code = e && e.code ? String(e.code) : "unknown";
          errors[code] = (errors[code] ?? 0) + 1;
          if (code === "40P01") totals.deadlocks += 1;
        }
      }
    } finally {
      client.release();
    }
  };
  let stormOver = false;
  const sweeper = async () => {
    // D only: every ACTIVE reservation counts as expired one day from now, so the sweeper runs
    // against reservations that are still being claimed.
    const client = await pool.connect();
    try {
      while (!stormOver) {
        try {
          await client.query("begin");
          await client.query("select set_config('app.role','system',true)");
          const r = await client.query(`select inventory_sweep_expired(now() + interval '1 day', 25) as r`);
          await client.query("commit");
          tally.swept += r.rows[0].r.expired_reservations;
        } catch (e) {
          try {
            await client.query("rollback");
          } catch {
            /* ignore */
          }
          const code = e && e.code ? String(e.code) : "unknown";
          errors[code] = (errors[code] ?? 0) + 1;
          if (code === "40P01") totals.deadlocks += 1;
        }
        await new Promise((r) => setTimeout(r, 2));
      }
    } finally {
      client.release();
    }
  };
  let syncs = 0;
  const syncer = async () => {
    // E only: same on_hand, new idempotency key each time, so every call takes the advisory and
    // level locks and rebalances the pool while reserves and claims are in flight.
    const client = await pool.connect();
    try {
      while (!stormOver) {
        try {
          await client.query("begin");
          await client.query("select set_config('app.role','system',true)");
          await client.query(
            `select inventory_apply_stock_sync($1::uuid,$2::uuid,$3::uuid,$4::uuid,'set',$5,'recount',$6,null,null,'system','conc',now())`,
            [sku, LOC, STANDARD, STORE, UNITS, `conc-${run}-sync-${syncs}`],
          );
          await client.query(`select inventory_replenish_due(5)`);
          await client.query("commit");
          syncs += 1;
        } catch (e) {
          try {
            await client.query("rollback");
          } catch {
            /* ignore */
          }
          const code = e && e.code ? String(e.code) : "unknown";
          errors[code] = (errors[code] ?? 0) + 1;
          if (code === "40P01") totals.deadlocks += 1;
        }
        await new Promise((r) => setTimeout(r, 2));
      }
    } finally {
      client.release();
    }
  };
  const sweeping = mode === "D" ? sweeper() : mode === "E" ? syncer() : Promise.resolve();
  await Promise.all(Array.from({ length: CONNS }, () => worker()));
  stormOver = true;
  await sweeping;
  if (mode === "D") {
    // drain: whatever is still ACTIVE is swept so the final accounting is complete
    await q(`select set_config('app.role','system',false)`);
    for (let k = 0; k < 20; k += 1) {
      const r = await q(`select inventory_sweep_expired(now() + interval '1 day', 500) as r`);
      if (r[0].r.expired_reservations === 0) break;
    }
  }

  // churn: leftover free units must be re-materialised before we count
  await q(`select inventory_replenish_due(1000) as n`);

  const st = await q(
    `select count(*) filter (where state='CLAIMED')::int as claimed,
            count(*) filter (where state='RESERVED')::int as reserved,
            count(*) filter (where state='AVAILABLE')::int as available,
            count(*)::int as rows
       from inventory_units where sku_id = $1`,
    [sku],
  );
  const lvl = (await q(`select on_hand, committed from inventory_levels where sku_id = $1`, [sku]))[0];
  const resv = await q(
    `select count(*) filter (where status='CLAIMED')::int as claimed,
            count(*) filter (where status='ACTIVE')::int as active,
            count(*)::int as total
       from reservations where order_group_id between $1::uuid and $2::uuid`,
    [uuid(0x2000 + run, 0), uuid(0x2000 + run, ATTEMPTS + 1)],
  );
  const s = st[0];
  const problems = [];
  const errCount = Object.values(errors).reduce((a, b) => a + b, 0);
  if (errCount > 0) problems.push(`client errors ${JSON.stringify(errors)}`);
  if (tally.other > 0) problems.push(`unexpected outcomes ${tally.other}`);
  if (s.claimed > UNITS) problems.push(`OVERSOLD: ${s.claimed} claimed > ${UNITS}`);
  if (lvl.committed !== s.claimed) problems.push(`committed ${lvl.committed} != claimed rows ${s.claimed}`);
  if (lvl.on_hand !== UNITS) problems.push(`on_hand changed to ${lvl.on_hand}`);
  if (s.reserved !== 0) problems.push(`leaked reserved units ${s.reserved}`);
  if (s.claimed + s.available !== UNITS) problems.push(`units not conserved: claimed ${s.claimed} + available ${s.available} != ${UNITS}`);
  if (resv[0].claimed !== s.claimed) problems.push(`claimed reservations ${resv[0].claimed} != claimed units ${s.claimed}`);
  if (resv[0].active !== 0) problems.push(`active reservations left ${resv[0].active}`);
  if (tally.claimed + tally.late !== s.claimed) problems.push(`app saw ${tally.claimed + tally.late} claims, db has ${s.claimed}`);
  if (mode === "A" || mode === "B" || mode === "E") {
    if (s.claimed !== UNITS) problems.push(`expected exactly ${UNITS} claimed, got ${s.claimed}`);
    if (tally.insufficient !== ATTEMPTS - UNITS) problems.push(`expected ${ATTEMPTS - UNITS} insufficient, got ${tally.insufficient}`);
  }
  if (mode === "A" && rowsBefore !== UNITS) problems.push(`mode A pool not materialised (${rowsBefore})`);
  if (mode === "B" && rowsBefore !== 0) problems.push(`mode B pool unexpectedly materialised (${rowsBefore})`);

  totals.runs += 1;
  totals.attempts += ATTEMPTS;
  totals.claimed += s.claimed;
  totals.insufficient += tally.insufficient;
  totals.released += tally.released;
  for (const [k, v] of Object.entries(errors)) totals.errors[k] = (totals.errors[k] ?? 0) + v;
  const verdict = problems.length === 0 ? "ok  " : "FAIL";
  console.log(
    `${verdict} run ${String(run + 1).padStart(2)}/${RUNS} mode ${mode} claimed=${s.claimed} insufficient=${tally.insufficient} ` +
      `released=${tally.released} late=${tally.late} lost=${tally.lost} swept=${tally.swept} syncs=${syncs} available=${s.available} reserved_left=${s.reserved} rows_before=${rowsBefore}` +
      (problems.length ? `  <- ${problems.join("; ")}` : ""),
  );
  if (problems.length) totals.failures.push({ run: run + 1, mode, problems });
}

latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0;
const secs = ((performance.now() - t0) / 1000).toFixed(1);
console.log(
  JSON.stringify({
    runs: totals.runs,
    attemptsPerRun: ATTEMPTS,
    connections: CONNS,
    totalAttempts: totals.attempts,
    errors: totals.errors,
    deadlocks40P01: totals.deadlocks,
    failedRuns: totals.failures.length,
    reserveLatencyMs: { p50: +pct(0.5).toFixed(1), p95: +pct(0.95).toFixed(1), p99: +pct(0.99).toFixed(1) },
    seconds: Number(secs),
  }),
);
await pool.end();
await admin.end();
process.exit(totals.failures.length === 0 && totals.deadlocks === 0 ? 0 : 1);
NODE

echo "== storm: $RUNS runs x $ATTEMPTS attempts on $UNITS units, $CONNS connections =="
API_PKG="$ROOT/apps/api/package.json" PGPORT_X="$PORT" RUNS="$RUNS" ATTEMPTS="$ATTEMPTS" CONNS="$CONNS" UNITS="$UNITS" \
  node "$WORK_DIR/storm.mjs"
STORM_RC=$?

echo "== server log =="
DL="$(grep -ci 'deadlock detected' "$WORK_DIR/pg.log" || true)"
echo "server-side 'deadlock detected' log lines: $DL"
ERRS="$(grep -c 'ERROR' "$WORK_DIR/pg.log" || true)"
echo "server-side ERROR log lines: $ERRS (an insufficient-stock attempt is a normal return value, not an error)"
[ "$DL" = "0" ] || STORM_RC=1

echo
if [ "$STORM_RC" -eq 0 ]; then
  echo "RESULT: PASS ($RUNS runs). Single-machine evidence only; not production verified."
else
  echo "RESULT: FAIL"
fi
exit "$STORM_RC"
