import type { Queryable } from "@outlet/db";
import { SYNC_EVENT_TYPES } from "./index-sync.js";

/** Staleness SLO (master prompt section 4): index lags the source by less than 60 s. */
export const STALENESS_SLO_MS = 60_000;

export interface PendingSource {
  /** occurred_at of the oldest sync-relevant event not yet published by the outbox relay, or null when none pend. */
  oldestPendingOccurredAt(): Promise<Date | null>;
  /** Sync-relevant events the relay gave up on (dead-lettered): their documents never converge by themselves. */
  deadLetteredCount(): Promise<number>;
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
  async deadLetteredCount() {
    const r = await db.query<{ n: number | string }>(
      "SELECT count(*) AS n FROM outbox_events WHERE market_id = $1 AND dead_lettered_at IS NOT NULL AND event_type = ANY($2::text[])",
      [marketId, [...SYNC_EVENT_TYPES]],
    );
    return Number(r.rows[0]?.n ?? 0);
  },
});

export interface EngineState {
  /** False while no external engine is chosen or contracted (ADR-0010, ADR-0029): nothing is indexed externally. */
  readonly configured: boolean;
  /** Documents whose seq is ahead of what the engine holds (all of them when never mirrored). */
  readonly unsyncedDocuments: number;
  readonly oldestUnsyncedAt: Date | null;
}

export interface EngineSyncSource {
  state(): Promise<EngineState>;
}

/** Needs a context that may read search_documents (worker job search.sync, or outlet_app in a user context). */
export const engineSyncSource = (db: Queryable, marketId: string, configured: boolean): EngineSyncSource => ({
  async state() {
    const r = await db.query<{ n: number | string; oldest: Date | string | null }>(
      "SELECT count(*) AS n, min(updated_at) AS oldest FROM search_documents WHERE market_id = $1 AND engine_synced_seq IS DISTINCT FROM seq",
      [marketId],
    );
    const o = r.rows[0]?.oldest;
    return { configured, unsyncedDocuments: Number(r.rows[0]?.n ?? 0), oldestUnsyncedAt: o === null || o === undefined ? null : new Date(o) };
  },
});

/**
 * fresh: the read model follows the source AND the external engine mirrors it.
 * search_provider_unconfigured: the Postgres read model is current (FTS serves) but no external engine exists, so nothing is indexed externally. Never "fresh".
 * stale: an event (or, with a configured engine, an unmirrored document) has waited past the SLO, or an event was dead-lettered.
 */
export type SearchFreshness = "fresh" | "stale" | "search_provider_unconfigured";

export interface StalenessReading {
  /** Worst lag in ms: oldest pending sync event, and (when an engine is configured) the oldest document it has not mirrored. 0 when none. */
  readonly stalenessMs: number;
  readonly breached: boolean;
  readonly status: SearchFreshness;
  readonly deadLettered: number;
  readonly unsyncedDocuments: number;
}

/** Gauge value for the SLO (export `stalenessMs` as search_index_staleness_ms) plus an honest status (export `status` as a label). */
export const measureStaleness = async (source: PendingSource, now: Date, engine: EngineSyncSource): Promise<StalenessReading> => {
  const [oldest, deadLettered, eng] = await Promise.all([source.oldestPendingOccurredAt(), source.deadLetteredCount(), engine.state()]);
  const lag = (d: Date | null): number => (d === null ? 0 : Math.max(0, now.getTime() - d.getTime()));
  const stalenessMs = Math.max(lag(oldest), eng.configured ? lag(eng.oldestUnsyncedAt) : 0);
  const breached = stalenessMs >= STALENESS_SLO_MS;
  const status: SearchFreshness = breached || deadLettered > 0 ? "stale" : !eng.configured ? "search_provider_unconfigured" : "fresh";
  return { stalenessMs, breached, status, deadLettered, unsyncedDocuments: eng.unsyncedDocuments };
};
