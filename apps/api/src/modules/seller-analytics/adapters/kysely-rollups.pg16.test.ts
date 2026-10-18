/**
 * M1 concurrency harness against a REAL, throw-away PostgreSQL 16 cluster with real connections (PGlite is one backend and cannot
 * exercise advisory locks or concurrent transactions). It starts its own cluster (initdb, 127.0.0.1 only, trust auth, random port) and
 * stops it afterwards. Skipped when the PostgreSQL 16 binaries are not present (set PG16_BIN to point at them); the CI job that
 * provides Postgres 16 is a dependency named in the spec (section 8, T6). The application connects as a LOGIN role that is a member of
 * app_user, so RLS, grants and SECURITY DEFINER functions are exercised for real.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { splitStatements } from "@outlet/db";
import fc from "fast-check";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgDatabase } from "../../../platform/db";
import { aggregateFacts, diffRollups, keyString, type AggregatableFact, type RollupKey } from "../domain/bridge";
import type { SourceEvent } from "../domain/ports";
import { ReconcileRollups } from "../application/reconcile";
import { ctx } from "../test/rollup-contract";
import { P1, STORE_A, STORE_B, T0, DAY, U, ev, purchase } from "../test/repository-contract";
import { KyselySellerAnalyticsStore, type SellerAnalyticsDb } from "./kysely-store";

const PG_BIN = process.env["PG16_BIN"] ?? "/Applications/Postgres.app/Contents/Versions/16/bin";
const available = existsSync(join(PG_BIN, "initdb")) && existsSync(join(PG_BIN, "pg_ctl"));
const MIGRATIONS = fileURLToPath(new URL("../../../../../../packages/db/migrations/", import.meta.url));
const HOUR = 3_600_000;
const H0 = Math.floor((T0 - DAY) / HOUR) * HOUR;
const NOW = T0;

let dir = "";
let port = 0;
let admin: pg.Client;
let db: SellerAnalyticsDb;
let store: KyselySellerAnalyticsStore;
let hooked: { current: ((k: RollupKey) => Promise<void>) | undefined; repair: ((k: RollupKey) => Promise<void>) | undefined };

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });

const bin = (n: string, args: string[]): string => execFileSync(join(PG_BIN, n), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

beforeAll(async () => {
  if (!available) return;
  dir = mkdtempSync(join(tmpdir(), "outlet-rollups-pg16-"));
  port = await freePort();
  bin("initdb", ["-D", join(dir, "data"), "-U", "postgres", "--auth=trust", "--encoding=UTF8", "--locale=C"]);
  bin("pg_ctl", ["-D", join(dir, "data"), "-o", `-p ${port} -c listen_addresses=127.0.0.1 -c max_connections=100 -c unix_socket_directories=''`, "-w", "-l", join(dir, "pg.log"), "start"]);
  const boot = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" });
  await boot.connect();
  await boot.query("CREATE DATABASE outlet");
  await boot.end();
  admin = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "outlet" });
  await admin.connect();
  const version = (await admin.query<{ v: string }>("SELECT current_setting('server_version_num') AS v")).rows[0]?.v ?? "";
  if (!version.startsWith("16")) throw new Error(`expected PostgreSQL 16, got ${version}`);
  const files = readdirSync(MIGRATIONS).filter((f) => /^(000[1-9]|0010|0011|0028|0088|0090)_/.test(f)).sort();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    if (/^--\s*no-transaction\s*$/m.test(sql)) for (const stmt of splitStatements(sql)) await admin.query(stmt);
    else await admin.query(sql);
  }
  await admin.query("CREATE ROLE app_login LOGIN IN ROLE app_user");
  hooked = { current: undefined, repair: undefined };
  db = createPgDatabase<Record<string, never>>({ connectionString: `postgres://app_login@127.0.0.1:${port}/outlet`, max: 12 });
  store = new KyselySellerAnalyticsStore(db, { afterLock: (k) => hooked.current?.(k) ?? Promise.resolve(), repairAfterLock: (k) => hooked.repair?.(k) ?? Promise.resolve() });
}, 180_000);

afterAll(async () => {
  if (!available) return;
  await db?.destroy();
  await admin?.end().catch(() => undefined);
  try {
    bin("pg_ctl", ["-D", join(dir, "data"), "-m", "immediate", "stop"]);
  } catch {
    /* already stopped */
  }
  rmSync(dir, { recursive: true, force: true });
});

const reset = async (): Promise<void> => {
  await admin.query("TRUNCATE seller_analytics_facts, seller_analytics_hourly, platform_metrics_hourly, analytics_rollup_reconciliations, analytics_rollup_watermarks, inbox_processed, seller_analytics_freshness");
  hooked.current = undefined;
  hooked.repair = undefined;
};

const WINDOW = { fromMs: H0 - 6 * HOUR, toMs: H0 + 12 * HOUR };
const view = (n: number, at: number) => ev({ kind: "view", productId: P1 }, { at, id: U(80_000 + n) });
const storeView = (n: number, at: number) => ev({ kind: "store_view", source: "feed" }, { at, id: U(81_000 + n) });

/** Seeds: the existing key has a row that drifted (+5); the new key has facts but NO row (as after a lost increment). */
const seed = async (): Promise<number> => {
  await store.ingest("c", [view(1, H0 + 60_000), view(2, H0 + 120_000)], NOW);
  await admin.query("UPDATE seller_analytics_hourly SET value = value + 5, version = version + 1 WHERE metric = 'product_views'");
  await admin.query(
    `INSERT INTO seller_analytics_facts (message_id, store_id, kind, occurred_at) VALUES ($1, $2, 'store_view', to_timestamp($3 / 1000.0)), ($4, $2, 'store_view', to_timestamp($5 / 1000.0))`,
    [U(81_900), STORE_A, H0 + HOUR + 1000, U(81_901), H0 + HOUR + 2000],
  );
  return 2;
};

const rowsAndFacts = async (): Promise<{ rows: Map<string, bigint>; facts: Map<string, bigint> }> => {
  const snap = await store.snapshot("seller", WINDOW);
  return { rows: new Map([...snap.rows].map(([k, r]) => [k, r.state.value + r.state.held])), facts: new Map([...snap.facts].map(([k, f]) => [k, f.total])) };
};

type Step = "consume_exist" | "consume_new" | "consume_other" | "consume_dup";
const consumerEvents = (step: Step, n: number): SourceEvent[] => {
  switch (step) {
    case "consume_exist": return [view(100 + n, H0 + 300_000 + n)];
    case "consume_new": return [storeView(100 + n, H0 + HOUR + 300_000 + n)];
    case "consume_other": return [view(200 + n, H0 + 2 * HOUR + n)];
    case "consume_dup": return [view(1, H0 + 60_000)];
  }
};

/** One schedule: the reconciler's three phases with consumer commits placed between them. Returns the keys it repaired. */
async function runSchedule(consumersAt: readonly (readonly Step[])[]): Promise<{ drift: Map<string, bigint>; repaired: Set<string> }> {
  await reset();
  await seed();
  let n = 0;
  const consume = async (slot: number): Promise<void> => {
    for (const s of consumersAt[slot] ?? []) await store.ingest("c", consumerEvents(s, n++), NOW);
  };
  await consume(0);
  const snap = await store.snapshot("seller", WINDOW);
  const diffs = diffRollups(snap.facts, snap.rows);
  const drift = new Map<string, bigint>();
  for (const d of diffs) drift.set(keyString(d.key), d.kind === "existing" ? d.actual.value + d.actual.held - d.expected : -d.expected);
  await consume(1);
  const repaired = new Set<string>();
  for (const d of diffs) if (d.kind === "existing" && (await store.casRepair(d.key, d.expected, d.actual.version)) === "corrected") repaired.add(keyString(d.key));
  await consume(2);
  for (const d of diffs) if (d.kind === "new_key" && (await store.repairNewKey(d.key)) === "inserted") repaired.add(keyString(d.key));
  await consume(3);
  return { drift, repaired };
}

const checkInvariant = async (drift: Map<string, bigint>, repaired: Set<string>): Promise<void> => {
  const { rows, facts } = await rowsAndFacts();
  for (const k of new Set([...rows.keys(), ...facts.keys()])) {
    const diff = (rows.get(k) ?? 0n) - (facts.get(k) ?? 0n);
    const want = repaired.has(k) ? 0n : (drift.get(k) ?? 0n);
    expect(diff, `key ${k}`).toBe(want);
  }
  // A quiescent pass then repairs whatever was skipped, and a second pass finds nothing.
  const c = ctx();
  const r = new ReconcileRollups({ rollups: store, clock: { nowMs: () => H0 + 3 * HOUR }, ids: c.ids });
  await r.hourly();
  expect((await r.hourly()).mismatches).toBe(0);
  const end = await rowsAndFacts();
  for (const [k, v] of end.facts) expect(end.rows.get(k) ?? 0n, k).toBe(v);
  for (const [k, v] of end.rows) expect(v, k).toBe(end.facts.get(k) ?? 0n);
};

describe.skipIf(!available)("M1 concurrency on PostgreSQL 16 (two real connections, advisory-lock barriers)", () => {
  it("runs on PostgreSQL 16 as a non-owner role under RLS", async () => {
    const r = await admin.query<{ rolsuper: boolean; v: string }>("SELECT rolsuper, current_setting('server_version_num') AS v FROM pg_roles WHERE rolname = 'app_login'");
    expect(r.rows[0]?.rolsuper).toBe(false);
    expect(r.rows[0]?.v.startsWith("16")).toBe(true);
    await reset();
    expect((await store.ingest("c", [view(1, H0)], NOW)).applied).toBe(1);
    // Without the system role the table is invisible to the app role: the adapter really does set it.
    const c = new pg.Client({ host: "127.0.0.1", port, user: "app_login", database: "outlet" });
    await c.connect();
    expect((await c.query("SELECT 1 FROM seller_analytics_hourly")).rows).toHaveLength(0);
    await c.end();
  });

  it("the erased-key lookup in ingest runs as system: an erased key is NULLed even though the app role cannot see the table", async () => {
    await reset();
    const key = "px_erased_pg16_0000000001";
    await admin.query("INSERT INTO analytics_erased_keys (shopper_key) VALUES ($1)", [key]);
    const c = new pg.Client({ host: "127.0.0.1", port, user: "app_login", database: "outlet" });
    await c.connect();
    try {
      // Control: outside the system role the app login sees no erased keys (RLS), so a lookup without it would miss.
      expect((await c.query("SELECT 1 FROM analytics_erased_keys")).rows).toHaveLength(0);
    } finally {
      await c.end();
    }
    const res = await store.ingest("c", [{ ...view(1, H0), shopperKey: key }, view(2, H0 + 1)], NOW);
    expect(res.applied).toBe(2);
    const keys = await admin.query<{ shopper_key: string | null }>("SELECT shopper_key FROM seller_analytics_facts ORDER BY occurred_at");
    expect(keys.rows[0]?.shopper_key).toBeNull();
    expect(keys.rows.some((r) => r.shopper_key === key)).toBe(false);
  });

  it("every placement of the consumer commits among the reconciler's phases keeps rollups equal to facts (20 exhaustive interleavings)", async () => {
    const steps: Step[] = ["consume_exist", "consume_new"];
    // Place two distinct consumer commits into the 4 gaps around the reconciler's snapshot, CAS and new-key phases (incl. same gap in both orders).
    let count = 0;
    for (const a of [0, 1, 2, 3]) {
      for (const b of [0, 1, 2, 3]) {
        for (const order of a === b ? [0, 1] : [0]) {
          const slots: Step[][] = [[], [], [], []];
          const first = order === 0 ? steps[0] as Step : steps[1] as Step;
          const second = order === 0 ? steps[1] as Step : steps[0] as Step;
          slots[a]?.push(first);
          slots[b]?.push(second);
          const { drift, repaired } = await runSchedule(slots);
          await checkInvariant(drift, repaired);
          count += 1;
        }
      }
    }
    expect(count).toBe(20);
  }, 120_000);

  it("1,000 random schedules: no increment is lost or doubled, skipped rows are rechecked, the final pass is clean", async () => {
    const step = fc.constantFrom<Step>("consume_exist", "consume_new", "consume_other", "consume_dup");
    await fc.assert(
      fc.asyncProperty(fc.array(fc.array(step, { maxLength: 3 }), { minLength: 4, maxLength: 4 }), async (slots) => {
        const { drift, repaired } = await runSchedule(slots);
        await checkInvariant(drift, repaired);
      }),
      { numRuns: 1000, endOnFailure: true },
    );
  }, 600_000);

  it("a consumer that holds the key lock makes the reconciler's new-key insert wait, then the reconciler sees the row and skips (true overlap)", async () => {
    await reset();
    await seed();
    const snap = await store.snapshot("seller", WINDOW);
    const diff = diffRollups(snap.facts, snap.rows).find((d) => d.kind === "new_key");
    expect(diff).toBeDefined();
    if (diff === undefined) return;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    hooked.current = async (k) => {
      if (keyString(k) !== keyString(diff.key)) return;
      held = true; // the consumer now holds the advisory lock for the new key inside its open transaction
      await gate;
    };
    const consumer = store.ingest("c", [storeView(500, H0 + HOUR + 777_000)], NOW);
    while (!held) await new Promise((r) => setTimeout(r, 5));
    const repair = store.repairNewKey(diff.key);
    // The reconciler is parked on the lock (a real backend is waiting on an advisory lock).
    let waiting = 0;
    for (let i = 0; i < 400 && waiting === 0; i += 1) {
      waiting = Number((await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).rows[0]?.n);
      if (waiting === 0) await new Promise((r) => setTimeout(r, 10));
    }
    expect(waiting).toBe(1);
    release();
    await consumer;
    expect(await repair).toBe("exists");
    hooked.current = undefined;
    // The consumer's row (value 1) plus the 2 seeded facts: drift of -2 remains until the next pass repairs it.
    const { rows, facts } = await rowsAndFacts();
    expect((rows.get(keyString(diff.key)) ?? 0n) - (facts.get(keyString(diff.key)) ?? 0n)).toBe(-2n);
    const c = ctx();
    await new ReconcileRollups({ rollups: store, clock: { nowMs: () => H0 + 3 * HOUR }, ids: c.ids }).hourly();
    const after = await rowsAndFacts();
    expect(after.rows.get(keyString(diff.key))).toBe(3n);
  });

  it("the reconciler holds the key lock while it recomputes: a consumer arriving then waits and adds its delta on top", async () => {
    await reset();
    await seed();
    const snap = await store.snapshot("seller", WINDOW);
    const diff = diffRollups(snap.facts, snap.rows).find((d) => d.kind === "new_key");
    if (diff === undefined) throw new Error("no new key");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let inside = false;
    hooked.repair = async () => {
      inside = true; // the reconciler holds the lock and has checked that no row exists
      await gate;
    };
    const repair = store.repairNewKey(diff.key);
    while (!inside) await new Promise((r) => setTimeout(r, 5));
    const consumer = store.ingest("c", [storeView(501, H0 + HOUR + 888_000)], NOW);
    let waiting = 0;
    for (let i = 0; i < 400 && waiting === 0; i += 1) {
      waiting = Number((await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).rows[0]?.n);
      if (waiting === 0) await new Promise((r) => setTimeout(r, 10));
    }
    expect(waiting).toBe(1);
    release();
    expect(await repair).toBe("inserted");
    await consumer;
    hooked.repair = undefined;
    const { rows, facts } = await rowsAndFacts();
    expect(rows.get(keyString(diff.key))).toBe(3n);
    expect(facts.get(keyString(diff.key))).toBe(3n);
  });

  it("concurrent consumer batches over overlapping keys in opposite order never deadlock and add up exactly", async () => {
    await reset();
    const batches: SourceEvent[][] = [];
    let id = 0;
    for (let i = 0; i < 8; i += 1) {
      const evs: SourceEvent[] = [];
      const hours = i % 2 === 0 ? [0, 1, 2, 3] : [3, 2, 1, 0];
      for (const h of hours) {
        evs.push(ev({ kind: "view", productId: P1 }, { at: H0 + h * HOUR + id, id: U(90_000 + id) }), purchase(1 + (i % 3), P1, P1, 1, 1000n, { at: H0 + h * HOUR + 5, id: U(91_000 + id), store: i % 4 === 0 ? STORE_B : STORE_A }));
        id += 1;
      }
      batches.push(evs);
    }
    for (let round = 0; round < 25; round += 1) {
      await reset();
      const results = await Promise.all(batches.map((b, i) => store.ingest("c", b.map((e, j) => ({ ...e, messageId: U(300_000 + round * 1000 + i * 50 + j) })), NOW)));
      expect(results.reduce((n, r) => n + r.applied, 0)).toBe(batches.reduce((n, b) => n + b.length, 0));
      const { rows, facts } = await rowsAndFacts();
      for (const [k, v] of facts) expect(rows.get(k), k).toBe(v);
      for (const [k, v] of rows) expect(facts.get(k) ?? 0n, k).toBe(v);
    }
    const log = readFileSync(join(dir, "pg.log"), "utf8");
    expect(log).not.toMatch(/deadlock detected/);
  }, 120_000);

  it("the platform scope reconciles too: a drifted platform row is repaired by compare-and-set", async () => {
    await reset();
    await store.ingest("c", [purchase(1, P1, P1, 2, 1000n, { at: H0 + 5 })], NOW);
    await admin.query("UPDATE platform_metrics_hourly SET value = 9, version = version + 1 WHERE metric = 'units_purchased'");
    const snap = await store.snapshot("platform", WINDOW);
    const diffs = diffRollups(snap.facts, snap.rows);
    expect(diffs).toHaveLength(1);
    const d = diffs[0];
    if (d === undefined || d.kind !== "existing") throw new Error("expected an existing-key diff");
    expect(await store.casRepair(d.key, d.expected, d.actual.version)).toBe("corrected");
    expect(aggregateFacts("platform", [{ kind: "purchase", storeId: STORE_A, occurredAtMs: H0 + 5, qty: 2, grossMinor: 1000n, commissionMinor: 0n }] satisfies AggregatableFact[], WINDOW.fromMs, WINDOW.toMs).size).toBe(2);
    expect(await rowsAndFacts().then((x) => x.rows.size)).toBeGreaterThan(0);
    const after = await store.snapshot("platform", WINDOW);
    expect(diffRollups(after.facts, after.rows)).toEqual([]);
  });

  it("the partition job runs as the app role (SECURITY DEFINER) and moves a DEFAULT row", async () => {
    await reset();
    await admin.query(
      `INSERT INTO seller_analytics_hourly (store_id, metric, hour_utc, cairo_date, cairo_hour, utc_offset_min, value)
       VALUES ($1, 'orders', date_trunc('month', now()) + interval '7 months' + interval '5 hours', current_date, 1, 120, 2)`,
      [STORE_B],
    );
    expect((await store.defaultPartitionRows()).find((x) => x.table === "seller_analytics_hourly")?.rows).toBe(1);
    const r = await store.maintainPartitions(Date.now(), 8, 25);
    expect(r.movedRows).toBe(1);
    expect(r.defaultRows).toBe(0);
  });
});
