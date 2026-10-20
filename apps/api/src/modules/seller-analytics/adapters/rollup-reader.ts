import { sql } from "kysely";
import { z } from "zod";
import type { RollupKey } from "../domain/bridge";
import type { HourlyRow } from "../../platform-metrics";
import type { SellerRollupReader } from "../domain/series-ports";
import type { SellerAnalyticsDb } from "./db";
import type { InMemoryRollups } from "./in-memory-rollups";
import { AnalyticsDependencyUnavailableError } from "../domain/ports";

const Big = z.union([z.bigint(), z.number(), z.string()]).transform((v) => BigInt(v));
const Ms = z.union([z.number(), z.string()]).transform((v) => Math.round(Number(v)));
const Row = z.object({ ms: Ms, value: Big, held: Big });
const Fresh = z.object({ ms: Ms.nullable(), epoch: Big });

/** Reads `seller_analytics_hourly` under the caller's RLS context (the db handle is already store-scoped by the adapter in production). */
export class KyselySellerRollupReader implements SellerRollupReader {
  constructor(private readonly db: SellerAnalyticsDb, private readonly watermarkConsumer = "seller-analytics") {}

  async freshness(): Promise<{ asOfMs: number | null; epoch: number }> {
    try {
      const r = await sql`
        select (select floor(extract(epoch from applied_through) * 1000) from analytics_rollup_watermarks where consumer = ${this.watermarkConsumer}) as ms,
               (select count(*) from analytics_rollup_reconciliations where corrected > 0 and scope = 'seller') as epoch`.execute(this.db);
      const row = Fresh.parse(r.rows[0]);
      return { asOfMs: row.ms, epoch: Number(row.epoch) };
    } catch {
      throw new AnalyticsDependencyUnavailableError("rollup freshness");
    }
  }

  async read(storeId: string, metric: string, fromMs: number, toMs: number): Promise<readonly HourlyRow[]> {
    try {
      const r = await sql`
        select floor(extract(epoch from hour_utc) * 1000) as ms, value, held_value as held
        from seller_analytics_hourly
        where store_id = ${storeId}::uuid and metric = ${metric}
          and hour_utc >= to_timestamp(${fromMs}::double precision / 1000.0)
          and hour_utc < to_timestamp(${toMs}::double precision / 1000.0)
        order by hour_utc`.execute(this.db);
      return r.rows.map((x) => {
        const p = Row.parse(x);
        return { hourUtcMs: p.ms, value: p.value, held: p.held };
      });
    } catch {
      throw new AnalyticsDependencyUnavailableError("rollup read");
    }
  }
}

/** DEVELOPMENT AND TEST FIXTURE: reads the in-memory store's rollup rows. */
export class InMemorySellerRollupReader implements SellerRollupReader {
  reads = 0;
  failWith: Error | null = null;
  constructor(private readonly rollups: InMemoryRollups, private readonly watermark: () => number | null = () => rollups.watermarkMs) {}

  async freshness() {
    if (this.failWith !== null) throw this.failWith;
    return { asOfMs: this.watermark(), epoch: this.rollups.reconciliations.filter((r) => r.corrected > 0 && r.scope === "seller").length };
  }
  async read(storeId: string, metric: string, fromMs: number, toMs: number): Promise<readonly HourlyRow[]> {
    if (this.failWith !== null) throw this.failWith;
    this.reads += 1;
    const out: HourlyRow[] = [];
    for (const row of this.rollups.rows.values()) {
      const k: RollupKey = row.key;
      if (k.scope !== "seller" || k.storeId !== storeId || k.metric !== metric) continue;
      if (k.hourUtcMs < fromMs || k.hourUtcMs >= toMs) continue;
      out.push({ hourUtcMs: k.hourUtcMs, value: row.value, held: row.held });
    }
    return out.sort((a, b) => a.hourUtcMs - b.hourUtcMs);
  }
}
