import { z } from "zod";
import type { Clock } from "../../../platform/ports";
import {
  StaleIndexSourceError,
  type IndexSourcePort,
  type SearchIndexWriter,
  type SearchSyncMetrics,
} from "../domain/ports";

/** Catalog outbox events that change what search shows. */
export const SEARCH_SYNC_CONSUMED_EVENTS = ["product.created", "product.updated", "product.status_changed"] as const;
const CONSUMED: ReadonlySet<string> = new Set(SEARCH_SYNC_CONSUMED_EVENTS);

const Payload = z.object({
  productId: z.string().uuid(),
  version: z.number().int().nonnegative(),
});

export interface SearchSyncEvent {
  readonly messageId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly occurredAtMs?: number;
}

export interface SearchSyncDeps {
  readonly source: IndexSourcePort;
  readonly writer: SearchIndexWriter;
  readonly metrics: SearchSyncMetrics;
  readonly clock: Pick<Clock, "nowMs">;
}

/**
 * Keeps the search read model in step with the catalog (spec section 4: index sync through outbox events).
 *
 * The event is only a trigger: the handler re-reads the product from the catalog and writes that state, so
 * duplicates, replays and out-of-order delivery all converge on the current catalog row. A catalog read that is
 * older than the event (replica lag) throws StaleIndexSourceError so the relay retries with backoff and finally
 * dead-letters; it is never written. The relay's inbox consumer records message_id in inbox_processed in the
 * same transaction as this handler (A2.7); the index write itself is an idempotent upsert/delete.
 * Writes for one product are serialized inside the process so a slower earlier handler cannot overwrite a newer row.
 */
export class SearchSyncConsumer {
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: SearchSyncDeps) {}

  async handle(e: SearchSyncEvent): Promise<void> {
    if (!CONSUMED.has(e.type)) return;
    const parsed = Payload.safeParse(e.payload);
    if (!parsed.success) {
      this.deps.metrics.record("invalid", null);
      return; // a malformed event can never succeed: acknowledge instead of dead-lettering forever
    }
    const { productId, version } = parsed.data;
    const prev = this.tails.get(productId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.apply(productId, version, e.occurredAtMs));
    this.tails.set(productId, run);
    try {
      await run;
    } finally {
      if (this.tails.get(productId) === run) this.tails.delete(productId);
    }
  }

  private async apply(productId: string, eventVersion: number, occurredAtMs: number | undefined): Promise<void> {
    const { source, writer, metrics, clock } = this.deps;
    const loaded = await source.load(productId);
    const lag = occurredAtMs === undefined ? null : Math.max(0, (clock.nowMs() - occurredAtMs) / 1000);
    if (loaded.kind === "absent") {
      await writer.remove(productId);
      metrics.record("removed", lag);
      return;
    }
    if (loaded.version < eventVersion) {
      metrics.record("stale_retry", null);
      throw new StaleIndexSourceError(productId, eventVersion, loaded.version);
    }
    if (loaded.kind === "unlisted") {
      await writer.remove(productId);
      metrics.record("removed", lag);
      return;
    }
    await writer.upsert(loaded.doc);
    metrics.record("indexed", lag);
  }
}
