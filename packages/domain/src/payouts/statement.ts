import { commissionOf, commissionVatOf } from "../chart-of-accounts/builders";
import { money } from "../money";
import { InvalidPayoutInputError } from "./errors";

/** Everything that moves a seller's `seller_payable`, in the terms the seller understands. */
export type StatementFact =
  | {
      readonly type: "order";
      readonly id: string;
      readonly storeId: string;
      readonly atMs: number;
      /** Merchandise value used for commission (after item discounts, before vouchers). */
      readonly merchandise: bigint;
      readonly commissionBps: bigint;
      readonly vatBps: bigint;
    }
  | {
      readonly type: "refund";
      readonly id: string;
      readonly storeId: string;
      readonly atMs: number;
      readonly goodsRefunded: bigint;
      readonly goodsRefundedBefore: bigint;
      readonly commissionBps: bigint;
      readonly vatBps: bigint;
    }
  | {
      /**
       * `clawback` is for a ledger movement that is neither a refund nor a promo netting (a chargeback
       * or manual adjustment). A refund after payout is the `refund` fact itself; never add it twice.
       */
      readonly type: "promo_netting" | "payout" | "payout_reversal" | "clawback";
      readonly id: string;
      readonly storeId: string;
      readonly atMs: number;
      /** Positive piastres. The sign is decided by the type. */
      readonly amount: bigint;
    };

export type StatementLineType = StatementFact["type"];

export interface StatementLine {
  readonly id: string;
  readonly type: StatementLineType;
  readonly atMs: number;
  /** Signed: negative for a refund of goods. */
  readonly merchandise: bigint;
  /** Signed commission charged (negative = commission returned). */
  readonly commission: bigint;
  readonly vatOnCommission: bigint;
  /** Signed non-merchandise movement (netting, payouts). */
  readonly adjustment: bigint;
  /** merchandise - commission - vatOnCommission + adjustment: the movement of seller_payable. */
  readonly net: bigint;
  /** Running balance after this line, starting from the opening balance. */
  readonly balanceAfter: bigint;
}

export interface StatementTotals {
  readonly merchandise: bigint;
  readonly commission: bigint;
  readonly vatOnCommission: bigint;
  readonly adjustments: bigint;
  readonly payouts: bigint;
  readonly net: bigint;
}

export interface Statement {
  readonly storeId: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly opening: bigint;
  readonly lines: readonly StatementLine[];
  readonly totals: StatementTotals;
  readonly closing: bigint;
}

const TYPE_ORDER: Readonly<Record<StatementLineType, number>> = {
  order: 0,
  refund: 1,
  promo_netting: 2,
  clawback: 3,
  payout: 4,
  payout_reversal: 5,
};

interface Unbalanced {
  readonly id: string;
  readonly type: StatementLineType;
  readonly atMs: number;
  readonly merchandise: bigint;
  readonly commission: bigint;
  readonly vatOnCommission: bigint;
  readonly adjustment: bigint;
}

function lineOf(f: StatementFact): Unbalanced {
  switch (f.type) {
    case "order": {
      if (f.merchandise <= 0n) throw new InvalidPayoutInputError("order merchandise must be positive");
      const c = commissionOf(money(f.merchandise), f.commissionBps).amount;
      const v = commissionVatOf(money(c), f.vatBps).amount;
      return { id: f.id, type: f.type, atMs: f.atMs, merchandise: f.merchandise, commission: c, vatOnCommission: v, adjustment: 0n };
    }
    case "refund": {
      if (f.goodsRefunded <= 0n || f.goodsRefundedBefore < 0n) {
        throw new InvalidPayoutInputError("refund amounts out of range");
      }
      // Same differencing as the ledger's refundIssued: any sequence of partial refunds adds up.
      const cumulative = f.goodsRefundedBefore + f.goodsRefunded;
      const cAfter = commissionOf(money(cumulative), f.commissionBps).amount;
      const cBefore = commissionOf(money(f.goodsRefundedBefore), f.commissionBps).amount;
      const vAfter = commissionVatOf(money(cAfter), f.vatBps).amount;
      const vBefore = commissionVatOf(money(cBefore), f.vatBps).amount;
      return {
        id: f.id,
        type: f.type,
        atMs: f.atMs,
        merchandise: -f.goodsRefunded,
        commission: -(cAfter - cBefore),
        vatOnCommission: -(vAfter - vBefore),
        adjustment: 0n,
      };
    }
    case "payout_reversal":
      if (f.amount <= 0n) throw new InvalidPayoutInputError("amount must be positive");
      return { id: f.id, type: f.type, atMs: f.atMs, merchandise: 0n, commission: 0n, vatOnCommission: 0n, adjustment: f.amount };
    case "promo_netting":
    case "payout":
    case "clawback":
      if (f.amount <= 0n) throw new InvalidPayoutInputError("amount must be positive");
      return { id: f.id, type: f.type, atMs: f.atMs, merchandise: 0n, commission: 0n, vatOnCommission: 0n, adjustment: -f.amount };
  }
}

const cmp = (a: Unbalanced, b: Unbalanced): number =>
  a.atMs - b.atMs || TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const netOf = (l: Unbalanced): bigint => l.merchandise - l.commission - l.vatOnCommission + l.adjustment;

/**
 * Seller statement for [fromMs, toMs). Facts before `fromMs` fold into the opening balance, so
 * statements for consecutive periods chain: closing(n) = opening(n + 1). The movement of each line
 * equals the ledger's posting to `seller_payable` for the same event.
 */
export function buildStatement(input: {
  readonly storeId: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly facts: readonly StatementFact[];
}): Statement {
  if (!(input.fromMs < input.toMs)) throw new InvalidPayoutInputError("statement period must be non-empty");
  const own = input.facts.filter((f) => f.storeId === input.storeId).map(lineOf).sort(cmp);
  const ids = new Set<string>();
  for (const l of own) {
    const key = `${l.type}:${l.id}`;
    if (ids.has(key)) throw new InvalidPayoutInputError(`duplicate statement fact ${key}`);
    ids.add(key);
  }
  const opening = own.filter((l) => l.atMs < input.fromMs).reduce((a, l) => a + netOf(l), 0n);
  let balance = opening;
  const lines: StatementLine[] = [];
  const totals = { merchandise: 0n, commission: 0n, vatOnCommission: 0n, adjustments: 0n, payouts: 0n, net: 0n };
  for (const l of own) {
    if (l.atMs < input.fromMs || l.atMs >= input.toMs) continue;
    const net = netOf(l);
    balance += net;
    lines.push({ ...l, net, balanceAfter: balance });
    totals.merchandise += l.merchandise;
    totals.commission += l.commission;
    totals.vatOnCommission += l.vatOnCommission;
    if (l.type === "payout" || l.type === "payout_reversal") totals.payouts += l.adjustment;
    else totals.adjustments += l.adjustment;
    totals.net += net;
  }
  return {
    storeId: input.storeId,
    fromMs: input.fromMs,
    toMs: input.toMs,
    opening,
    lines,
    totals,
    closing: balance,
  };
}
