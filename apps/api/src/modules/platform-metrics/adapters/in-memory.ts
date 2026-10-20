import type { PlatformRollupReader } from "../domain/ports";
import type { HourlyRow } from "../domain/series";

/** DEVELOPMENT AND TEST FIXTURE: platform hourly rows set by hand. */
export class InMemoryPlatformRollups implements PlatformRollupReader {
  readonly rows = new Map<string, HourlyRow[]>();
  asOfMs: number | null = null;
  epoch = 0;
  failWith: Error | null = null;
  reads = 0;

  set(metric: string, hourUtcMs: number, value: bigint, held = 0n): void {
    const list = this.rows.get(metric) ?? [];
    list.push({ hourUtcMs, value, held });
    this.rows.set(metric, list);
  }
  async freshness() {
    if (this.failWith !== null) throw this.failWith;
    return { asOfMs: this.asOfMs, epoch: this.epoch };
  }
  async read(metric: string, fromMs: number, toMs: number): Promise<readonly HourlyRow[]> {
    if (this.failWith !== null) throw this.failWith;
    this.reads += 1;
    return (this.rows.get(metric) ?? []).filter((r) => r.hourUtcMs >= fromMs && r.hourUtcMs < toMs);
  }
}
