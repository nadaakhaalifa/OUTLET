import { InvalidHubInputError } from "./types";

/**
 * SCI style estimate: SCI = ((E x I) + M) per R, R = one parcel. Here E x I is approximated by
 * distance x weight x an emission factor (g CO2e per tonne-km) and M by a flat handling term.
 * Every factor is an ASSUMPTION (VERIFY BEFORE LAUNCH, register row 18: grid and courier factors),
 * so every result is labelled an estimate and carries the factor version.
 */
export interface CarbonFactors {
  readonly version: string;
  /** g CO2e per tonne-km, road van. */
  readonly gPerTonneKm: bigint;
  /** g CO2e per parcel for hub scanning, sorting and packaging (the M term, flat). */
  readonly handlingGPerParcel: bigint;
}

export const DEFAULT_CARBON_FACTORS: CarbonFactors = {
  version: "assumed-2026-10-1",
  gPerTonneKm: 500n,
  handlingGPerParcel: 50n,
};

export interface CarbonEstimate {
  readonly gCo2e: bigint;
  readonly method: "distance_estimate";
  readonly isEstimate: true;
  readonly factorsVersion: string;
}

const nat = (n: number, what: string): bigint => {
  if (!Number.isInteger(n) || n < 0) throw new InvalidHubInputError(`${what} must be a non-negative integer`);
  return BigInt(n);
};

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** One road leg of `weightG` grams over `distanceKm` kilometres, rounded up to whole grams. */
export function estimateLegGco2e(
  distanceKm: number,
  weightG: number,
  f: CarbonFactors = DEFAULT_CARBON_FACTORS,
): bigint {
  // km x g / 1e6 = tonne-km
  return ceilDiv(nat(distanceKm, "distanceKm") * nat(weightG, "weightG") * f.gPerTonneKm, 1_000_000n);
}

export function estimateParcelGco2e(
  legs: readonly { readonly distanceKm: number; readonly weightG: number }[],
  f: CarbonFactors = DEFAULT_CARBON_FACTORS,
): CarbonEstimate {
  let total = f.handlingGPerParcel;
  for (const l of legs) total += estimateLegGco2e(l.distanceKm, l.weightG, f);
  return { gCo2e: total, method: "distance_estimate", isEstimate: true, factorsVersion: f.version };
}

export interface ConsolidationComparison {
  readonly consolidated: CarbonEstimate;
  readonly separate: CarbonEstimate;
  /** separate - consolidated. Negative when cross-docking adds distance; reported honestly. */
  readonly savedGco2e: bigint;
}

/**
 * Consolidated: every seller order travels seller -> hub, one parcel hub -> shopper.
 * Separate (counterfactual): every seller order travels seller -> shopper on its own.
 */
export function compareConsolidation(
  orders: readonly { readonly sellerToHubKm: number; readonly sellerToShopperKm: number; readonly weightG: number }[],
  hubToShopperKm: number,
  f: CarbonFactors = DEFAULT_CARBON_FACTORS,
): ConsolidationComparison {
  const totalWeight = orders.reduce((s, o) => s + o.weightG, 0);
  const inbound = orders.map((o) => ({ distanceKm: o.sellerToHubKm, weightG: o.weightG }));
  const consolidated = estimateParcelGco2e([...inbound, { distanceKm: hubToShopperKm, weightG: totalWeight }], f);
  // each separate parcel pays its own handling
  const sepTotal = orders.reduce((s, o) => s + f.handlingGPerParcel + estimateLegGco2e(o.sellerToShopperKm, o.weightG, f), 0n);
  const separate: CarbonEstimate = { ...consolidated, gCo2e: sepTotal };
  return { consolidated, separate, savedGco2e: sepTotal - consolidated.gCo2e };
}
