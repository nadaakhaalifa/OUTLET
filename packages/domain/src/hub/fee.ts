import { allocate, money } from "../money";
import { InvalidHubInputError } from "./types";

/**
 * Splits one delivery fee over weights (largest remainder, ties to the lower index) so the parts
 * sum to the total exactly. All-zero weights fall back to an equal split. Integer piastres only.
 */
export function splitFee(total: bigint, weights: readonly bigint[]): bigint[] {
  if (total < 0n) throw new InvalidHubInputError("fee must not be negative");
  if (weights.length === 0) throw new InvalidHubInputError("fee split needs at least one weight");
  const positive = weights.some((w) => w > 0n);
  const w = positive ? weights : weights.map(() => 1n);
  return allocate(money(total), w).map((m) => m.amount);
}
