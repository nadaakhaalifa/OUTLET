import { outboxEventSchema } from "./event.js";
import type { OutboxEvent, OutboxEventInput } from "./event.js";
import type { Queryable, TransactionalWriter } from "./ports.js";

/** Postgres implementation: one INSERT in the caller's transaction. */
export const pgTransactionalWriter: TransactionalWriter = {
  async insertEvent(tx, e) {
    await tx.query(
      `INSERT INTO outbox_events (id, market_id, aggregate_type, aggregate_id, event_type, visibility, payload, trace_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
      [e.id, e.marketId, e.aggregateType, e.aggregateId, e.type, e.visibility, JSON.stringify(e.payload), e.traceId ?? null, e.occurredAt],
    );
  },
};

/** Validates the envelope, then appends inside the caller's transaction (commit/rollback is the caller's). */
export class OutboxWriter<Tx = Queryable> {
  constructor(private readonly writer: TransactionalWriter<Tx>) {}

  async append(tx: Tx, input: OutboxEventInput): Promise<OutboxEvent> {
    const event = outboxEventSchema.parse(input);
    await this.writer.insertEvent(tx, event);
    return event;
  }
}
