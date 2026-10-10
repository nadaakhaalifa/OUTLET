import { InvalidAmountError } from "../errors";
import { allocate, money } from "../money";
import type { Funding, Split } from "./types";

/**
 * Splits one discount amount between the platform and the seller. The parts always sum to the
 * amount (largest remainder, ties to the platform column), so the ledger-facing funding record
 * can never drift from the discount the shopper received.
 */
export function splitFunding(amount: bigint, funding: Funding): Split {
  if (amount < 0n) throw new InvalidAmountError("discount must not be negative");
  const parts = allocate(money(amount), [BigInt(funding.platformPct), BigInt(funding.sellerPct)]);
  const platformFunded = parts[0]?.amount ?? 0n;
  return { amount, platformFunded, sellerFunded: amount - platformFunded };
}

/**
 * Reduces `amounts` proportionally so their sum does not exceed `cap`. Each part stays at or below
 * its original value (largest remainder over a proportional share that is strictly below it).
 */
export function capAmounts(amounts: readonly bigint[], cap: bigint): bigint[] {
  let sum = 0n;
  for (const a of amounts) {
    if (a < 0n) throw new InvalidAmountError("amounts must not be negative");
    sum += a;
  }
  // Stryker disable next-line EqualityOperator: when sum equals cap, allocate() returns the amounts unchanged.
  if (sum <= cap) return [...amounts];
  // Stryker disable next-line EqualityOperator: a zero cap allocates to all zeros as well.
  if (cap <= 0n) return amounts.map(() => 0n);
  return allocate(money(cap), amounts).map((m) => m.amount);
}
