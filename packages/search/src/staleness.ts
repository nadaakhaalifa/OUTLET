import type { Queryable } from "@outlet/db";
import { SYNC_EVENT_TYPES } from "./index-sync.js";

/** Staleness SLO (master prompt section 4): index lags the source by less than 60 s. */
export const STALENESS_SLO_MS = 60_000;

export interface PendingSource {
  /** occurred_at of the oldest sync-relevant event not yet published by the outbox relay, or null when none pend. */
  oldestPendingOccurredAt(): Promise<Date | null>;
}

/** Needs a context that may read outbox_events (the outbox.relay worker context, which already owns that policy). */
export const outboxPendingSource = (db: Queryable, marketId: string): PendingSource => ({
  async oldestPendingOccurredAt() {
    const r = await db.query<{ oldest: Date | string | null }>(
      "SELECT min(occurred_at) AS oldest FROM outbox_events WHERE market_id = $1 AND published_at IS NULL AND dead_lettered_at IS NULL AND event_type = ANY($2::text[])",
      [marketId, [...SYNC_EVENT_TYPES]],
    );
    const o = r.rows[0]?.oldest;
    return o === null || o === undefined ? null : new Date(o);
  },
});

export interface StalenessReading {
  readonly stalenessMs: number;
  readonly breached: boolean;
}

/** Gauge value for the SLO: now minus the oldest pending event (0 when nothing pends). Export `stalenessMs` as search_index_staleness_ms. */
export const measureStaleness = async (source: PendingSource, now: Date): Promise<StalenessReading> => {
  const oldest = await source.oldestPendingOccurredAt();
  const stalenessMs = oldest === null ? 0 : Math.max(0, now.getTime() - oldest.getTime());
  return { stalenessMs, breached: stalenessMs >= STALENESS_SLO_MS };
};
