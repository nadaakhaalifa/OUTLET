import { CurrencyMismatchError, InvalidAmountError } from "./errors";

export type Currency = "EGP";

/** Amount in minor units (piastres for EGP). Never a float. */
export interface Money {
  readonly amount: bigint;
  readonly currency: Currency;
}

export function money(amount: bigint, currency: Currency = "EGP"): Money {
  if (typeof amount !== "bigint") throw new InvalidAmountError("amount must be a bigint");
  return { amount, currency };
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(`cannot combine ${a.currency} with ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.amount, a.currency);
}

export function isZero(a: Money): boolean {
  return a.amount === 0n;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amount === b.amount;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  return a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0;
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

/**
 * The single rounding point for the whole system (spec §A2.4): integer division with
 * banker's rounding (round half to even). Ties go to the even quotient, which is
 * unbiased across many lines.
 */
export function divideRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new InvalidAmountError("division by zero");
  const quotient = numerator / denominator; // truncates toward zero
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  const twiceRemainder = abs(remainder) * 2n;
  const absDenominator = abs(denominator);
  const sign = numerator < 0n !== denominator < 0n ? -1n : 1n;
  const roundAway =
    twiceRemainder > absDenominator || (twiceRemainder === absDenominator && quotient % 2n !== 0n);
  return roundAway ? quotient + sign : quotient;
}

/** Multiplies by a ratio (numerator / denominator), rounding once at the end. */
export function multiplyRatio(a: Money, numerator: bigint, denominator: bigint): Money {
  return money(divideRoundHalfEven(a.amount * numerator, denominator), a.currency);
}

/** Basis points: 10_000 bps = 100%. 14% VAT is 1_400 bps. */
export function percentOfBps(a: Money, basisPoints: bigint): Money {
  return multiplyRatio(a, basisPoints, 10_000n);
}

/**
 * Splits `total` by `weights` so the parts sum exactly to the total, using the
 * largest-remainder method. Ties are broken by the lower index, so the result is
 * deterministic. Negative totals allocate on the absolute value and negate, so a
 * refund mirrors the original charge exactly.
 */
export function allocate(total: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0) throw new InvalidAmountError("allocate needs at least one weight");
  let weightSum = 0n;
  for (const w of weights) {
    if (w < 0n) throw new InvalidAmountError("weights must not be negative");
    weightSum += w;
  }
  if (weightSum === 0n) throw new InvalidAmountError("at least one weight must be positive");

  const negative = total.amount < 0n;
  const magnitude = abs(total.amount);
  const parts: bigint[] = [];
  const remainders: bigint[] = [];
  let assigned = 0n;
  for (const w of weights) {
    const product = magnitude * w;
    const part = product / weightSum;
    parts.push(part);
    remainders.push(product % weightSum);
    assigned += part;
  }

  const leftover = Number(magnitude - assigned);
  const order = weights
    .map((_, index) => index)
    .sort((a, b) => {
      const ra = remainders[a] ?? 0n;
      const rb = remainders[b] ?? 0n;
      if (ra !== rb) return ra > rb ? -1 : 1;
      return a - b;
    });
  for (let k = 0; k < leftover; k += 1) {
    const index = order[k];
    if (index === undefined) break;
    parts[index] = (parts[index] ?? 0n) + 1n;
  }

  return parts.map((p) => money(negative ? -p : p, total.currency));
}
