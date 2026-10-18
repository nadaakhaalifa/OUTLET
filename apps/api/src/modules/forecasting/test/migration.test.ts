import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintMigration, migrate, parseMigration, withoutConcurrently } from "@outlet/db";

const DIR = new URL("../../../../../../packages/db/migrations/", import.meta.url);
const SQL64 = readFileSync(fileURLToPath(new URL("0064_demand_forecasting.sql", DIR)), "utf8");
const SQL65 = readFileSync(fileURLToPath(new URL("0065_forecast_runs.sql", DIR)), "utf8");
const STORE_A = "00000000-0000-4000-a000-000000000001";
const STORE_B = "00000000-0000-4000-a000-000000000002";
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let db: PGlite;

const as = async <X>(role: string, stores: string, fn: () => Promise<X>): Promise<X> => {
  await db.exec("BEGIN");
  try {
    await db.exec("SET LOCAL ROLE app_user");
    await db.query("SELECT set_config('app.role', $1, true), set_config('app.store_ids', $2, true)", [role, stores]);
    const out = await fn();
    await db.exec("COMMIT");
    return out;
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
};

const series = (store: string, sku: number, day: string) =>
  db.query(
    `INSERT INTO forecast_demand_series (store_id, sku_id, category_code, size_label, governorate, day, units_gross, units_net, shoppers)
     VALUES ($1, $2, 'dresses', 'M', 'Cairo', $3::date, 5, 5, 3)`,
    [store, U(sku), day],
  );
const forecast = (id: number, store: string, o: { status?: string; p10?: number | null; p50?: number | null; p90?: number | null; model?: string | null; origins?: number; key?: string } = {}) =>
  db.query(
    `INSERT INTO demand_forecasts (id, store_id, scope, scope_key, horizon_days, as_of_date, model, model_version, status,
       p10, p50, p90, comparable_units, observed_days, backtest_origins)
     VALUES ($1, $2, 'sku', $3, 7, '2026-09-01', $4, 'baseline-v1', $5, $6, $7, $8, 40, 40, $9)`,
    [
      U(id),
      store,
      o.key ?? U(1),
      o.model === undefined ? "ets_seasonal" : o.model,
      o.status ?? "ok",
      o.p10 === undefined ? 2 : o.p10,
      o.p50 === undefined ? 4 : o.p50,
      o.p90 === undefined ? 8 : o.p90,
      o.origins ?? 6,
    ],
  );
const count = async (t: string) => (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t}`)).rows[0]?.n;

beforeAll(async () => {
  db = new PGlite();
  const names = readdirSync(fileURLToPath(DIR)).filter((f) => /^00(0[1-9]|1[01])_/.test(f)).sort();
  await migrate(withoutConcurrently(db), names.map((f) => parseMigration(f, readFileSync(fileURLToPath(new URL(f, DIR)), "utf8"))));
  await db.exec(SQL64);
  await db.exec(SQL65);
  await series(STORE_A, 1, "2026-08-01");
  await series(STORE_B, 2, "2026-08-01");
  await forecast(1, STORE_A);
  await forecast(2, STORE_B, { key: U(2) });
}, 60_000);
afterAll(async () => {
  await db.close();
});

describe("0064_demand_forecasting and 0065_forecast_runs", () => {
  it("pass the expand-only migration linter", () => {
    expect(lintMigration(SQL64)).toEqual([]);
    expect(lintMigration(SQL65)).toEqual([]);
  });

  it("has no shopper identity, measurement or budget columns", async () => {
    const cols = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name in ('forecast_demand_series','demand_forecasts','forecast_runs')`,
    );
    const names = cols.rows.map((c) => c.column_name);
    expect(names).toContain("shoppers");
    expect(names.filter((n) => /user_id|shopper_key|measure|budget|waist|bust|hip|device|phone|email|address/.test(n))).toEqual([]);
  });

  it("RLS: a seller reads only their own store; another store and an empty scope see nothing", async () => {
    const mine = await as("seller", STORE_A, async () => (await db.query<{ store_id: string }>("SELECT store_id FROM demand_forecasts")).rows);
    expect(mine.map((r) => r.store_id)).toEqual([STORE_A]);
    const other = await as("seller", STORE_B, async () => (await db.query<{ store_id: string }>("SELECT store_id FROM forecast_demand_series")).rows);
    expect(other.map((r) => r.store_id)).toEqual([STORE_B]);
    expect(await as("seller", "", () => count("demand_forecasts"))).toBe("0");
    expect(await as("seller", "", () => count("forecast_runs"))).toBe("0");
  });

  it("RLS: a seller cannot write forecasts, series or runs; only system can", async () => {
    await expect(as("seller", STORE_A, () => forecast(10, STORE_A, { key: U(10) }))).rejects.toThrow(/row-level security/i);
    await expect(as("seller", STORE_A, () => series(STORE_A, 3, "2026-08-02"))).rejects.toThrow(/row-level security/i);
    await expect(as("system", "", () => forecast(11, STORE_A, { key: U(11) }))).resolves.toBeDefined();
    // Forecasts are insert-only: even the system role holds no UPDATE or DELETE grant.
    await expect(as("system", "", () => db.query(`UPDATE demand_forecasts SET p50 = 999 WHERE store_id = $1`, [STORE_A]))).rejects.toThrow(/permission denied/i);
    await expect(as("system", "", () => db.query(`DELETE FROM demand_forecasts WHERE store_id = $1`, [STORE_A]))).rejects.toThrow(/permission denied/i);
  });

  it("a non-ok forecast cannot carry a number and an ok forecast must carry an ordered interval", async () => {
    await expect(forecast(20, STORE_A, { status: "insufficient_history", model: null, key: U(20) })).rejects.toThrow(/check/i);
    await expect(forecast(21, STORE_A, { status: "suppressed", model: null, p10: null, p50: 3, p90: null, key: U(21) })).rejects.toThrow(/check/i);
    await expect(forecast(22, STORE_A, { p10: null, key: U(22) })).rejects.toThrow(/check/i);
    await expect(forecast(23, STORE_A, { p10: 9, p50: 4, p90: 8, key: U(23) })).rejects.toThrow(/check/i);
    await expect(forecast(24, STORE_A, { origins: 0, key: U(24) })).rejects.toThrow(/check/i);
    await expect(forecast(25, STORE_A, { status: "insufficient_history", model: null, p10: null, p50: null, p90: null, origins: 0, key: U(25) })).resolves.toBeDefined();
  });

  it("enforces key uniqueness (idempotent batch) and series shape", async () => {
    await expect(forecast(30, STORE_A, { key: U(1) })).rejects.toThrow(/unique|duplicate/i);
    await expect(series(STORE_A, 1, "2026-08-01")).rejects.toThrow(/unique|duplicate/i);
    await expect(
      db.query(
        `INSERT INTO forecast_demand_series (store_id, sku_id, category_code, size_label, day, units_gross, units_net, shoppers)
         VALUES ($1, $2, 'dresses', 'M', '2026-08-05', 3, 4, 0)`,
        [STORE_A, U(5)],
      ),
    ).rejects.toThrow(/check/i);
    await expect(
      db.query(
        `INSERT INTO forecast_demand_series (store_id, sku_id, category_code, size_label, day, units_gross, units_net, shoppers)
         VALUES ($1, $2, 'dresses', 'M', '2026-08-05', 3, 3, 9)`,
        [STORE_A, U(5)],
      ),
    ).rejects.toThrow(/check/i);
  });

  it("a completed run is immutable for the seller role boundary: only failed runs can be updated", async () => {
    await db.query(
      `INSERT INTO forecast_runs (store_id, as_of_date, status, series_total, ok_count, started_at, finished_at)
       VALUES ($1, '2026-09-01', 'completed', 1, 1, now(), now())`,
      [STORE_A],
    );
    const upd = await as("system", "", () =>
      db.query(`UPDATE forecast_runs SET series_total = 7, ok_count = 7 WHERE store_id = $1`, [STORE_A]),
    );
    expect(upd.affectedRows).toBe(0);
    await expect(
      db.query(
        `INSERT INTO forecast_runs (store_id, as_of_date, status, series_total, ok_count, started_at, finished_at)
         VALUES ($1, '2026-09-02', 'completed', 1, 5, now(), now())`,
        [STORE_A],
      ),
    ).rejects.toThrow(/check/i);
  });
});
