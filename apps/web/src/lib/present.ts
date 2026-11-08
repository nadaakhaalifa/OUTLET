import { CURRENCIES, CURRENCY_MINOR_UNITS, money, type Currency, type Money } from "@outlet/money";
import { language, type Locale } from "@outlet/i18n";
import type { ConditionKey, CubbyItem, PriceInput } from "@outlet/ui-web";
import type { ProductSummary, StoreProfile } from "../server/api-client";

/** Arabic is authoritative (CPL 181/2018); English falls back to Arabic when missing. */
export function pick(locale: Locale, ar: string, en: string | null): string {
  return language(locale) === "en" && en !== null && en !== "" ? en : ar;
}

const isCurrency = (c: string): c is Currency => (CURRENCIES as readonly string[]).includes(c);

/**
 * PriceInput from API data. A % off and strike-through are produced ONLY when the engine returned a verified_discount claim
 * with a reference price in the same currency AND the store shows discounts publicly. Everything else is a plain price
 * (launch price keeps its label). Returns null when the currency is unknown (the item is then not rendered).
 */
export function toPricing(p: ProductSummary, store: Pick<StoreProfile, "discountDisplayMode"> | null): PriceInput | null {
  if (!isCurrency(p.price.currency)) return null;
  const price = money(p.price.amountMinor, p.price.currency);
  const refCur = p.price.referenceCurrency;
  if (p.price.claimType === "verified_discount" && store?.discountDisplayMode === "public" && p.price.referenceAmountMinor !== undefined && refCur !== undefined && isCurrency(refCur) && p.price.priceProofPath !== "") {
    return { price, verified: { claimAllowed: true, reference: money(p.price.referenceAmountMinor, refCur), evidenceIds: [p.price.priceProofPath] } };
  }
  return p.price.claimType === "launch_price" ? { price, priceKind: "launch" } : { price };
}

const CONDITIONS: Readonly<Record<string, ConditionKey>> = {
  new_clearance: "newClearance", previous_season: "previousSeason", open_box: "openBox", cosmetic_defect: "cosmeticDefect",
  refurbished: "refurbished", near_expiry: "nearExpiry", sample: "sample",
};
export function toCondition(code: string): ConditionKey | undefined {
  return CONDITIONS[code.toLowerCase().replace(/-/g, "_")];
}

export function toImage(p: ProductSummary, locale: Locale): { src: string; alt: string; width?: number; height?: number } | undefined {
  if (!p.image) return undefined;
  const alt = pick(locale, p.image.altAr ?? "", p.image.altEn) || pick(locale, p.titleAr, p.titleEn);
  return { src: p.image.url, alt, ...(p.image.width !== null ? { width: p.image.width } : {}), ...(p.image.height !== null ? { height: p.image.height } : {}) };
}

export function toCubby(p: ProductSummary, locale: Locale, store: StoreProfile | null, storeHref: string): CubbyItem | null {
  const pricing = toPricing(p, store);
  if (pricing === null) return null;
  const image = toImage(p, locale);
  return { key: p.id, name: pick(locale, p.titleAr, p.titleEn), href: `${storeHref}?p=${encodeURIComponent(p.id)}`, pricing, ...(image ? { image } : {}) };
}

/** Decimal string for JSON-LD from integer minor units (no floats). */
export function decimalString(m: Money): string {
  const units = CURRENCY_MINOR_UNITS[m.currency];
  const abs = m.amountMinor < 0n ? -m.amountMinor : m.amountMinor;
  if (units === 0) return `${m.amountMinor < 0n ? "-" : ""}${abs.toString()}`;
  const s = abs.toString().padStart(units + 1, "0");
  return `${m.amountMinor < 0n ? "-" : ""}${s.slice(0, -units)}.${s.slice(-units)}`;
}
