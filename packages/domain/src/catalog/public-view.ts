import type { Money } from "../money";
import type { Product } from "./product";
import type { Condition, ReturnClass } from "./types";
import { publicSellerIdentity, type PublicSellerIdentity, type SellerLegalRecord } from "./seller-identity";

/** The only price information the catalog ever emits. Produced by pricing-integrity, never by this module. */
export interface PriceBlockInput {
  readonly badge: "verified_discount" | "lowest_30d" | "launch_price" | "none";
  readonly referencePrice: Money | null;
  readonly discountPct: number | null;
  readonly claimId: string | null;
}

export const NO_PRICE_EVIDENCE: PriceBlockInput = { badge: "none", referencePrice: null, discountPct: null, claimId: null };

/** Coerces any port output to a legal block: a reference or percentage without a verified badge is dropped. */
export function sanitizePriceBlock(input: PriceBlockInput | null | undefined): PriceBlockInput {
  if (input === null || input === undefined) return NO_PRICE_EVIDENCE;
  if (input.badge === "verified_discount") {
    if (
      input.referencePrice === null ||
      input.discountPct === null ||
      !Number.isInteger(input.discountPct) ||
      input.discountPct < 5 ||
      input.discountPct > 100 ||
      input.claimId === null
    ) {
      return NO_PRICE_EVIDENCE;
    }
    return input;
  }
  return { badge: input.badge, referencePrice: null, discountPct: null, claimId: input.claimId };
}

export interface PublicSku {
  readonly id: string;
  readonly sizeLabel: string;
  readonly color?: string;
  readonly gtin?: string;
  readonly available: boolean;
  /** Real stock, exposed only for 1..5 (spec section 5). */
  readonly unitsLeft: number | null;
  readonly price: Money;
  readonly priceBlock: PriceBlockInput;
}

export interface PublicProductView {
  readonly id: string;
  readonly storeId: string;
  readonly title: { readonly ar: string; readonly en?: string };
  readonly description?: { readonly ar: string; readonly en?: string };
  readonly condition: Condition;
  readonly material?: string;
  readonly skus: readonly PublicSku[];
  readonly returnEligibility: { readonly returnable: boolean; readonly windowDays?: number; readonly reasonCode?: string };
  readonly sellerLegalIdentityVisible: boolean;
  /** Four-field projection for surfaces that may show it; null when incomplete. */
  readonly sellerIdentity: PublicSellerIdentity | null;
  readonly sizeChartAvailable: boolean;
  readonly updatedAtMs: number;
}

export const STANDARD_RETURN_WINDOW_DAYS = 14;

export function returnEligibility(cls: ReturnClass): PublicProductView["returnEligibility"] {
  switch (cls) {
    case "standard":
      return { returnable: true, windowDays: STANDARD_RETURN_WINDOW_DAYS };
    case "hygiene":
      return { returnable: false, reasonCode: "hygiene_non_returnable" };
    case "personalized":
      return { returnable: false, reasonCode: "personalized_non_returnable" };
    case "non_returnable":
      return { returnable: false, reasonCode: "non_returnable" };
  }
}

export interface PublicViewInputs {
  readonly product: Product;
  readonly returnClass: ReturnClass;
  readonly seller: SellerLegalRecord | null;
  /** Available units per SKU id, read from inventory for this request. Missing means unknown. */
  readonly stock: ReadonlyMap<string, number>;
  readonly priceBlocks: ReadonlyMap<string, PriceBlockInput>;
  readonly sizeChartValidated: boolean;
}

/** Returns null unless the product is `active`: shoppers cannot tell hidden from missing. */
export function buildPublicProductView(i: PublicViewInputs): PublicProductView | null {
  const p = i.product;
  if (p.status !== "active") return null;
  const identity = publicSellerIdentity(i.seller);
  const skus: PublicSku[] = p.skus
    .filter((s) => s.status !== "delisted")
    .map((s) => {
      const stock = i.stock.get(s.id);
      const n = stock !== undefined && Number.isInteger(stock) && stock > 0 ? stock : 0;
      const sellable = s.status === "active" && n >= 1;
      return {
        id: s.id,
        sizeLabel: s.sizeLabel,
        ...(s.color !== undefined ? { color: s.color } : {}),
        ...(s.gtin !== undefined ? { gtin: s.gtin } : {}),
        available: sellable,
        unitsLeft: sellable && n <= 5 ? n : null,
        price: s.price,
        priceBlock: sanitizePriceBlock(i.priceBlocks.get(s.id)),
      };
    });
  return {
    id: p.id,
    storeId: p.storeId,
    title: p.title,
    ...(p.description !== undefined ? { description: p.description } : {}),
    condition: p.condition,
    ...(p.material !== undefined ? { material: p.material } : {}),
    skus,
    returnEligibility: returnEligibility(i.returnClass),
    sellerLegalIdentityVisible: identity !== null,
    sellerIdentity: identity,
    sizeChartAvailable: i.sizeChartValidated,
    updatedAtMs: p.updatedAtMs,
  };
}
