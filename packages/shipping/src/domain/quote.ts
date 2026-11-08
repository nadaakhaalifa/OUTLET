import { money } from "@outlet/money";
import type { Currency, Money } from "@outlet/money";
import { ShippingError } from "./errors.js";
import { chargeableWeight } from "./weight.js";
import type { DimsMm } from "./weight.js";

/** One priced weight band: applies to chargeable weights w with weightFromG < w <= weightToG. */
export interface RateBand {
  readonly weightFromG: number;
  readonly weightToG: number;
  readonly priceMinor: bigint;
}

/** A courier service that covers one geo area, with its rate card for the destination zone (already filtered by validity date). */
export interface CourierOffer {
  readonly courier: string;
  readonly serviceLevel: string;
  readonly geoAreaId: string;
  readonly slaDaysP80: number;
  readonly codSupported: boolean;
  readonly stepG: number;
  readonly volumetricDivisor: number;
  readonly currency: Currency;
  readonly bands: readonly RateBand[];
}

export interface QuoteLine {
  readonly weightG: number;
  readonly dimsMm?: DimsMm;
  readonly qty?: number;
  readonly codAllowed: boolean;
}

export interface QuoteInput {
  readonly storeId: string;
  /** Destination area ids, most specific first (district, city, governorate). */
  readonly destination: { readonly areaIds: readonly string[] };
  readonly lines: readonly QuoteLine[];
  readonly subtotalMinor: bigint;
  readonly currency: Currency;
  readonly plus: boolean;
  readonly thresholdMinor: bigint;
  /** Offers from coverage + rate cards (any number of areas/couriers). */
  readonly offers: readonly CourierOffer[];
  /** Store setting: when non-empty only these couriers are eligible. */
  readonly allowedCouriers?: readonly string[];
}

export interface ShipmentQuote {
  readonly storeId: string;
  /** What the shopper pays: 0 when free. */
  readonly fee: Money;
  readonly freeDelivery: boolean;
  /** Cheapest eligible courier cost before the free-delivery rule (platform/seller cost, for the ledger). */
  readonly courierCost: Money;
  readonly courier: string;
  readonly serviceLevel: string;
  readonly etaDays: number;
  readonly codAvailable: boolean;
  readonly chargeableGrams: number;
}

const MAX_QTY = 1000;

export function parcelChargeableGrams(lines: readonly QuoteLine[], divisor: number, stepG: number): number {
  let total = 0;
  for (const l of lines) {
    const qty = l.qty ?? 1;
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_QTY) throw new ShippingError("INVALID_INPUT", "qty out of range");
    total += chargeableWeight(l.weightG, l.dimsMm, divisor, stepG) * qty;
  }
  return total;
}

const bandFor = (bands: readonly RateBand[], grams: number): RateBand | undefined => bands.find((b) => grams > b.weightFromG && grams <= b.weightToG);

/** Picks, per (courier, service), the offer at the most specific destination area. */
function mostSpecific(offers: readonly CourierOffer[], areaIds: readonly string[]): CourierOffer[] {
  const rank = new Map(areaIds.map((id, i) => [id, i] as const));
  const best = new Map<string, CourierOffer>();
  for (const o of offers) {
    const r = rank.get(o.geoAreaId);
    if (r === undefined) continue;
    const key = `${o.courier}\u0000${o.serviceLevel}`;
    const cur = best.get(key);
    if (cur === undefined || r < (rank.get(cur.geoAreaId) ?? Infinity)) best.set(key, o);
  }
  return [...best.values()];
}

/**
 * Cheapest eligible courier covering the destination. Never guesses a fee: no covering courier -> NO_COVERAGE,
 * covered but the parcel is heavier than every rate band -> OVERWEIGHT. Free delivery (subtotal >= threshold, or Plus)
 * zeroes the shopper fee only; the courier is still the cheapest by real cost.
 */
export function quoteShipment(input: QuoteInput): ShipmentQuote {
  if (input.lines.length === 0) throw new ShippingError("INVALID_INPUT", "no lines");
  if (input.subtotalMinor < 0n || input.thresholdMinor < 0n) throw new ShippingError("INVALID_INPUT", "amounts must not be negative");
  const allowed = input.allowedCouriers ?? [];
  const covering = mostSpecific(input.offers, input.destination.areaIds).filter(
    (o) => o.currency === input.currency && (allowed.length === 0 || allowed.includes(o.courier)),
  );
  if (covering.length === 0) throw new ShippingError("NO_COVERAGE", "no courier covers the destination");

  let best: { offer: CourierOffer; priceMinor: bigint; grams: number } | undefined;
  for (const offer of covering) {
    const grams = parcelChargeableGrams(input.lines, offer.volumetricDivisor, offer.stepG);
    const band = bandFor(offer.bands, grams);
    if (band === undefined) continue;
    const cand = { offer, priceMinor: band.priceMinor, grams };
    if (best === undefined || beats(cand, best)) best = cand;
  }
  if (best === undefined) throw new ShippingError("OVERWEIGHT", "parcel exceeds every rate band");

  const free = input.plus || input.subtotalMinor >= input.thresholdMinor;
  return {
    storeId: input.storeId,
    fee: money(free ? 0n : best.priceMinor, input.currency),
    freeDelivery: free,
    courierCost: money(best.priceMinor, input.currency),
    courier: best.offer.courier,
    serviceLevel: best.offer.serviceLevel,
    etaDays: best.offer.slaDaysP80,
    codAvailable: best.offer.codSupported && input.lines.every((l) => l.codAllowed),
    chargeableGrams: best.grams,
  };
}

interface Cand { readonly offer: CourierOffer; readonly priceMinor: bigint }
function beats(a: Cand, b: Cand): boolean {
  if (a.priceMinor !== b.priceMinor) return a.priceMinor < b.priceMinor;
  if (a.offer.slaDaysP80 !== b.offer.slaDaysP80) return a.offer.slaDaysP80 < b.offer.slaDaysP80;
  const ka = `${a.offer.courier}/${a.offer.serviceLevel}`;
  const kb = `${b.offer.courier}/${b.offer.serviceLevel}`;
  return ka < kb;
}
