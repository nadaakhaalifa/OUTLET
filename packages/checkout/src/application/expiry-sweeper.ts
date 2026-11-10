import { withDbContext } from "@outlet/db";
import type { Queryable } from "@outlet/db";
import { makeEnv } from "./env.js";
import type { Env, WorkerDeps } from "./env.js";
import { lockGroup, lockIntentOfGroup } from "./order-ops.js";
import { settleVouchers } from "./promotions-glue.js";
import { compensate } from "./settlement.js";

export interface ExpiryResult {
  readonly expired: readonly string[];
  /** The PSP reports the money already moved: the webhook finishes the order. */
  readonly leftForWebhook: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Worker job checkout.expiry (every 30 s per market). The network call (voidIntent) is never inside a transaction: void first,
 * then lock the group and compensate only if it is still unpaid and past its window (README section 9).
 */
export class ExpirySweeper {
  private readonly env: Env;
  constructor(private readonly d: WorkerDeps) {
    this.env = makeEnv(d);
  }

  private inTx<T>(userId: string | null, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.d.client, { kind: "worker", marketId: this.env.marketId, job: "checkout.expiry", ...(userId === null ? {} : { userId }) }, fn);
  }

  async run(limit = 50): Promise<ExpiryResult> {
    const env = this.env;
    const due = await this.inTx(null, async (tx) =>
      (
        await tx.query<{ id: string; user_id: string }>(
          `SELECT id, user_id FROM order_groups WHERE market_id = $1 AND status IN ('PENDING_PAYMENT', 'AWAITING_COD_CONFIRMATION') AND payment_expires_at < now()
            ORDER BY payment_expires_at, id LIMIT $2::int`,
          [env.marketId, limit],
        )
      ).rows,
    );
    const expired: string[] = [];
    const leftForWebhook: string[] = [];
    const skipped: string[] = [];
    for (const row of due) {
      const intent = await this.inTx(row.user_id, (tx) => lockIntentOfGroup(tx, row.id).catch(() => null));
      if (intent !== null && intent.method !== "cod" && intent.method !== "store_credit" && intent.status !== "NOT_REQUIRED") {
        const v = await env.provider.voidIntent({ paymentIntentId: intent.id, providerRef: intent.provider_ref }, `expire:${row.id}`);
        if (v.outcome === "already_captured") {
          leftForWebhook.push(row.id);
          continue;
        }
      }
      const did = await this.inTx(row.user_id, async (tx) => {
        const g = await lockGroup(tx, row.id);
        const i = await lockIntentOfGroup(tx, row.id);
        const past = g.payment_expires_at !== null && new Date(g.payment_expires_at).getTime() < env.now().getTime();
        const done = past && (await compensate(env, tx, g, i, "expired", null));
        return { done, promo: done && BigInt(g.discount_minor) > 0n };
      });
      // the lapsed vouchers give their caps back (a late capture of a discounted order is not re-reserved: README section 9)
      if (did.promo) await settleVouchers(env, "release", row.user_id, row.id);
      (did.done ? expired : skipped).push(row.id);
    }
    return { expired, leftForWebhook, skipped };
  }
}
