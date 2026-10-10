import { add, equals, money, multiplyRatio, percentOfBps, subtract, type Money } from "../money";
import { InvalidOrderIntakeError } from "./errors";

export interface IntakeLineFacts {
  readonly qty: number;
  readonly unitPrice: Money;
}

export interface IntakeTotalsFacts {
  readonly subtotal: Money;
  readonly shipping: Money;
  readonly discount: Money;
  readonly total: Money;
}

/**
 * Structural validation of a seller order handed over by checkout. The rule is the one the ledger
 * will rely on later: subtotal = sum(unit price x qty), total = subtotal + shipping - discount, and
 * nothing is negative. Never repairs data: a mismatch is rejected, nothing is written.
 */
export function assertValidIntake(lines: readonly IntakeLineFacts[], t: IntakeTotalsFacts): void {
  if (lines.length === 0) throw new InvalidOrderIntakeError("a seller order needs at least one line");
  let sum = money(0n);
  for (const l of lines) {
    if (!Number.isInteger(l.qty) || l.qty < 1) throw new InvalidOrderIntakeError("line quantity must be a positive integer");
    if (l.unitPrice.amount < 0n) throw new InvalidOrderIntakeError("line price must not be negative");
    sum = add(sum, multiplyRatio(l.unitPrice, BigInt(l.qty), 1n));
  }
  if (!equals(sum, t.subtotal)) throw new InvalidOrderIntakeError("subtotal does not equal the sum of its lines");
  for (const m of [t.shipping, t.discount]) {
    if (m.amount < 0n) throw new InvalidOrderIntakeError("shipping and discount must not be negative");
  }
  if (!equals(subtract(add(t.subtotal, t.shipping), t.discount), t.total) || t.total.amount < 0n) {
    throw new InvalidOrderIntakeError("total does not equal subtotal + shipping - discount");
  }
}

/** Informational seller commission on the merchandise subtotal; banker's rounding via `percentOfBps`. */
export function commissionFor(subtotal: Money, rateBps: number): Money {
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    throw new InvalidOrderIntakeError("commission rate must be 0..10000 bps");
  }
  return percentOfBps(subtotal, BigInt(rateBps));
}
