import { cairoHourBucket } from "@outlet/domain";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import type { AggregatableFact } from "../domain/bridge";
import { createRollupDatabase } from "../test/rollup-db";
import { describeRollupContract, type RollupSubject } from "../test/rollup-contract";
import { H0_FOR_TESTS } from "../test/rollup-fixtures";
import { KyselyShopperFactsEraser } from "./kysely-erasure";
import { KyselySellerAnalyticsStore, type SellerAnalyticsDb } from "./kysely-store";

const open: SellerAnalyticsDb[] = [];
let cached: Promise<{ subject: RollupSubject; raw: PGlite }> | undefined;

const build = async (): Promise<{ subject: RollupSubject; raw: PGlite }> => {
  const raw = await createRollupDatabase();
  const db: SellerAnalyticsDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  const store = new KyselySellerAnalyticsStore(db);
  const ts = (ms: number): string => new Date(ms).toISOString();
  const table = (scope: string): string => (scope === "seller" ? "seller_analytics_hourly" : "platform_metrics_hourly");
  const where = (scope: string, storeId: string | null, metric: string, hourMs: number): { sql: string; params: unknown[] } =>
    scope === "seller"
      ? { sql: "store_id = $1 AND metric = $2 AND hour_utc = $3", params: [storeId, metric, ts(hourMs)] }
      : { sql: "metric = $1 AND hour_utc = $2", params: [metric, ts(hourMs)] };
  const subject: RollupSubject = {
    store,
    eraser: new KyselyShopperFactsEraser(db),
    async reset() {
      await raw.exec("TRUNCATE seller_analytics_facts, seller_analytics_hourly, platform_metrics_hourly, analytics_rollup_reconciliations, analytics_rollup_watermarks, analytics_erased_keys, inbox_processed, seller_analytics_freshness");
    },
    async value(scope, storeId, metric, hourMs) {
      const w = where(scope, storeId, metric, hourMs);
      const r = await raw.query<{ v: string }>(`SELECT (value ${scope === "seller" ? "+ held_value" : ""})::text AS v FROM ${table(scope)} WHERE ${w.sql}`, w.params);
      return BigInt(r.rows[0]?.v ?? "0");
    },
    async hasRow(scope, storeId, metric, hourMs) {
      const w = where(scope, storeId, metric, hourMs);
      return (await raw.query(`SELECT 1 FROM ${table(scope)} WHERE ${w.sql}`, w.params)).rows.length > 0;
    },
    async setRow(scope, storeId, metric, hourMs, value, held = 0n) {
      const b = cairoHourBucket(hourMs);
      if (scope === "seller") {
        await raw.query(
          `INSERT INTO seller_analytics_hourly (store_id, metric, hour_utc, cairo_date, cairo_hour, utc_offset_min, value, held_value, version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0)
           ON CONFLICT (store_id, metric, hour_utc) DO UPDATE SET value = EXCLUDED.value, held_value = EXCLUDED.held_value, version = seller_analytics_hourly.version + 1`,
          [storeId, metric, ts(b.hourUtcMs), b.cairoDate, b.cairoHour, b.utcOffsetMin, value.toString(), held.toString()],
        );
      } else {
        await raw.query(
          `INSERT INTO platform_metrics_hourly (metric, hour_utc, cairo_date, cairo_hour, utc_offset_min, value, version)
           VALUES ($1, $2, $3, $4, $5, $6, 0)
           ON CONFLICT (metric, hour_utc) DO UPDATE SET value = EXCLUDED.value, version = platform_metrics_hourly.version + 1`,
          [metric, ts(b.hourUtcMs), b.cairoDate, b.cairoHour, b.utcOffsetMin, value.toString()],
        );
      }
    },
    async deleteRows() {
      await raw.exec("DELETE FROM seller_analytics_hourly; DELETE FROM platform_metrics_hourly");
    },
    async deleteRowsOf(scope, storeId, metric, hourMs) {
      const w = where(scope, storeId, metric, hourMs);
      await raw.query(`DELETE FROM ${table(scope)} WHERE ${w.sql}`, w.params);
    },
    async recorded() {
      const r = await raw.query<{ scope: string; outcome: string; mismatches: number; corrected: number; skipped_concurrent: number }>(
        "SELECT scope, outcome, mismatches, corrected, skipped_concurrent FROM analytics_rollup_reconciliations ORDER BY ran_at, scope DESC",
      );
      return r.rows.map((x) => ({ scope: x.scope, outcome: x.outcome, mismatches: x.mismatches, corrected: x.corrected, skippedConcurrent: x.skipped_concurrent }));
    },
    async shopperKeys() {
      return (await raw.query<{ k: string }>("SELECT shopper_key AS k FROM seller_analytics_facts WHERE shopper_key IS NOT NULL ORDER BY 1")).rows.map((x) => x.k);
    },
    async facts(): Promise<readonly AggregatableFact[]> {
      const r = await raw.query<{ kind: string; store_id: string; ms: string; qty: number | null; gross: string | null; commission: string | null; order_id: string | null }>(
        "SELECT kind, store_id::text AS store_id, round(extract(epoch FROM occurred_at) * 1000)::text AS ms, qty, gross_minor::text AS gross, commission_minor::text AS commission, seller_order_id::text AS order_id FROM seller_analytics_facts",
      );
      return r.rows.map((x) => ({
        kind: x.kind,
        storeId: x.store_id,
        occurredAtMs: Number(x.ms),
        ...(x.qty === null ? {} : { qty: x.qty }),
        ...(x.gross === null ? {} : { grossMinor: BigInt(x.gross) }),
        ...(x.commission === null ? {} : { commissionMinor: BigInt(x.commission) }),
        ...(x.order_id === null ? {} : { sellerOrderId: x.order_id }),
      }));
    },
  };
  return { subject, raw };
};

const shared = (): Promise<{ subject: RollupSubject; raw: PGlite }> => (cached ??= build());

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeRollupContract(
  "kysely/pglite",
  async () => {
    const { subject } = await shared();
    await subject.reset();
    return subject;
  },
  { runs: 12 },
);

describe("kysely/pglite specifics", () => {
  it("a batch that fails rolls back the facts, the inbox row and every rollup increment together", async () => {
    const { subject, raw } = await shared();
    await subject.reset();
    const good = { kind: "view", productId: "00000000-0000-4000-8000-000000000010", messageId: "00000000-0000-4000-8000-000000000501", occurredAtMs: H0_FOR_TESTS, storeId: "00000000-0000-4000-a000-000000000001", shopperKey: null } as const;
    const bad = { ...good, messageId: "00000000-0000-4000-8000-000000000502", storeId: "not-a-uuid" };
    await expect(subject.store.ingest("c", [good, bad as unknown as typeof good], 1)).rejects.toBeDefined();
    expect((await raw.query("SELECT 1 FROM seller_analytics_facts")).rows).toHaveLength(0);
    expect((await raw.query("SELECT 1 FROM seller_analytics_hourly")).rows).toHaveLength(0);
    expect((await raw.query("SELECT 1 FROM inbox_processed")).rows).toHaveLength(0);
  });

  it("every ingest advances the watermark, held back by an unpublished routed outbox event", async () => {
    const { subject, raw } = await shared();
    await subject.reset();
    const view = (n: number) => ({ kind: "view", productId: "00000000-0000-4000-8000-000000000010", messageId: `00000000-0000-4000-8000-0000000006${String(n).padStart(2, "0")}`, occurredAtMs: H0_FOR_TESTS, storeId: "00000000-0000-4000-a000-000000000001", shopperKey: null }) as const;
    const now = Date.UTC(2027, 0, 20);
    await subject.store.ingest("c", [view(1)], now);
    const t1 = (await raw.query<{ t: string }>("SELECT extract(epoch FROM applied_through)::text AS t FROM analytics_rollup_watermarks WHERE consumer = 'seller-analytics'")).rows[0]?.t;
    expect(Math.round(Number(t1) * 1000)).toBe(now);
    const held = Date.UTC(2027, 0, 19, 12);
    await raw.query(
      "INSERT INTO outbox_events (id, occurred_at, aggregate_type, aggregate_id, event_type, payload) VALUES ($1, $2, 'order', $3, 'order_line.purchased', '{}'::jsonb)",
      ["00000000-0000-4000-8000-0000000007aa", new Date(held).toISOString(), "00000000-0000-4000-8000-0000000007ab"],
    );
    await subject.store.ingest("c", [view(2)], now + 60_000);
    // Monotone: the watermark never moves backwards even though an older event is still unpublished.
    const t2 = (await raw.query<{ t: string }>("SELECT extract(epoch FROM applied_through)::text AS t FROM analytics_rollup_watermarks WHERE consumer = 'seller-analytics'")).rows[0]?.t;
    expect(Math.round(Number(t2) * 1000)).toBe(now);
    await raw.exec("DELETE FROM analytics_rollup_watermarks");
    await subject.store.ingest("c", [view(3)], now + 120_000);
    const t3 = (await raw.query<{ t: string }>("SELECT extract(epoch FROM applied_through)::text AS t FROM analytics_rollup_watermarks WHERE consumer = 'seller-analytics'")).rows[0]?.t;
    expect(Math.round(Number(t3) * 1000)).toBe(held);
  });
});
