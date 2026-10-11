import { labelFor, subBalanceKey, WALLET_TITLE } from "../domain/bridge";
import type { CreditTxn } from "../domain/ports";
import type { WalletView } from "../application/queries";

const iso = (ms: number): string => new Date(ms).toISOString();
const amount = (v: bigint) => ({ amount: v.toString(), currency: "EGP" as const });

/**
 * Wallet wire shape. Only labels from `labelFor`/`WALLET_TITLE` and codes reach the wire, so the
 * closed-loop wording rule (never cash or money) is checkable on every string.
 */
export function walletWire(w: WalletView) {
  return {
    title: WALLET_TITLE,
    currency: "EGP" as const,
    total_available: amount(w.totalAvailable),
    total_held: amount(w.totalHeld),
    balances: w.balances.map((b) => ({
      sub: subBalanceKey(b.sub),
      label: labelFor(b.sub),
      available: amount(b.available),
      held: amount(b.held),
      next_expiry_at: b.nextExpiryMs === null ? null : iso(b.nextExpiryMs),
    })),
    expiring_soon: w.expiringSoon.map((e) => ({
      sub: subBalanceKey(e.sub),
      label: labelFor(e.sub),
      amount: amount(e.amount.amount),
      expires_at: iso(e.expiresAtMs),
    })),
  };
}

export function txnWire(t: CreditTxn) {
  return {
    id: t.id,
    kind: t.kind,
    reason: t.reason,
    sub: subBalanceKey(t.sub),
    label: labelFor(t.sub),
    amount: amount(t.amount),
    created_at: iso(t.createdAtMs),
  };
}
