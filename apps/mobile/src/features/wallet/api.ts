import { dataOf, type schemas } from "../../services/api-client";
import { guard, money, ms, msOrNull, type AdapterContext } from "../../services/wire";
import type { CreditLot, SubBalanceKind, TransactionKind, TransactionPage, WalletPort, WalletSnapshot, WalletTransaction } from "./model";

const KINDS: readonly SubBalanceKind[] = ["refund_credit", "gift_card", "cashback_coins", "referral_credit", "goodwill"];
const asKind = (k: string): SubBalanceKind => KINDS.find((x) => x === k) ?? "goodwill";

const TX: Readonly<Record<schemas.WalletTransaction["kind"], { kind: TransactionKind; sub: SubBalanceKind }>> = {
  refund_credit_in: { kind: "credit_added", sub: "refund_credit" },
  gift_card_in: { kind: "credit_added", sub: "gift_card" },
  cashback_in: { kind: "credit_added", sub: "cashback_coins" },
  referral_in: { kind: "credit_added", sub: "referral_credit" },
  goodwill_in: { kind: "credit_added", sub: "goodwill" },
  // Spend/expiry/clawback fall back to refund_credit only when the server omits `sub_balance`.
  spend: { kind: "credit_spent", sub: "refund_credit" },
  expiry: { kind: "credit_expired", sub: "refund_credit" },
  clawback: { kind: "other", sub: "refund_credit" },
};

/** GET /v1/me/wallet(+/transactions). Gift-card lots carry `lot_id` (the card id); last4 is not on the wire (gap). */
export class ApiWalletPort implements WalletPort {
  constructor(private readonly ctx: AdapterContext) {}

  load(): Promise<WalletSnapshot> {
    return guard(async () => {
      const w = dataOf(await this.ctx.client.getWallet());
      const lots: CreditLot[] = w.sub_balances.map((s, i) => ({
        id: s.lot_id ?? `${s.kind}:${i}`, kind: asKind(s.kind), remaining: money(s.balance), expiresAt: msOrNull(s.expires_at), last4: null,
      }));
      const expiringSoon: CreditLot[] = w.expiring_soon.map((s, i) => ({
        id: `expiring:${s.kind}:${i}`, kind: asKind(s.kind), remaining: money(s.amount), expiresAt: ms(s.expires_at), last4: null,
      }));
      return { lots, expiringSoon };
    });
  }

  transactions(cursor: string | null): Promise<TransactionPage> {
    return guard(async () => {
      const r = dataOf(await this.ctx.client.listWalletTransactions({ query: { limit: 20, ...(cursor !== null ? { cursor } : {}) } }));
      const items = r.items.map((t): WalletTransaction => ({
        id: t.id, kind: TX[t.kind].kind, sub: t.sub_balance !== undefined ? asKind(t.sub_balance) : TX[t.kind].sub, amount: money(t.amount), at: ms(t.created_at),
      }));
      return { items, nextCursor: r.page.next_cursor };
    });
  }
}
