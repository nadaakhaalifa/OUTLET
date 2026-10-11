import { availableOf, money, type SubBalanceState } from "./domain";
import type { CreditLot } from "../modules/store-credit";

/** Spendable balance per sub-balance from lots at `nowMs`: remaining minus held, expired lots excluded. */
export function subBalanceStates(lots: readonly CreditLot[], nowMs: number): SubBalanceState[] {
  const by = new Map<string, { sub: CreditLot["sub"]; balance: bigint; expiresAtMs: number | null }>();
  for (const l of lots) {
    const free = availableOf(l, nowMs);
    if (free <= 0n) continue;
    const key = JSON.stringify(l.sub);
    const cur = by.get(key);
    const exp =
      cur === undefined ? l.expiresAtMs : cur.expiresAtMs === null ? l.expiresAtMs : l.expiresAtMs === null ? cur.expiresAtMs : Math.min(cur.expiresAtMs, l.expiresAtMs);
    by.set(key, { sub: l.sub, balance: (cur?.balance ?? 0n) + free, expiresAtMs: exp });
  }
  return [...by.values()].map((v) => ({
    sub: v.sub,
    balance: money(v.balance),
    expiresAt: v.expiresAtMs === null ? null : new Date(v.expiresAtMs),
  }));
}
