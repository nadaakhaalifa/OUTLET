import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { createLogger } from "@outlet/logger";
import type { Logger } from "@outlet/logger";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import type { InboxOutcome } from "@outlet/outbox";
import { ATTENTION_CONSUMER, ATTENTION_OPENED_EVENT, draftFor, isAttentionKind } from "./domain.js";

export interface AttentionEventIn {
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Inbox consumer of the three attention events (refund.attention, promotions.settle_attention, shipment.cancel_attention), worker job
 * `ops.attention` (migration 0033). One transaction: inbox row, upsert of the attention item (UNIQUE (kind, ref_id): a replay or a repeated
 * failure for the same entity refreshes the payload of a non-resolved item and never duplicates it), and `ops.attention_opened` only when
 * the item is new. A malformed payload or an unknown type is parked (inbox row + error log, no item) so it cannot loop.
 */
export class AttentionConsumer {
  private readonly outbox: OutboxWriter;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: Logger;
  constructor(
    private readonly client: RoleSqlClient<"outlet_worker">,
    private readonly marketId: string,
    opts: { readonly outbox?: OutboxWriter; readonly now?: () => Date; readonly newId?: () => string; readonly log?: Logger } = {},
  ) {
    this.outbox = opts.outbox ?? new OutboxWriter(pgTransactionalWriter);
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => uuidv7());
    this.log = opts.log ?? createLogger();
  }

  async handle(event: AttentionEventIn): Promise<InboxOutcome> {
    const seen = await this.tx((tx) => tx.query("SELECT 1 FROM inbox_processed WHERE consumer = $1 AND message_id = $2", [ATTENTION_CONSUMER, event.id]));
    if (seen.rows.length > 0) return "duplicate";
    const draft = isAttentionKind(event.type) ? draftFor(event.type, event.payload, event.id) : null;
    return this.tx(async (tx) => {
      const ins = await tx.query("INSERT INTO inbox_processed (consumer, message_id) VALUES ($1, $2) ON CONFLICT (consumer, message_id) DO NOTHING RETURNING message_id", [ATTENTION_CONSUMER, event.id]);
      if (ins.rows.length === 0) return "duplicate";
      if (draft === null) {
        this.log.error("ops.attention: event parked, not queued", { event_id: event.id, type: event.type, reason: isAttentionKind(event.type) ? "invalid_payload" : "unknown_type" });
        return "processed";
      }
      const at = this.now().toISOString();
      const id = this.newId();
      const payload = JSON.stringify(draft.payload);
      const created = await tx.query(
        "INSERT INTO attention_items (id, market_id, kind, ref_type, ref_id, payload, created_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz) ON CONFLICT (kind, ref_id) DO NOTHING RETURNING id",
        [id, this.marketId, draft.kind, draft.refType, draft.refId, payload, at],
      );
      if (created.rows.length === 0) {
        await tx.query("UPDATE attention_items SET payload = $3::jsonb WHERE kind = $1 AND ref_id = $2 AND status <> 'RESOLVED'", [draft.kind, draft.refId, payload]);
        return "processed";
      }
      await this.outbox.append(tx, {
        id: this.newId(), type: ATTENTION_OPENED_EVENT, aggregateType: "attention_item", aggregateId: id, marketId: this.marketId, occurredAt: at, visibility: "internal",
        payload: { attention_id: id, kind: draft.kind, ref_type: draft.refType, ref_id: draft.refId, source_event_id: event.id },
      });
      return "processed";
    });
  }

  private tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.client, { kind: "worker", marketId: this.marketId, job: "ops.attention" }, fn);
  }
}
