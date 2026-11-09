import { uuidv7 } from "@outlet/ids";
import type { OutboxEvent } from "./event.js";
import type { SqlClient } from "./ports.js";
import { OUTBOX_ROW_COLUMNS, toEvent } from "./row.js";
import type { OutboxRow } from "./row.js";

export interface DispatchRelayOptions {
  /** outlet_worker bound to job `outbox.relay` and ONE market (the relay policies pin app.current_market_id()). */
  readonly db: SqlClient;
  /** Delivers one event to its in-process consumer. Must throw on failure; may be called again for the same id (at-least-once). */
  readonly dispatch: (event: OutboxEvent) => Promise<void>;
  /** Rows claimed per poll. Default 20 (each row is one handler run while the claim lease runs). */
  readonly batchSize?: number;
  /** Failed dispatches before the event is dead-lettered. Default 8. */
  readonly maxAttempts?: number;
  /** How long a claim stays exclusive. Must exceed batchSize x the per-handler timeout. Default 5 minutes. */
  readonly leaseMs?: number;
  /** Delay before a failed event is claimable again, by attempt number (1-based). Default 2^attempt seconds, capped at 5 minutes. */
  readonly backoffMs?: (attempt: number) => number;
  readonly now?: () => Date;
}

export interface DispatchRunOptions {
  /** Event types not to claim this poll (their consumer is kill-switched): they stay unpublished, untouched and keep their place. */
  readonly excludeTypes?: readonly string[];
  /** Checked before each dispatch; once true the rest of the batch is released (lease cleared) for the next poll or replica. */
  readonly shouldStop?: () => boolean;
}

export interface DispatchResult {
  readonly claimed: number;
  readonly dispatched: number;
  readonly failed: number;
  readonly deadLettered: number;
  readonly released: number;
}

export interface PendingByType {
  readonly type: string;
  readonly pending: number;
  readonly oldestOccurredAt: Date;
}

export const defaultBackoffMs = (attempt: number): number => Math.min(2 ** attempt * 1_000, 300_000);

/**
 * Short code for last_error / dlq: the error's name plus a string `code` when it has one. Never the message, which may echo payload fields (P2).
 */
export const errorCode = (e: unknown): string => {
  if (!(e instanceof Error)) return "non_error_thrown";
  const code = "code" in e && typeof e.code === "string" ? `:${e.code}` : "";
  return `${e.name}${code}`.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120);
};

/**
 * Outbox relay for in-process consumers (ADR-0016). Three short transactions per event instead of one long one:
 *   1. claim: lease_until = now + leaseMs on up to batchSize unpublished, unleased rows (FOR UPDATE SKIP LOCKED, id order), so replicas claim disjoint rows;
 *   2. dispatch: the consumer runs its own inbox transaction (no claim lock is held, so it may use any connection);
 *   3. ack: published_at set and lease cleared; or, on failure, attempts + 1, last_error = errorCode, lease pushed by backoffMs; at maxAttempts the row is
 *      dead-lettered (dead_lettered_at + dlq_messages, consumer 'outbox-dispatch').
 * A crash between 2 and 3 leaves the lease to expire: the event is redelivered and the consumer's inbox row makes the replay a no-op.
 */
export class OutboxDispatchRelay {
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly leaseMs: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly now: () => Date;

  constructor(private readonly opts: DispatchRelayOptions) {
    this.batchSize = opts.batchSize ?? 20;
    this.maxAttempts = opts.maxAttempts ?? 8;
    this.leaseMs = opts.leaseMs ?? 300_000;
    this.backoffMs = opts.backoffMs ?? defaultBackoffMs;
    this.now = opts.now ?? ((): Date => new Date());
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1) throw new RangeError("batchSize must be >= 1");
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) throw new RangeError("maxAttempts must be >= 1");
    if (!Number.isInteger(this.leaseMs) || this.leaseMs < 1_000) throw new RangeError("leaseMs must be >= 1000");
  }

  async runOnce(run: DispatchRunOptions = {}): Promise<DispatchResult> {
    const rows = await this.claim(run.excludeTypes ?? []);
    let dispatched = 0;
    let failed = 0;
    let deadLettered = 0;
    const left: string[] = [];
    for (const row of rows) {
      if (left.length > 0 || run.shouldStop?.() === true) {
        left.push(row.id);
        continue;
      }
      try {
        await this.opts.dispatch(toEvent(row));
      } catch (err) {
        if (await this.fail(row, errorCode(err))) deadLettered += 1;
        else failed += 1;
        continue;
      }
      await this.ack(row.id);
      dispatched += 1;
    }
    if (left.length > 0) await this.release(left);
    return { claimed: rows.length, dispatched, failed, deadLettered, released: left.length };
  }

  /** Unpublished, not dead-lettered events of the given types: count and oldest occurred_at per type (consumer lag). */
  async pending(types: readonly string[]): Promise<readonly PendingByType[]> {
    if (types.length === 0) return [];
    const { rows } = await this.opts.db.query<{ event_type: string; pending: number; oldest: Date | string }>(
      `SELECT event_type, count(*)::int AS pending, min(occurred_at) AS oldest
         FROM outbox_events
        WHERE published_at IS NULL AND dead_lettered_at IS NULL AND event_type = ANY($1::text[])
        GROUP BY event_type`,
      [types],
    );
    return rows.map((r) => ({ type: r.event_type, pending: r.pending, oldestOccurredAt: new Date(r.oldest) }));
  }

  private async claim(exclude: readonly string[]): Promise<OutboxRow[]> {
    const now = this.now();
    const { rows } = await this.opts.db.query<OutboxRow>(
      `UPDATE outbox_events o SET lease_until = $2::timestamptz
         FROM (SELECT id FROM outbox_events
                WHERE published_at IS NULL AND dead_lettered_at IS NULL
                  AND (lease_until IS NULL OR lease_until <= $3::timestamptz)
                  AND NOT (event_type = ANY($4::text[]))
                ORDER BY id
                LIMIT $1
                FOR UPDATE SKIP LOCKED) c
        WHERE o.id = c.id
        RETURNING ${OUTBOX_ROW_COLUMNS.split(", ").map((c) => `o.${c}`).join(", ")}`,
      [this.batchSize, new Date(now.getTime() + this.leaseMs).toISOString(), now.toISOString(), [...exclude]],
    );
    return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private async ack(id: string): Promise<void> {
    await this.opts.db.query("UPDATE outbox_events SET published_at = $2::timestamptz, attempts = attempts + 1, last_error = NULL, lease_until = NULL WHERE id = $1 AND published_at IS NULL", [
      id,
      this.now().toISOString(),
    ]);
  }

  /** Records a failed dispatch; true when the event was dead-lettered. */
  private fail(row: OutboxRow, code: string): Promise<boolean> {
    const attempts = row.attempts + 1;
    const now = this.now();
    if (attempts < this.maxAttempts) {
      return this.opts.db
        .query("UPDATE outbox_events SET attempts = $2, last_error = $3, lease_until = $4::timestamptz WHERE id = $1", [
          row.id,
          attempts,
          code,
          new Date(now.getTime() + this.backoffMs(attempts)).toISOString(),
        ])
        .then(() => false);
    }
    return this.opts.db.transaction(async (tx) => {
      await tx.query("UPDATE outbox_events SET attempts = $2, last_error = $3, dead_lettered_at = $4::timestamptz, lease_until = NULL WHERE id = $1", [row.id, attempts, code, now.toISOString()]);
      await tx.query("INSERT INTO dlq_messages (id, consumer, message_id, payload, error, attempts) VALUES ($1, 'outbox-dispatch', $2, $3::jsonb, $4, $5)", [
        uuidv7(),
        row.id,
        JSON.stringify({ event_type: row.event_type }),
        code,
        attempts,
      ]);
      return true;
    });
  }

  private async release(ids: readonly string[]): Promise<void> {
    await this.opts.db.query("UPDATE outbox_events SET lease_until = NULL WHERE id = ANY($1::uuid[]) AND published_at IS NULL", [[...ids]]);
  }
}
