import { decimalPrice } from "../lib/format";
import { pick } from "../lib/localized";
import type { Locale } from "../i18n";
import type { PriceEvidence, Product } from "./types";
import { priceView, type PriceView } from "./price";

export interface SizeRow {
  readonly id: string;
  readonly label: string;
  readonly color: string | null;
  readonly available: boolean;
  /** Only real server values 1..5 are surfaced (spec 5 rules). */
  readonly unitsLeft: number | null;
  readonly price: PriceView;
}

export function sizeRows(p: Product, evidence: PriceEvidence | null | undefined): SizeRow[] {
  return p.skus.map((s) => ({
    id: s.id,
    label: s.size_label,
    color: s.color ?? null,
    available: s.available,
    unitsLeft: s.available && s.units_left !== null && s.units_left !== undefined && s.units_left >= 1 && s.units_left <= 5 ? s.units_left : null,
    price: priceView(s.price, evidence),
  }));
}

export const isInStock = (p: Product): boolean => p.skus.some((s) => s.available);

export interface JsonLdInput {
  readonly product: Product;
  readonly url: string;
  readonly site: string;
  readonly locale: Locale;
  readonly imageUrls: readonly string[];
}

/**
 * schema.org Product + Offer from API data only. Never emits a reference price, strike-through, priceValidUntil,
 * rating or review markup (spec P3-06 honesty rule; the Product contract carries no real review aggregate).
 */
export function productJsonLd(i: JsonLdInput): Record<string, unknown> {
  const p = i.product;
  const price = decimalPrice(BigInt(p.price.price.amount));
  const availability = isInStock(p) ? "https://schema.org/InStock" : "https://schema.org/OutOfStock";
  const condition =
    p.condition === "new_with_tags" || p.condition === "new_without_tags"
      ? "https://schema.org/NewCondition"
      : "https://schema.org/UsedCondition";
  const desc = p.description === undefined ? undefined : pick(p.description, i.locale);
  const out: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: pick(p.title, i.locale),
    url: i.url,
    ...(i.imageUrls.length > 0 ? { image: [...i.imageUrls] } : {}),
    ...(desc === undefined ? {} : { description: desc }),
    ...(p.material === undefined ? {} : { material: p.material }),
    brand: { "@type": "Brand", name: pick(p.store.name, i.locale) },
    offers: {
      "@type": "Offer",
      url: i.url,
      price,
      priceCurrency: "EGP",
      availability,
      itemCondition: condition,
      seller: { "@type": "Organization", name: pick(p.store.name, i.locale) },
    },
  };
  return out;
}

export function organizationJsonLd(site: string, name: string): Record<string, unknown> {
  return { "@context": "https://schema.org", "@type": "Organization", name, url: site };
}

export function sellerJsonLd(name: string, url: string, legalName: string | undefined): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name,
    url,
    ...(legalName === undefined ? {} : { legalName }),
  };
}

export function breadcrumbJsonLd(items: readonly { name: string; url: string }[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, idx) => ({ "@type": "ListItem", position: idx + 1, name: it.name, item: it.url })),
  };
}

/** JSON for a `<script type="application/ld+json">`: `<` is escaped so data can never close the element. */
export function serializeJsonLd(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
