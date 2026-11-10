import { contextClient } from "@outlet/db";
import type { RoleSqlClient } from "@outlet/db";
import { createLogger } from "@outlet/logger";
import type { Logger } from "@outlet/logger";
import { InboxProcessor } from "@outlet/outbox";
import type { InboxOutcome, OutboxEvent } from "@outlet/outbox";
import { SEARCH_SYNC_CONSUMER, SYNC_EVENT_TYPES, SearchIndexSync, isValidSyncPayload } from "./index-sync.js";
import type { SyncOutcome } from "./index-sync.js";
import type { PriceDisplayLookup } from "./ports.js";

/** What the worker runner hands a handler. occurredAt is the source event time: it is the document version, so a handler cannot order events without it. */
export interface SearchEventIn {
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt?: string;
}

export const SEARCH_SYNC_JOB = "search.sync" as const;

/**
 * Inbox consumer of the five search sync events (worker job `search.sync`, migration 0038). Everything runs under the worker context
 * { job: "search.sync", market }, so only the grants and policies of that job apply. A malformed payload, or an event without a usable occurredAt
 * (cannot be versioned), is parked: inbox row plus error log, no write, so it cannot loop to the DLQ. Database errors propagate (retry, then DLQ).
 * `display` MUST be composed on the same worker context (pricing reads: price_events, price_claims). It never touches the external engine: that is
 * mirrored separately from the Postgres read model by `reconcileEngine`, so an unconfigured engine never blocks or fakes the sync.
 */
export class SearchSyncConsumer {
  private readonly sync: SearchIndexSync;
  private readonly inbox: InboxProcessor;
  private readonly log: Logger;
  constructor(client: RoleSqlClient<"outlet_worker">, private readonly marketId: string, display: PriceDisplayLookup, log?: Logger) {
    const scoped = contextClient(client, { kind: "worker", marketId, job: SEARCH_SYNC_JOB });
    this.sync = new SearchIndexSync(scoped, display);
    this.inbox = new InboxProcessor(scoped);
    this.log = log ?? createLogger();
  }

  async handle(event: SearchEventIn): Promise<InboxOutcome> {
    const known = (SYNC_EVENT_TYPES as readonly string[]).includes(event.type);
    const at = event.occurredAt === undefined ? Number.NaN : Date.parse(event.occurredAt);
    if (!known || Number.isNaN(at) || !isValidSyncPayload(event.type, event.payload)) {
      return this.park(event, !known ? "unknown_type" : Number.isNaN(at) ? "missing_occurred_at" : "invalid_payload");
    }
    const full: OutboxEvent = { id: event.id, type: event.type, aggregateType: "listing", aggregateId: event.id, marketId: this.marketId, occurredAt: new Date(at).toISOString(), visibility: "internal", payload: event.payload };
    const outcome: SyncOutcome = await this.sync.handle(full);
    return outcome === "duplicate" ? "duplicate" : "processed";
  }

  private async park(event: SearchEventIn, reason: string): Promise<InboxOutcome> {
    const res = await this.inbox.process(SEARCH_SYNC_CONSUMER, event.id, () => Promise.resolve());
    if (res === "processed") this.log.error("search.sync: event parked, not indexed", { event_id: event.id, type: event.type, reason });
    return res;
  }
}
