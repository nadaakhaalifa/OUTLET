import { divideRoundHalfEven } from "../money";
import { gateByShoppers, type KGated } from "./kanon";

export interface SalesTotals {
  /** Gross merchandise value, integer piastres. */
  readonly gmvMinor: bigint;
  /** Commission and fees HAUL charged on that GMV, integer piastres. */
  readonly commissionMinor: bigint;
  readonly units: number;
  /** Distinct seller orders. */
  readonly orders: number;
  /** Distinct shoppers who bought in the window. Internal: only ever used to gate and compute. */
  readonly distinctShoppers: number;
  /** Shoppers with two or more distinct orders in the window. Internal. */
  readonly repeatShoppers: number;
}

export interface SalesSummary {
  readonly currency: "EGP";
  readonly gmvMinor: bigint;
  readonly commissionMinor: bigint;
  readonly netMinor: bigint;
  readonly units: number;
  readonly orders: number;
  /** Average order value, banker's rounding at this single point; null when there are no orders. */
  readonly aovMinor: bigint | null;
  /** Repeat-customer rate in bps, released only for >= 50 distinct shoppers. */
  readonly repeatRateBps: KGated<number>;
}

export function summarizeSales(t: SalesTotals): SalesSummary {
  if (t.gmvMinor < 0n || t.commissionMinor < 0n) throw new RangeError("sales amounts must not be negative");
  if (t.commissionMinor > t.gmvMinor) throw new RangeError("commission cannot exceed GMV");
  if (t.repeatShoppers > t.distinctShoppers) throw new RangeError("repeat shoppers cannot exceed distinct shoppers");
  const rate =
    t.distinctShoppers === 0 ? 0 : Number(divideRoundHalfEven(BigInt(t.repeatShoppers) * 10_000n, BigInt(t.distinctShoppers)));
  return {
    currency: "EGP",
    gmvMinor: t.gmvMinor,
    commissionMinor: t.commissionMinor,
    netMinor: t.gmvMinor - t.commissionMinor,
    units: t.units,
    orders: t.orders,
    aovMinor: t.orders === 0 ? null : divideRoundHalfEven(t.gmvMinor, BigInt(t.orders)),
    repeatRateBps: gateByShoppers(t.distinctShoppers, rate),
  };
}
