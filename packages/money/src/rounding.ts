import { MoneyError } from "./errors.js";

/**
 * THE single rounding point of the platform: banker's rounding (round half to even) of the
 * exact rational numerator/denominator to an integer. Every operation that can produce a
 * fraction of a minor unit (percentages, tax, proration) must go through this function.
 * Pure bigint arithmetic; no floats anywhere.
 */
export function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new MoneyError("INVALID_DIVISOR", "denominator must be a positive bigint");
  }
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  let quotient = abs / denominator;
  const twiceRemainder = 2n * (abs % denominator);
  if (twiceRemainder > denominator || (twiceRemainder === denominator && quotient % 2n === 1n)) {
    quotient += 1n;
  }
  return negative ? -quotient : quotient;
}
