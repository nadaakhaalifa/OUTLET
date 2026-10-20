import type { HourlyRow } from "../../platform-metrics";

/** Read side of the seller hourly rollups. `freshness` is cheap and runs before the aggregate so an ETag hit skips the read. */
export interface SellerRollupReader {
  freshness(storeId: string): Promise<{ readonly asOfMs: number | null; readonly epoch: number }>;
  read(storeId: string, metric: string, fromMs: number, toMs: number): Promise<readonly HourlyRow[]>;
}
