import { forecasting } from "@outlet/domain";
import type { SeriesRow } from "../domain/ports";

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const STORE_A = "00000000-0000-4000-a000-000000000001";
export const STORE_B = "00000000-0000-4000-a000-000000000002";
export const SKU_M = U(20);
export const SKU_L = U(21);
export const START_DAY = "2026-07-01";
export const DAYS = 84;
export const AS_OF = forecasting.indexToIsoDay(forecasting.isoDayToIndex(START_DAY) + DAYS - 1);
export const NOW_MS = Date.parse(`${AS_OF}T23:00:00Z`) + 3 * 3_600_000;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function poisson(rand: () => number, lambda: number): number {
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rand();
  } while (p > l);
  return k - 1;
}
const WEEK = [0.6, 0.7, 0.8, 1.0, 1.6, 2.0, 1.3];

export interface SeriesSpec {
  readonly store?: string;
  readonly sku: string;
  readonly category?: string;
  readonly size?: string;
  readonly governorate?: string;
  readonly base: number;
  readonly seed: number;
  readonly days?: number;
  /** Distinct shoppers per day (capped at units). Default: equal to units. */
  readonly shoppersPerDay?: number;
  readonly censorEvery?: number;
}

/** A seasonal Poisson series as stored day rows. */
export function seriesRows(s: SeriesSpec): SeriesRow[] {
  const rand = mulberry32(s.seed);
  const days = s.days ?? DAYS;
  const start = forecasting.isoDayToIndex(START_DAY);
  const out: SeriesRow[] = [];
  for (let i = 0; i < days; i += 1) {
    const units = poisson(rand, s.base * (WEEK[i % 7] ?? 1));
    const censored = s.censorEvery !== undefined && i > 14 && i % s.censorEvery === 0;
    out.push({
      storeId: s.store ?? STORE_A,
      skuId: s.sku,
      categoryCode: s.category ?? "dresses",
      sizeLabel: s.size ?? "M",
      governorate: s.governorate ?? "Cairo",
      day: forecasting.indexToIsoDay(start + i),
      unitsGross: units,
      unitsNet: units,
      censored,
      flagged: false,
      shoppers: Math.min(units, s.shoppersPerDay ?? units),
    });
  }
  return out;
}
