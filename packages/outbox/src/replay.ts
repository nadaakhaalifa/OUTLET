import type { SqlClient } from "./ports.js";

/** One dead-lettered outbox event as ops sees it. Never the payload: the dlq row holds only `{event_type}` and the event is not read for display. */
export interface DlqEntry {
  /** dlq_messages.id (what replay and discard take). */
  readonly id: string;
  /** The outbox event id. */
  readonly messageId: string;
  readonly eventType: string;
  readonly attempts: number;
  /** Error code only (name and code, see errorCode); null when none was recorded. */
  readonly lastError: string | null;
  readonly deadLetteredAt: Date;
}

export interface DlqPage {
  readonly items: readonly DlqEntry[];
  /** dlq id to pass back as `cursor`, or null on the last page. */
  readonly nextCursor: string | null;
}

export type DlqOutcome = "replayed" | "discarded" | "not_in_dlq";
export interface DlqResult {
  readonly id: string;
  readonly outcome: DlqOutcome;
}

/** Fixed discard reasons (kept as the `discarded:<code>` marker in outbox_events.last_error; never free text). */
export const DISCARD_REASON_CODES = ["duplicate", "obsolete", "poison_payload", "handled_manually", "test_data"] as const;
export type DiscardReasonCode = (typeof DISCARD_REASON_CODES)[number];

/** Event types whose loss moves money: discarding one needs a second approver (policy `dlq.discard.money`). */
export const MONEY_EVENT_PREFIXES: readonly string[] = ["refund.", "promotions.", "payout."];
export const MONEY_EVENT_TYPES: readonly string[] = ["order_group.late_payment_refund"];
export const isMoneyEventType = (t: string): boolean => MONEY_EVENT_TYPES.includes(t) || MONEY_EVENT_PREFIXES.some((p) => t.startsWith(p));

interface Row { id: string; message_id: string; event_type: string; attempts: number; last_error: string | null; dead_lettered_at: Date | string }
const MAX_IDS = 50;
const uniq = (ids: readonly string[]): string[] => [...new Set(ids)];

/**
 * Dead-letter queue operations for the relay's DLQ (`dlq_messages`, consumer 'outbox-dispatch'; ADR-0016). Runs on an `outlet_worker` client bound to job
 * `outbox.relay` and ONE market: that job already owns SELECT/UPDATE on outbox_events and ALL on dlq_messages (0007), so no new grant or function is needed.
 * dlq_messages has no market column, so every statement joins outbox_events and pins its market_id (the RLS policy pins it too).
 * Only `open` rows are in the DLQ: a replayed or discarded row stays (status `replayed` / `discarded`, resolved_at set) for the trail and is no longer listed or replayable. A re-dead-lettered event gets a new row.
 */
export class DlqReplay {
  constructor(private readonly db: SqlClient, private readonly now: () => Date = () => new Date()) {}

  async list(marketId: string, cursor?: string, limit = 50): Promise<DlqPage> {
    const n = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const { rows } = await this.db.query<Row>(
      `SELECT d.id, d.message_id, o.event_type, o.attempts, o.last_error, o.dead_lettered_at
         FROM dlq_messages d JOIN outbox_events o ON o.id = d.message_id
        WHERE d.consumer = 'outbox-dispatch' AND d.status = 'open' AND o.market_id = $1 AND o.dead_lettered_at IS NOT NULL
          AND ($2::uuid IS NULL OR d.id < $2::uuid)
        ORDER BY d.id DESC LIMIT $3`,
      [marketId, cursor ?? null, n + 1],
    );
    const page = rows.slice(0, n);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({ id: r.id, messageId: r.message_id, eventType: r.event_type, attempts: r.attempts, lastError: r.last_error, deadLetteredAt: new Date(r.dead_lettered_at) })),
      nextCursor: rows.length > n && last !== undefined ? last.id : null,
    };
  }

  /** Event type per open dlq id (ids not in the DLQ are absent). Read-only; used to route money types to approval before a discard. */
  async lookup(marketId: string, ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const { rows } = await this.db.query<{ id: string; event_type: string }>(
      `SELECT d.id, o.event_type FROM dlq_messages d JOIN outbox_events o ON o.id = d.message_id
        WHERE d.id = ANY($1::uuid[]) AND d.consumer = 'outbox-dispatch' AND d.status = 'open' AND o.market_id = $2`,
      [uniq(ids).slice(0, MAX_IDS), marketId],
    );
    return new Map(rows.map((r) => [r.id, r.event_type]));
  }

  /**
   * Back to the relay: attempts 0, lease and error cleared, dead_lettered_at and published_at cleared, dlq row marked `replayed`: one transaction. Idempotent: an id
   * that is not (or no longer) an open DLQ row of this market is reported `not_in_dlq` and nothing changes. The consumer's inbox row still dedupes a
   * handler that had in fact completed, so a replay never applies an effect twice.
   */
  replay(marketId: string, ids: readonly string[]): Promise<readonly DlqResult[]> {
    return this.settle(marketId, ids, "replayed", async (tx, eventIds) => {
      await tx.query(
        `UPDATE outbox_events SET attempts = 0, last_error = NULL, lease_until = NULL, dead_lettered_at = NULL, published_at = NULL
          WHERE id = ANY($1::uuid[]) AND market_id = $2`,
        [eventIds, marketId],
      );
    });
  }

  /** Gives up on the events: published_at set, last_error = `discarded:<reason>` (dead_lettered_at stays: it WAS dead-lettered); the dlq row becomes `discarded`. Idempotent like replay. */
  discard(marketId: string, ids: readonly string[], reasonCode: DiscardReasonCode): Promise<readonly DlqResult[]> {
    if (!DISCARD_REASON_CODES.includes(reasonCode)) throw new RangeError("unknown discard reason code");
    const at = this.now().toISOString();
    return this.settle(marketId, ids, "discarded", async (tx, eventIds) => {
      await tx.query(
        `UPDATE outbox_events SET published_at = $3::timestamptz, last_error = $4, lease_until = NULL WHERE id = ANY($1::uuid[]) AND market_id = $2`,
        [eventIds, marketId, at, `discarded:${reasonCode}`],
      );
    });
  }

  private settle(
    marketId: string,
    ids: readonly string[],
    outcome: "replayed" | "discarded",
    apply: (tx: { query: SqlClient["query"] }, eventIds: string[]) => Promise<void>,
  ): Promise<readonly DlqResult[]> {
    const wanted = uniq(ids);
    if (wanted.length === 0) return Promise.resolve([]);
    if (wanted.length > MAX_IDS) throw new RangeError(`at most ${String(MAX_IDS)} ids per call`);
    return this.db.transaction(async (tx) => {
      // Row locks in id order (consistent with other writers); a concurrent replay of the same id waits, then finds the row gone.
      const { rows } = await tx.query<{ id: string; message_id: string }>(
        `SELECT d.id, d.message_id FROM dlq_messages d JOIN outbox_events o ON o.id = d.message_id
          WHERE d.id = ANY($1::uuid[]) AND d.consumer = 'outbox-dispatch' AND d.status = 'open' AND o.market_id = $2
          ORDER BY d.id FOR UPDATE OF d, o`,
        [wanted, marketId],
      );
      if (rows.length > 0) {
        await apply(tx, rows.map((r) => r.message_id));
        const dlqIds = rows.map((r) => r.id);
        // The worker role has no DELETE on dlq_messages (0007), and the table already models the outcome: the row stays as `replayed` / `discarded` for the trail.
        await tx.query("UPDATE dlq_messages SET status = $3, resolved_at = $2::timestamptz WHERE id = ANY($1::uuid[])", [dlqIds, this.now().toISOString(), outcome]);
      }
      const done = new Set(rows.map((r) => r.id));
      return wanted.map((id): DlqResult => ({ id, outcome: done.has(id) ? outcome : "not_in_dlq" }));
    });
  }
}
