import { outboxEventSchema } from "./event.js";
import type { OutboxEvent } from "./event.js";

/** One outbox_events row as the relays read it. */
export interface OutboxRow {
  id: string;
  market_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  visibility: string;
  payload: Record<string, unknown>;
  trace_id: string | null;
  occurred_at: Date | string;
  attempts: number;
}

export const OUTBOX_ROW_COLUMNS = "id, market_id, aggregate_type, aggregate_id, event_type, visibility, payload, trace_id, occurred_at, attempts";

export const toEvent = (r: OutboxRow): OutboxEvent =>
  outboxEventSchema.parse({
    id: r.id,
    type: r.event_type,
    aggregateType: r.aggregate_type,
    aggregateId: r.aggregate_id,
    marketId: r.market_id,
    occurredAt: new Date(r.occurred_at).toISOString(),
    visibility: r.visibility,
    ...(r.trace_id === null ? {} : { traceId: r.trace_id }),
    payload: r.payload,
  });
