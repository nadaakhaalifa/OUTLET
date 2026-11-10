import type { Queryable } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { add, money } from "@outlet/money";
import type { Currency, Money } from "@outlet/money";
import { CheckoutError } from "../domain/errors.js";
import type { StoreCreditPort } from "../ports.js";

/**
 * Spend order (master prompt 15.2): soonest-expiring first, refund credit last. Per-posting expiry is not modelled yet, so the order
 * follows each sub-balance's expiry window (goodwill 90 d, referral 6 mo, coins 12 mo, then gift cards, refund credit last).
 */
const SPEND_ORDER = ["goodwill", "referral_credit", "cashback_coins", "gift_card", "refund_credit"] as const;

interface AccountRow { id: string; code: string; sub: string; balance: string | bigint; held: string | bigint }

/** StoreCreditPort over the ledger (derived balance = -sum of postings) and ledger_holds (rows, never pending postings). */
export class PgStoreCredit implements StoreCreditPort {
  constructor(private readonly currency: Currency = "EGP", private readonly newId: () => string = uuidv7) {}

  private async accounts(tx: Queryable, userId: string, marketId: string): Promise<AccountRow[]> {
    return (
      await tx.query<AccountRow>(
        `SELECT a.id, a.code, a.sub,
                COALESCE((SELECT -SUM(p.amount_minor) FROM postings p WHERE p.account_id = a.id), 0) AS balance,
                COALESCE((SELECT SUM(h.amount_minor) FROM ledger_holds h WHERE h.account_id = a.id AND h.status = 'HELD'), 0) AS held
           FROM ledger_accounts a WHERE a.type = 'store_credit' AND a.owner_id = $1 AND a.market_id = $2 AND a.currency = $3`,
        [userId, marketId, this.currency],
      )
    ).rows;
  }

  private spendable(r: AccountRow): bigint {
    const v = BigInt(r.balance) - BigInt(r.held);
    return v > 0n ? v : 0n;
  }

  async available(tx: Queryable, userId: string, marketId: string): Promise<Money> {
    return money((await this.accounts(tx, userId, marketId)).reduce((a, r) => a + this.spendable(r), 0n), this.currency);
  }

  async hold(tx: Queryable, req: { userId: string; marketId: string; orderGroupId: string; amount: Money; expiresAt: Date }) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`credit:${req.userId}`]);
    const rows = (await this.accounts(tx, req.userId, req.marketId)).sort((a, b) => SPEND_ORDER.indexOf(a.sub as (typeof SPEND_ORDER)[number]) - SPEND_ORDER.indexOf(b.sub as (typeof SPEND_ORDER)[number]));
    let left = req.amount.amountMinor;
    const out: { holdId: string; accountCode: string; amount: Money }[] = [];
    for (const r of rows) {
      if (left <= 0n) break;
      const take = this.spendable(r) < left ? this.spendable(r) : left;
      if (take <= 0n) continue;
      const n = (await tx.query<{ n: string }>("SELECT count(*)::text AS n FROM ledger_holds WHERE ref_type = 'order_group' AND ref_id = $1 AND account_id = $2", [req.orderGroupId, r.id])).rows[0]?.n ?? "0";
      const holdId = this.newId();
      await tx.query(
        `INSERT INTO ledger_holds (id, user_id, account_id, market_id, amount_minor, currency, ref_type, ref_id, status, idempotency_key, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,'order_group',$7,'HELD',$8,$9)`,
        [holdId, req.userId, r.id, req.marketId, take.toString(), this.currency, req.orderGroupId, `hold:${req.orderGroupId}:${r.id}:${n}`, req.expiresAt.toISOString()],
      );
      out.push({ holdId, accountCode: r.code, amount: money(take, this.currency) });
      left -= take;
    }
    if (left > 0n) throw new CheckoutError("credit-insufficient", "store credit balance is lower than the requested amount");
    return out;
  }

  async release(tx: Queryable, orderGroupId: string, status: "RELEASED" | "EXPIRED"): Promise<number> {
    const r = await tx.query("UPDATE ledger_holds SET status = $2, settled_at = now() WHERE ref_type = 'order_group' AND ref_id = $1 AND status = 'HELD' RETURNING id", [orderGroupId, status]);
    return r.rows.length;
  }

  async markCaptured(tx: Queryable, orderGroupId: string, entryId: string): Promise<number> {
    const r = await tx.query("UPDATE ledger_holds SET status = 'CAPTURED', captured_entry_id = $2, settled_at = now() WHERE ref_type = 'order_group' AND ref_id = $1 AND status = 'HELD' RETURNING id", [orderGroupId, entryId]);
    return r.rows.length;
  }

  async heldFor(tx: Queryable, orderGroupId: string): Promise<readonly { accountCode: string; amount: Money }[]> {
    const r = await tx.query<{ code: string; amount_minor: string | bigint }>(
      `SELECT a.code, h.amount_minor FROM ledger_holds h JOIN ledger_accounts a ON a.id = h.account_id
        WHERE h.ref_type = 'order_group' AND h.ref_id = $1 AND h.status = 'HELD' ORDER BY a.code`,
      [orderGroupId],
    );
    return r.rows.map((x) => ({ accountCode: x.code, amount: money(BigInt(x.amount_minor), this.currency) }));
  }
}

export const sumMoney = (xs: readonly Money[], currency: Currency): Money => xs.reduce((a, b) => add(a, b), money(0n, currency));
