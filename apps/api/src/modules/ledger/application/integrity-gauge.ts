import type { Clock } from "../../../platform/ports";
import { gaugeValues, type GaugeValues } from "../domain/integrity-runs";
import type { IntegrityRunReader } from "../domain/ports";

/**
 * Reader for the table-backed gauges (H5). The row is cached for `ttlMs` (default 30 s, one indexed
 * query per interval) but the age is recomputed from the clock on EVERY collection, so it keeps
 * growing when nothing completes. Reads as `system`; a read failure propagates (the exporter then
 * reports nothing, which the absence rule treats as a fault).
 */
export function cachedGaugeReader(reader: IntegrityRunReader, clock: Clock, ttlMs = 30_000): () => Promise<GaugeValues> {
  let cache: { readonly atMs: number; readonly latest: Awaited<ReturnType<IntegrityRunReader["snapshot"]>> } | null = null;
  return async () => {
    const now = clock.nowMs();
    if (cache === null || now - cache.atMs >= ttlMs || now < cache.atMs) {
      cache = { atMs: now, latest: await reader.snapshot({ actorId: null, role: "system" }) };
    }
    return gaugeValues(cache.latest.latest, cache.latest.firstStartedAtMs, now);
  };
}
