import { z } from "zod";
import { MoneyError } from "./errors.js";
import { roundHalfEven } from "./rounding.js";

export const CURRENCIES = ["EGP", "SAR", "AED", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Minor-unit exponent per currency (single source; markets-config derives from it). */
export const CURRENCY_MINOR_UNITS: Readonly<Record<Currency, 0 | 2 | 3>> = Object.freeze({
  EGP: 2,
  SAR: 2,
  AED: 2,
  USD: 2,
});

export interface Money {
  readonly amountMinor: bigint;
  readonly currency: Currency;
}

const BIGINT_STRING = /^-?[0-9]+$/;
const PG_BIGINT_MIN = -(2n ** 63n);
const PG_BIGINT_MAX = 2n ** 63n - 1n;

/** Boundary schema: amountMinor travels as a decimal string (JSON has no bigint) and parses to bigint. */
export const moneySchema = z.object({
  amountMinor: z
    .string()
    .max(20)
    .regex(BIGINT_STRING, "amountMinor must be an integer string")
    .refine((value) => {
      if (!BIGINT_STRING.test(value)) return false;
      const parsed = BigInt(value);
      return parsed >= PG_BIGINT_MIN && parsed <= PG_BIGINT_MAX;
    }, "amountMinor out of BIGINT range")
    .transform((value) => BigInt(value)),
  currency: z.enum(CURRENCIES),
});

export interface MoneyWire {
  readonly amountMinor: string;
  readonly currency: Currency;
}

export function toWire(value: Money): MoneyWire {
  return { amountMinor: value.amountMinor.toString(), currency: value.currency };
}

export function money(amountMinor: bigint, currency: Currency): Money {
  if (typeof amountMinor !== "bigint") {
    throw new MoneyError("INVALID_AMOUNT", "amountMinor must be a bigint");
  }
  if (!CURRENCIES.includes(currency)) {
    throw new MoneyError("UNKNOWN_CURRENCY", "unknown currency");
  }
  return Object.freeze({ amountMinor, currency });
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError("CURRENCY_MISMATCH", `cannot combine ${a.currency} with ${b.currency}`);
  }
}

export const add = (a: Money, b: Money): Money => {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
};

export const sub = (a: Money, b: Money): Money => {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
};

export const negate = (a: Money): Money => money(-a.amountMinor, a.currency);

/** Returns -1, 0 or 1. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor === b.amountMinor) return 0;
  return a.amountMinor < b.amountMinor ? -1 : 1;
}

export const equals = (a: Money, b: Money): boolean => a.currency === b.currency && a.amountMinor === b.amountMinor;

/**
 * value * numerator / denominator, rounded half-even exactly once (the only rounding point).
 * Use for VAT extraction from a VAT-inclusive price: fraction(gross, 1400n, 11400n).
 */
export function fraction(value: Money, numerator: bigint, denominator: bigint): Money {
  if (typeof numerator !== "bigint" || numerator < 0n) {
    throw new MoneyError("INVALID_BPS", "numerator must be a non-negative bigint");
  }
  if (typeof denominator !== "bigint" || denominator <= 0n) {
    throw new MoneyError("INVALID_DIVISOR", "denominator must be a positive bigint");
  }
  return money(roundHalfEven(value.amountMinor * numerator, denominator), value.currency);
}

/** value * bps / 10000, rounded half-even once. bps is a bigint (1400n = 14%). */
export const percentOf = (value: Money, bps: bigint): Money => fraction(value, bps, 10_000n);

/**
 * Splits `total` proportionally to `ratios` with the largest-remainder method. The parts always
 * sum exactly to `total`. Leftover minor units go to the largest fractional remainders; ties go
 * to the lowest index (stable, deterministic). Negative totals allocate the magnitude and negate.
 */
export function allocate(total: Money, ratios: readonly bigint[]): Money[] {
  if (ratios.length === 0 || ratios.some((r) => r < 0n)) {
    throw new MoneyError("INVALID_RATIOS", "ratios must be a non-empty list of non-negative bigints");
  }
  const weightSum = ratios.reduce((acc, r) => acc + r, 0n);
  if (weightSum === 0n) {
    throw new MoneyError("INVALID_RATIOS", "ratios must not all be zero");
  }
  const negative = total.amountMinor < 0n;
  const magnitude = negative ? -total.amountMinor : total.amountMinor;

  const shares = ratios.map((ratio, index) => {
    const scaled = magnitude * ratio;
    return { index, floor: scaled / weightSum, remainder: scaled % weightSum };
  });
  const distributed = shares.reduce((acc, s) => acc + s.floor, 0n);
  let leftover = magnitude - distributed;

  const byRemainder = [...shares].sort((x, y) =>
    x.remainder === y.remainder ? x.index - y.index : x.remainder > y.remainder ? -1 : 1,
  );
  const extra = new Set<number>();
  for (const share of byRemainder) {
    if (leftover === 0n) break;
    extra.add(share.index);
    leftover -= 1n;
  }
  return shares.map((s) => {
    const part = s.floor + (extra.has(s.index) ? 1n : 0n);
    return money(negative ? -part : part, total.currency);
  });
}
