import type { CreditTxn } from "../domain/ports";
import type { WalletView } from "../application/queries";

const iso = (ms: number): string => new Date(ms).toISOString();
const amount = (v: bigint) => ({ amount: v.toString(), currency: "EGP" as const });

/**
 * Wallet wire shape (docs/api/openapi.yaml WalletBalances). Only enum codes and ids reach the wire, so the
 * closed-loop wording rule (never cash or money) is checkable on every string. Held credit is not spendable
 * and is not part of `total`. A gift-card sub-balance carries the card id as `lot_id`.
 */
export function walletWire(w: WalletView) {
  return {
    total: amount(w.totalAvailable),
    sub_balances: w.balances.map((b) => ({
      kind: b.sub.kind,
      ...(b.sub.kind === "gift_card" ? { lot_id: b.sub.cardId } : {}),
      balance: amount(b.available),
      expires_at: b.nextExpiryMs === null ? null : iso(b.nextExpiryMs),
    })),
    expiring_soon: w.expiringSoon.map((e) => ({
      kind: e.sub.kind,
      amount: amount(e.amount.amount),
      expires_at: iso(e.expiresAtMs),
    })),
    as_of: iso(w.asOfMs),
  };
}

const IN_KIND = {
  refund: "refund_credit_in",
  gift_card: "gift_card_in",
  cashback: "cashback_in",
  referral: "referral_in",
  goodwill: "goodwill_in",
  order: "refund_credit_in",
  expiry: "refund_credit_in",
} as const;

export function txnWire(t: CreditTxn) {
  const kind = t.kind === "credit_used" ? "spend" : t.kind === "credit_expired" ? "expiry" : IN_KIND[t.reason];
  return {
    id: t.id,
    kind,
    amount: amount(t.amount),
    sub_balance: t.sub.kind,
    ...(t.sub.kind === "gift_card" ? { lot_id: t.sub.cardId } : {}),
    created_at: iso(t.createdAtMs),
  };
}
