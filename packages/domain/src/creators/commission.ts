import { money, multiplyRatio, percentOfBps } from "../money";
import { InvalidCreatorInputError } from "./errors";

/** VAT contained in a VAT-inclusive amount, rounded once half-even (same formula as the chart). */
const vatIn = (gross: bigint, vatBps: bigint): bigint => multiplyRatio(money(gross), vatBps, 10_000n + vatBps).amount;

export interface BaseInput {
  /** VAT-inclusive merchandise of the line after item-level discounts. Excludes shipping, gift cards, Plus. */
  readonly merchandiseGross: bigint;
  /** Voucher value allocated to the line. Voucher-funded value never earns commission (ADR-0037). */
  readonly voucherAllocated: bigint;
  readonly vatBps: bigint;
}

/** Commission base in piastres: gross minus voucher, then VAT taken out. Never negative. */
export function eligibleBase(i: BaseInput): bigint {
  if (i.merchandiseGross < 0n || i.voucherAllocated < 0n) throw new InvalidCreatorInputError("negative base input");
  const afterVoucher = i.merchandiseGross > i.voucherAllocated ? i.merchandiseGross - i.voucherAllocated : 0n;
  return afterVoucher - vatIn(afterVoucher, i.vatBps);
}

/** Commission on a base. Half-even, one rounding point. */
export function commissionOn(base: bigint, rateBps: bigint): bigint {
  if (base < 0n) throw new InvalidCreatorInputError("base must not be negative");
  if (rateBps < 0n || rateBps > 10_000n) throw new InvalidCreatorInputError("rate out of range");
  return percentOfBps(money(base), rateBps).amount;
}

export interface LineCommissionTerms {
  /** Base at closure, before any refund (eligibleBase of the line). */
  readonly originalBase: bigint;
  readonly rateBps: bigint;
}

/**
 * Net commission the line should hold after `refundedFraction` of its value came back. The refund is
 * given as a cumulative part of the original base (`refundedBase`, clamped), so a replayed or
 * out-of-order refund message cannot claw back twice.
 */
export function targetCommission(t: LineCommissionTerms, refundedBase: bigint): bigint {
  const refunded = refundedBase < 0n ? 0n : refundedBase > t.originalBase ? t.originalBase : refundedBase;
  return commissionOn(t.originalBase - refunded, t.rateBps);
}

/**
 * How much to claw back now. `held` is accrued minus already clawed back. Result is >= 0 and never
 * more than `held`; zero means a replay or a refund already accounted for.
 */
export function clawbackDelta(t: LineCommissionTerms, accrued: bigint, clawedBack: bigint, refundedBase: bigint): bigint {
  const held = accrued - clawedBack;
  const target = targetCommission(t, refundedBase);
  const delta = held - target;
  if (delta <= 0n) return 0n;
  return delta > held ? held : delta;
}

export type CapDecision = { readonly kind: "accrue" } | { readonly kind: "hold"; readonly reason: "monthly_cap" };

/** All-or-nothing: a commission that would cross the monthly cap is held, never split. */
export function applyMonthlyCap(accruedThisMonth: bigint, amount: bigint, cap: bigint): CapDecision {
  return accruedThisMonth + amount > cap ? { kind: "hold", reason: "monthly_cap" } : { kind: "accrue" };
}

/** Signed balance view. A negative balance is reported as what the creator owes, never hidden. */
export interface BalanceView {
  readonly payable: bigint;
  readonly owesPlatform: bigint;
  readonly negative: boolean;
}

export function balanceView(signedNatural: bigint): BalanceView {
  return signedNatural >= 0n
    ? { payable: signedNatural, owesPlatform: 0n, negative: false }
    : { payable: 0n, owesPlatform: -signedNatural, negative: true };
}

export interface RefundableCommission {
  readonly state: "ACCRUING" | "ACCRUED" | "PAID" | "CLAWED_BACK" | "VOIDED";
  readonly base: bigint;
  readonly rateBps: bigint;
  readonly amount: bigint;
  readonly clawedBack: bigint;
  readonly refundedBase: bigint;
}

export type RefundPlan =
  | { readonly kind: "none"; readonly refundedBase: bigint }
  /** Held commission: shrink the unposted amount, void when nothing is left. No ledger entry. */
  | { readonly kind: "shrink_held"; readonly refundedBase: bigint; readonly amount: bigint; readonly void: boolean }
  /** Accrued or paid: claw back `delta` through a reversing ledger entry. */
  | { readonly kind: "clawback"; readonly refundedBase: bigint; readonly delta: bigint; readonly clawedBack: bigint; readonly full: boolean };

/** Pure. Shared by every store so memory and Postgres cannot disagree. Refunded base is monotonic. */
export function planRefund(c: RefundableCommission, newRefundedBase: bigint): RefundPlan {
  const clamped = newRefundedBase < 0n ? 0n : newRefundedBase > c.base ? c.base : newRefundedBase;
  const refundedBase = clamped > c.refundedBase ? clamped : c.refundedBase;
  if (c.state === "VOIDED" || c.state === "CLAWED_BACK") return { kind: "none", refundedBase };
  const terms = { originalBase: c.base, rateBps: c.rateBps };
  if (c.state === "ACCRUING") {
    const amount = targetCommission(terms, refundedBase);
    if (amount >= c.amount) return { kind: "none", refundedBase };
    return { kind: "shrink_held", refundedBase, amount, void: amount === 0n };
  }
  const delta = clawbackDelta(terms, c.amount, c.clawedBack, refundedBase);
  if (delta === 0n) return { kind: "none", refundedBase };
  const clawedBack = c.clawedBack + delta;
  return { kind: "clawback", refundedBase, delta, clawedBack, full: clawedBack === c.amount };
}

/** Base share of a refunded part of the line's gross value, rounded half-even once. */
export function refundedBaseOf(base: bigint, lineGross: bigint, refundedGross: bigint): bigint {
  if (lineGross <= 0n || refundedGross <= 0n) return 0n;
  const r = refundedGross > lineGross ? lineGross : refundedGross;
  return multiplyRatio(money(base), r, lineGross).amount;
}

/**
 * Plan for voiding a whole attribution after accrual (A-3): a held commission is voided without a
 * ledger entry, an accrued or paid one is fully clawed back through the same intent mechanism as a
 * refund. Pure and replay safe (terminal states give `none`).
 */
export function planVoid(c: RefundableCommission): RefundPlan {
  return planRefund(c, c.base);
}
