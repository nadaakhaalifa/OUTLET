import type { Queryable, SqlClient } from "./ports.js";

export type InboxOutcome = "processed" | "duplicate";

/**
 * Exactly-once *effect* on top of at-least-once delivery: the (consumer, message_id) row and the
 * handler's writes commit together. A duplicate delivery is a no-op; a throwing handler rolls
 * back both, so the message can be redelivered.
 */
export class InboxProcessor {
  constructor(private readonly db: SqlClient) {}

  process(consumer: string, messageId: string, handler: (tx: Queryable) => Promise<void>): Promise<InboxOutcome> {
    return this.db.transaction(async (tx) => {
      const r = await tx.query(
        "INSERT INTO inbox_processed (consumer, message_id) VALUES ($1, $2) ON CONFLICT (consumer, message_id) DO NOTHING RETURNING message_id",
        [consumer, messageId],
      );
      if (r.rows.length === 0) return "duplicate";
      await handler(tx);
      return "processed";
    });
  }
}
