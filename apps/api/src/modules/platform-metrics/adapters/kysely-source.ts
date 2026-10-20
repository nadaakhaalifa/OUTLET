import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { PlatformRollupReader, RollupFreshness } from "../domain/ports";
import type { HourlyRow } from "../domain/series";

export type PlatformMetricsDb = Kysely<Record<string, never>>;

const Big = z.union([z.bigint(), z.number(), z.string()]).transform((v) => BigInt(v));
const Ms = z.union([z.number(), z.string()]).transform((v) => Math.round(Number(v)));
const Row = z.object({ ms: Ms, value: Big });
const Fresh = z.object({ ms: Ms.nullable(), epoch: Big });

/** `analytics_rollup_watermarks.consumer` of the seller-analytics consumer, which also writes the platform rollups. */
export const PLATFORM_WATERMARK_CONSUMER = "seller-analytics";

/** Reads `platform_metrics_hourly` (migration 0088). Raw SQL, rows validated with Zod; platform rows carry no held column. */
export class KyselyPlatformRollups implements PlatformRollupReader {
  constructor(private readonly db: PlatformMetricsDb) {}

  async freshness(): Promise<RollupFreshness> {
    const r = await sql`
      select (select floor(extract(epoch from applied_through) * 1000) from analytics_rollup_watermarks where consumer = ${PLATFORM_WATERMARK_CONSUMER}) as ms,
             (select count(*) from analytics_rollup_reconciliations where corrected > 0 and scope = 'platform') as epoch`.execute(this.db);
    const row = Fresh.parse(r.rows[0]);
    return { asOfMs: row.ms, epoch: Number(row.epoch) };
  }

  async read(metric: string, fromMs: number, toMs: number): Promise<readonly HourlyRow[]> {
    const r = await sql`
      select floor(extract(epoch from hour_utc) * 1000) as ms, value
      from platform_metrics_hourly
      where metric = ${metric}
        and hour_utc >= to_timestamp(${fromMs}::double precision / 1000.0)
        and hour_utc < to_timestamp(${toMs}::double precision / 1000.0)
      order by hour_utc`.execute(this.db);
    return r.rows.map((x) => {
      const p = Row.parse(x);
      return { hourUtcMs: p.ms, value: p.value, held: 0n };
    });
  }
}
