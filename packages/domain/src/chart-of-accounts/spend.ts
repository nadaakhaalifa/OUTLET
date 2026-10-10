import { compare, money, type Money } from "../money";
import { InsufficientCreditError, InvalidChartInputError } from "./errors";
import { subBalanceKey, type StoreCreditSub } from "./accounts";

export interface SubBalanceState {
  readonly sub: StoreCreditSub;
  readonly balance: Money;
  /** null means the sub-balance does not expire. */
  readonly expiresAt: Date | null;
}

export interface SubBalanceSpend {
  readonly sub: StoreCreditSub;
  readonly amount: Money;
}

function rank(state: SubBalanceState): number {
  // refund_credit goes last so that it can still go back to the original method (spec 15.2).
  if (state.sub.kind === "refund_credit") return 2;
  return state.expiresAt === null ? 1 : 0;
}

/**
 * Spend order per spec 15.2: soonest-expiring first, then non-expiring, with
 * refund_credit last. Ties are broken by sub-balance key so the plan is deterministic.
 * Pure: the caller supplies the current balances.
 */
export function planStoreCreditSpend(
  balances: readonly SubBalanceState[],
  amount: Money,
): SubBalanceSpend[] {
  if (amount.amount <= 0n) throw new InvalidChartInputError("spend amount must be positive");
  const ordered = balances
    .filter((b) => b.balance.amount > 0n)
    .slice()
    .sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (a.expiresAt !== null && b.expiresAt !== null) {
        const diff = a.expiresAt.getTime() - b.expiresAt.getTime();
        if (diff !== 0) return diff;
      }
      const ka = subBalanceKey(a.sub);
      const kb = subBalanceKey(b.sub);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

  let remaining = amount;
  const plan: SubBalanceSpend[] = [];
  for (const state of ordered) {
    if (remaining.amount === 0n) break;
    const take = compare(state.balance, remaining) <= 0 ? state.balance : remaining;
    plan.push({ sub: state.sub, amount: take });
    remaining = money(remaining.amount - take.amount, remaining.currency);
  }
  if (remaining.amount > 0n) {
    throw new InsufficientCreditError(`short by ${remaining.amount} piastres of store credit`);
  }
  return plan;
}
