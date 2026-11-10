import { uuidv7 } from "@outlet/ids";
import { errorCode } from "./dispatch.js";
import { toEvent } from "./row.js";
import type { OutboxRow } from "./row.js";
import type { Publisher, SqlClient } from "./ports.js";

export interface RelayOptions {
  readonly db: SqlClient;
  readonly publisher: Publisher;
  /** Rows claimed per poll. Default 100. */
  readonly batchSize?: number;
  /** Failed publishes before the event is dead-lettered. Default 5. */
  readonly maxAttempts?: number;
  readonly now?: () => Date;
}

export interface RelayResult {
  readonly published: number;
  readonly failed: number;
  readonly deadLettered: number;
}

type Row = OutboxRow;

/**
 * Polls unpublished events in id (UUIDv7, so commit-ish) order. Rows are claimed with
 * FOR UPDATE SKIP LOCKED inside one transaction, so concurrent relays take disjoint rows.
 * A crash after publish but before commit re-publishes (at-least-once): consumers must dedupe via the inbox.
 * A failing event is retried on later polls; after maxAttempts it is dead-lettered (dlq_messages).
 */
export class OutboxRelay {
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly now: () => Date;

  constructor(private readonly opts: RelayOptions) {
    this.batchSize = opts.batchSize ?? 100;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.now = opts.now ?? ((): Date => new Date());
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1) throw new RangeError("batchSize must be >= 1");
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) throw new RangeError("maxAttempts must be >= 1");
  }

  runOnce(): Promise<RelayResult> {
    return this.opts.db.transaction(async (tx) => {
      const { rows } = await tx.query<Row>(
        `SELECT id, market_id, aggregate_type, aggregate_id, event_type, visibility, payload, trace_id, occurred_at, attempts
           FROM outbox_events
          WHERE published_at IS NULL AND dead_lettered_at IS NULL
          ORDER BY id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      );
      let published = 0;
      let failed = 0;
      let deadLettered = 0;
      for (const row of rows) {
        try {
          await this.opts.publisher.publish(toEvent(row));
          await tx.query("UPDATE outbox_events SET published_at = $2, attempts = attempts + 1, last_error = NULL WHERE id = $1", [
            row.id,
            this.now().toISOString(),
          ]);
          published += 1;
        } catch (err) {
          const attempts = row.attempts + 1;
          const error = errorCode(err); // never the message: it may echo payload fields (P2)
          if (attempts >= this.maxAttempts) {
            await tx.query("UPDATE outbox_events SET attempts = $2, last_error = $3, dead_lettered_at = $4 WHERE id = $1", [
              row.id,
              attempts,
              error,
              this.now().toISOString(),
            ]);
            await tx.query(
              "INSERT INTO dlq_messages (id, consumer, message_id, payload, error, attempts) VALUES ($1, 'outbox-relay', $2, $3::jsonb, $4, $5)",
              [uuidv7(), row.id, JSON.stringify({ event_type: row.event_type }), error, attempts],
            );
            deadLettered += 1;
          } else {
            await tx.query("UPDATE outbox_events SET attempts = $2, last_error = $3 WHERE id = $1", [row.id, attempts, error]);
            failed += 1;
          }
        }
      }
      return { published, failed, deadLettered };
    });
  }
}
