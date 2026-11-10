import { ShippingError } from "./errors.js";

export interface DimsMm {
  readonly lengthMm: number;
  readonly widthMm: number;
  readonly heightMm: number;
}

const isPosInt = (n: number): boolean => Number.isSafeInteger(n) && n > 0;

/** Volumetric weight in grams: L x W x H (mm^3) / divisor, rounded up. With divisor 5000 this equals (cm^3 / 5000) kg (spec 3). */
export function volumetricGrams(dims: DimsMm, divisor: number): number {
  if (!isPosInt(divisor)) throw new ShippingError("INVALID_INPUT", "divisor must be a positive integer");
  for (const d of [dims.lengthMm, dims.widthMm, dims.heightMm]) {
    if (!isPosInt(d)) throw new ShippingError("INVALID_INPUT", "dimensions must be positive integers (mm)");
  }
  const volume = BigInt(dims.lengthMm) * BigInt(dims.widthMm) * BigInt(dims.heightMm);
  const div = BigInt(divisor);
  return Number((volume + div - 1n) / div);
}

/** Rounds up to the courier break (step). */
export function roundUpToStep(grams: number, stepG: number): number {
  if (!isPosInt(stepG)) throw new ShippingError("INVALID_INPUT", "step must be a positive integer");
  if (!Number.isSafeInteger(grams) || grams < 0) throw new ShippingError("INVALID_INPUT", "grams must be a non-negative integer");
  return Math.ceil(grams / stepG) * stepG;
}

/**
 * chargeable = max(actual, volumetric), rounded up to the courier break. Never below actual; idempotent on breaks
 * (chargeable(chargeable) = chargeable); monotonic in the actual weight and in each dimension.
 * dims is optional (domestic listings may lack a package size): without it the actual weight is used.
 */
export function chargeableWeight(actualGrams: number, dims: DimsMm | undefined, divisor: number, stepG: number): number {
  if (!Number.isSafeInteger(actualGrams) || actualGrams <= 0) throw new ShippingError("INVALID_INPUT", "actual weight must be a positive integer (grams)");
  const volumetric = dims === undefined ? 0 : volumetricGrams(dims, divisor);
  return roundUpToStep(Math.max(actualGrams, volumetric), stepG);
}
