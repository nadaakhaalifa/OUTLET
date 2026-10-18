import { instruments } from "../../../platform/telemetry";
import type { SearchSyncMetrics, SearchSyncOutcome } from "../domain/ports";

/** Counter by outcome plus the catalog-event-to-index lag (SLO p95 < 60 s). Telemetry failures never fail a sync. */
export class OtelSearchSyncMetrics implements SearchSyncMetrics {
  record(outcome: SearchSyncOutcome, lagSeconds: number | null): void {
    try {
      const i = instruments();
      i.counter("outlet.search.sync.events").add(1, { outcome });
      if (lagSeconds !== null) i.histogram("outlet.search.sync.lag").record(lagSeconds);
    } catch {
      // best effort
    }
  }
}

export class NoopSearchSyncMetrics implements SearchSyncMetrics {
  record(): void {}
}
