import { contextClient } from "@outlet/db";
import type { Queryable } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { Ledger } from "@outlet/ledger";
import { money, negate } from "@outlet/money";
import { InboxProcessor } from "@outlet/outbox";
import type { InboxOutcome } from "@outlet/outbox";
import { z } from "zod";
import { DEFAULT_GRACE_DAYS, eligibleAt } from "../domain/eligibility.js";
import { PayoutsError } from "../domain/errors.js";
import { acct } from "./accounts.js";
import type { FinanceDeps } from "./shared.js";
import { toDate } from "./shared.js";

/** The slice of an outbox event the consumers need (relay delivers these; message_id = event id). */
export interface ConsumedEvent {
  readonly id: string;
  readonly type: string;
  readonly aggregateId: string;
  readonly marketId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export const ACCRUE_CONSUMER = "payouts.accrue";
export const AVAILABILITY_CONSUMER = "payouts.availability";

/** B5: the emitter must state the amount left to move (net of anything refunded while pending). A missing amount is rejected, never defaulted. */
export const SellerOrderClosedPayload = z.object({ amount_minor: z.string().regex(/^\d{1,18}$/) });

interface SellerOrderRow {
  id: string;
  store_id: string;
  currency: string;
  status: string;
  funds_flow: string;
  seller_net_minor: string;
  closed_at: Date | string | null;
}

/**
 * Consumes `order_group.paid` (creates PENDING accruals, so sellers see money coming) and `seller_order.closed`
 * (moves seller_pending -> seller_available, chart 4.11 step 3, and makes the accrual AVAILABLE with eligible_at = closed_at + grace).
 * Both run through the inbox: a redelivery is a no-op, a failing handler rolls back its inbox row and its effect together.
 * Only funds_flow = collect_payout is handled: under psp_split the PSP pays the seller (chart 4.1, model (a)).
 */
export class AvailabilityMover {
  private readonly graceDays: number;

  constructor(private readonly deps: FinanceDeps & { readonly graceDays?: number }) {
    this.graceDays = deps.graceDays ?? DEFAULT_GRACE_DAYS;
  }

  private inbox(marketId: string): InboxProcessor {
    return new InboxProcessor(contextClient(this.deps.client, { kind: "worker", marketId, job: "finance.payouts" }));
  }

  onOrderGroupPaid(e: ConsumedEvent): Promise<InboxOutcome> {
    return this.inbox(e.marketId).process(ACCRUE_CONSUMER, e.id, async (tx) => {
      const now = this.deps.now();
      const so = await tx.query<SellerOrderRow>(
        `SELECT id, store_id, currency, status, funds_flow, seller_net_minor::text AS seller_net_minor, closed_at
           FROM seller_orders WHERE order_group_id = $1 AND funds_flow = 'collect_payout' AND seller_net_minor > 0`,
        [e.aggregateId],
      );
      for (const o of so.rows) {
        await tx.query(
          `INSERT INTO payout_accruals (id, seller_order_id, store_id, market_id, amount_minor, currency, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::bigint, $6, 'PENDING', $7::timestamptz, $7::timestamptz) ON CONFLICT (seller_order_id) DO NOTHING`,
          [uuidv7(), o.id, o.store_id, e.marketId, o.seller_net_minor, o.currency, now.toISOString()],
        );
      }
    });
  }

  onSellerOrderClosed(e: ConsumedEvent): Promise<InboxOutcome> {
    return this.inbox(e.marketId).process(AVAILABILITY_CONSUMER, e.id, (tx) => this.moveClosed(tx, e));
  }

  private async moveClosed(tx: Queryable, e: ConsumedEvent): Promise<void> {
    const now = this.deps.now();
    const cur = this.deps.currency;
    const r = await tx.query<SellerOrderRow>(
      `SELECT id, store_id, currency, status, funds_flow, seller_net_minor::text AS seller_net_minor, closed_at FROM seller_orders WHERE id = $1`,
      [e.aggregateId],
    );
    const o = r.rows[0];
    if (!o) throw new PayoutsError("NOT_FOUND", `seller order ${e.aggregateId} not found`);
    if (o.funds_flow !== "collect_payout") return;
    if (o.status !== "CLOSED" || o.closed_at === null) throw new PayoutsError("INVALID_STATE", `seller order ${o.id} is ${o.status}, not CLOSED`);
    if (o.currency !== cur) throw new PayoutsError("CURRENCY_MISMATCH", `seller order ${o.id} is ${o.currency}`);
    const parsed = SellerOrderClosedPayload.safeParse(e.payload);
    if (!parsed.success) throw new PayoutsError("INVALID_INPUT", "seller_order.closed payload is invalid");
    // The emitter states what is left to move (refunds may have taken part of the pending amount before close).
    const amount = BigInt(parsed.data.amount_minor);
    if (amount === 0n) return;
    // Already moved (a relay replay under a new message id): the ledger key is the truth; do not re-check pending, do not post again.
    const done = await tx.query("SELECT 1 FROM journal_entries WHERE idempotency_key = $1", [`line_closed:${o.id}`]);
    if (done.rows.length > 0) return;
    const pending = negate((await Ledger.balance(tx, acct("seller_pending", e.marketId, cur, o.store_id))));
    if (pending.amountMinor < amount) {
      throw new PayoutsError("INSUFFICIENT_PENDING", `seller_pending of ${o.store_id} holds ${pending.amountMinor.toString()}, cannot move ${amount.toString()} (I11)`);
    }
    const closedAt = toDate(o.closed_at);
    const { entryId } = await Ledger.post(tx, {
      kind: "line_closed",
      idempotencyKey: `line_closed:${o.id}`,
      marketId: e.marketId,
      occurredAt: closedAt,
      ref: { type: "seller_order", id: o.id },
      postings: [
        { accountCode: acct("seller_pending", e.marketId, cur, o.store_id), amount: money(amount, cur) },
        { accountCode: acct("seller_available", e.marketId, cur, o.store_id), amount: money(-amount, cur) },
      ],
    });
    const elig = eligibleAt(closedAt, this.graceDays).toISOString();
    const upd = await tx.query(
      `UPDATE payout_accruals SET amount_minor = $2::bigint, status = 'AVAILABLE', closed_at = $3::timestamptz, eligible_at = $4::timestamptz,
              move_entry_id = $5, updated_at = $6::timestamptz
        WHERE seller_order_id = $1 AND status = 'PENDING' RETURNING id`,
      [o.id, amount.toString(), closedAt.toISOString(), elig, entryId, now.toISOString()],
    );
    if (upd.rows.length === 0) {
      await tx.query(
        `INSERT INTO payout_accruals (id, seller_order_id, store_id, market_id, amount_minor, currency, status, closed_at, eligible_at, move_entry_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::bigint, $6, 'AVAILABLE', $7::timestamptz, $8::timestamptz, $9, $10::timestamptz, $10::timestamptz)
         ON CONFLICT (seller_order_id) DO NOTHING`,
        [uuidv7(), o.id, o.store_id, e.marketId, amount.toString(), cur, closedAt.toISOString(), elig, entryId, now.toISOString()],
      );
    }
  }
}
