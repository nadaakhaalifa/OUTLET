/** Product page (spec §5). Pure view-model, port and in-memory fake; no UI imports. */
import { PortError, type PortFailure } from "../worlds/model";
import type { WishlistIntent } from "../wishlists/model";

export { PortError };
export type { PortFailure };

/** A claim exists only when the server's Price Integrity Engine verified it (spec §9). */
export interface VerifiedClaim {
  readonly referencePrice: bigint;
  readonly lowestIn30Days: boolean;
}

export interface SellerIdentity {
  readonly storeName: string;
  readonly legalName: string;
  readonly commercialRegisterNo: string;
  readonly taxCardNo: string;
  readonly governorate: string;
}

export interface SizeOption {
  readonly sku: string;
  readonly label: string;
  /** Units available; 0 = out of stock. */
  readonly stock: number;
}

export interface SizeRecommendation {
  readonly sizeLabel: string;
  /** 0..1 */
  readonly confidence: number;
}

export type FitDirection = "runsSmall" | "trueToSize" | "runsLarge";
export interface CommunityFit {
  readonly direction: FitDirection;
  readonly sampleCount: number;
}

export type ReturnPolicy =
  | { readonly kind: "standard"; readonly changeOfMindDays: number; readonly defectDays: number }
  | { readonly kind: "nonReturnable" };

export interface Product {
  readonly id: string;
  readonly title: string;
  readonly price: bigint;
  readonly claim: VerifiedClaim | null;
  /** Listing younger than 30 days with no history is labelled "Launch price", never "% off". */
  readonly isLaunchPrice: boolean;
  readonly imageCount: number;
  readonly seller: SellerIdentity;
  readonly sizes: readonly SizeOption[];
  readonly recommendation: SizeRecommendation | null;
  readonly communityFit: CommunityFit | null;
  readonly condition: "newWithTags" | "newWithoutTags" | "sample" | "minorDefect";
  readonly defectNote: string | null;
  readonly deliveryDaysMin: number | null;
  readonly deliveryDaysMax: number | null;
  readonly returnPolicy: ReturnPolicy;
  readonly status: "active" | "paused";
  /** Optional presentation fields: absent (undefined/null) means the UI hides them. */
  readonly brand?: string | null;
  readonly rating?: number | null;
  readonly reviewCount?: number | null;
  readonly colors?: readonly ProductColor[] | null;
  /** Real photo URL; always wins over the dev fixture photo. */
  readonly imageUrl?: string | null;
  /** Dev fixtures only: render the bundled board photo when no imageUrl exists. */
  readonly devPhoto?: boolean;
}

export interface ProductColor {
  readonly name: string;
  /** Theme colour token that paints the swatch (no raw colours in the model). */
  readonly tone: "sand" | "fill" | "textSecondary";
}

export interface PdpPort {
  load(productId: string): Promise<Product>;
  addToBag(sku: string): Promise<void>;
  saveWithIntent(productId: string, intent: WishlistIntent): Promise<void>;
}

/** Minimum verified discount to show a claim at all (spec §9.3). */
export const MIN_CLAIM_PCT = 5;
/** Below this the UI says "not sure" (spec §10). */
export const MIN_CONFIDENCE = 0.6;
/** Community fit is shown only from this many buyers (spec §10, Beta-Binomial minimum n). */
export const MIN_FIT_SAMPLE = 20;
/** Real stock is shown only when this low (spec §5). */
export const LOW_STOCK_MAX = 5;

export interface PriceBlockView {
  readonly price: bigint;
  /** Both present or both null: reference and percent are never shown separately or from seller input. */
  readonly reference: bigint | null;
  readonly discountPct: number | null;
  readonly lowestIn30Days: boolean;
  readonly launchPrice: boolean;
}

/** Integer math on piastres, floor (spec §9.3). */
export function discountPercent(reference: bigint, price: bigint): number {
  if (reference <= 0n || price >= reference) return 0;
  return Number(((reference - price) * 100n) / reference);
}

export function buildPriceBlock(p: Pick<Product, "price" | "claim" | "isLaunchPrice">): PriceBlockView {
  const plain: PriceBlockView = { price: p.price, reference: null, discountPct: null, lowestIn30Days: false, launchPrice: false };
  if (p.claim !== null) {
    const pct = discountPercent(p.claim.referencePrice, p.price);
    if (pct >= MIN_CLAIM_PCT) {
      return { price: p.price, reference: p.claim.referencePrice, discountPct: pct, lowestIn30Days: p.claim.lowestIn30Days, launchPrice: false };
    }
    if (p.claim.lowestIn30Days) return { ...plain, lowestIn30Days: true };
  }
  return { ...plain, launchPrice: p.isLaunchPrice };
}

export type SizeStock = { readonly kind: "soldOut" } | { readonly kind: "low"; readonly left: number } | { readonly kind: "ok" };
export function sizeStock(stock: number): SizeStock {
  if (stock <= 0) return { kind: "soldOut" };
  return stock <= LOW_STOCK_MAX ? { kind: "low", left: stock } : { kind: "ok" };
}

export interface RecommendationView {
  readonly sizeLabel: string;
  readonly confidencePct: number;
  readonly sure: boolean;
  readonly inStock: boolean;
}

export function buildRecommendation(p: Pick<Product, "recommendation" | "sizes">): RecommendationView | null {
  const r = p.recommendation;
  if (r === null) return null;
  const confidencePct = Math.max(0, Math.min(100, Math.floor(r.confidence * 100)));
  const size = p.sizes.find((s) => s.label === r.sizeLabel);
  return { sizeLabel: r.sizeLabel, confidencePct, sure: r.confidence >= MIN_CONFIDENCE, inStock: size !== undefined && size.stock > 0 };
}

/**
 * Guest size hint (device-local profile, spec section 2). The public product carries no size chart, so the only honest
 * on-device match is the usual size the shopper saved on this phone. No confidence figure is invented.
 */
export function localFitHint(sizes: readonly SizeOption[], usualSize: string | null): { readonly sizeLabel: string; readonly inStock: boolean } | null {
  if (usualSize === null) return null;
  const want = usualSize.trim().toLowerCase();
  const hit = sizes.find((z) => z.label.trim().toLowerCase() === want);
  return hit === undefined ? null : { sizeLabel: hit.label, inStock: hit.stock > 0 };
}

/** A guest "Notify me" is offered only when the item is paused or sold out, so it is always a back-in-stock watch. */
export const GUEST_WATCH_KIND = "restock" as const;

/** The exact shape stored on the phone: ids and kind only, no title, price text or personal data. */
export function guestWatchInput(productId: string, skuId: string | null): { readonly productId: string; readonly skuId: string | null; readonly kind: typeof GUEST_WATCH_KIND } {
  return { productId, skuId, kind: GUEST_WATCH_KIND };
}

export function buildCommunityFit(c: CommunityFit | null): CommunityFit | null {
  return c !== null && c.sampleCount >= MIN_FIT_SAMPLE ? c : null;
}

export type AddBlock = "pickSize" | "soldOut" | "paused";

export interface PdpView {
  readonly price: PriceBlockView;
  readonly sizes: readonly { readonly option: SizeOption; readonly stock: SizeStock; readonly selected: boolean }[];
  readonly recommendation: RecommendationView | null;
  readonly communityFit: CommunityFit | null;
  readonly delivery: { readonly min: number; readonly max: number } | null;
  readonly canAddToBag: boolean;
  /** Why the add button is not usable; null when it is. */
  readonly blocked: AddBlock | null;
  /** Paused/sold out shows a notify-me option instead (spec §5 edge cases). */
  readonly offerNotify: boolean;
  readonly showDefectNote: boolean;
}

export function buildPdp(p: Product, selectedSku: string | null): PdpView {
  const allSoldOut = p.sizes.length > 0 && p.sizes.every((s) => s.stock <= 0);
  const selected = p.sizes.find((s) => s.sku === selectedSku && s.stock > 0) ?? null;
  const blocked: AddBlock | null = p.status === "paused" ? "paused" : allSoldOut ? "soldOut" : selected === null ? "pickSize" : null;
  const delivery =
    p.deliveryDaysMin !== null && p.deliveryDaysMax !== null && p.deliveryDaysMin <= p.deliveryDaysMax
      ? { min: p.deliveryDaysMin, max: p.deliveryDaysMax }
      : null;
  return {
    price: buildPriceBlock(p),
    sizes: p.sizes.map((o) => ({ option: o, stock: sizeStock(o.stock), selected: selected !== null && o.sku === selected.sku })),
    recommendation: buildRecommendation(p),
    communityFit: buildCommunityFit(p.communityFit),
    delivery,
    canAddToBag: blocked === null,
    blocked,
    offerNotify: blocked === "paused" || blocked === "soldOut",
    showDefectNote: p.condition === "minorDefect" && p.defectNote !== null,
  };
}

export type PdpScreenState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly offline: boolean }
  | { readonly status: "ready"; readonly product: Product };

export function pdpFailureState(e: unknown): PdpScreenState {
  return { status: "error", offline: e instanceof PortError && e.kind === "offline" };
}

/* ---- in-memory fakes (development and tests only; synthetic data) ---- */

export const FIXTURE_PRODUCT: Product = {
  id: "p1",
  title: "Linen Blend Blazer",
  price: 249_900n,
  claim: { referencePrice: 499_900n, lowestIn30Days: false },
  isLaunchPrice: false,
  imageCount: 3,
  seller: { storeName: "Delta Dresses", legalName: "Delta Garments LLC", commercialRegisterNo: "000-000", taxCardNo: "000-000-000", governorate: "Cairo" },
  sizes: [
    { sku: "p1-xs", label: "XS", stock: 9 },
    { sku: "p1-s", label: "S", stock: 0 },
    { sku: "p1-m", label: "M", stock: 2 },
    { sku: "p1-l", label: "L", stock: 14 },
    { sku: "p1-xl", label: "XL", stock: 8 },
  ],
  recommendation: { sizeLabel: "M", confidence: 0.91 },
  communityFit: { direction: "runsSmall", sampleCount: 24 },
  condition: "newWithTags",
  defectNote: null,
  deliveryDaysMin: 2,
  deliveryDaysMax: 4,
  returnPolicy: { kind: "standard", changeOfMindDays: 14, defectDays: 30 },
  status: "active",
  brand: "ZARA",
  rating: 4.6,
  reviewCount: 124,
  colors: [
    { name: "Beige", tone: "sand" },
    { name: "Sand", tone: "fill" },
    { name: "Graphite", tone: "textSecondary" },
  ],
  devPhoto: true,
};

export class InMemoryPdpPort implements PdpPort {
  readonly added: string[] = [];
  readonly saved: { productId: string; intent: WishlistIntent }[] = [];
  constructor(private readonly product: Product = FIXTURE_PRODUCT, private failure: PortFailure | null = null) {}
  setFailure(f: PortFailure | null): void {
    this.failure = f;
  }
  private check(): void {
    if (this.failure !== null) throw new PortError(this.failure);
  }
  async load(): Promise<Product> {
    this.check();
    return this.product;
  }
  async addToBag(sku: string): Promise<void> {
    this.check();
    this.added.push(sku);
  }
  async saveWithIntent(productId: string, intent: WishlistIntent): Promise<void> {
    this.check();
    this.saved.push({ productId, intent });
  }
}

/* ---- gallery (spec §5): at least one slide, never more than 10 ---- */
export const MAX_GALLERY = 10;
export function gallerySlides(imageCount: number): number {
  return Math.max(1, Math.min(MAX_GALLERY, Math.floor(imageCount)));
}
/** Index from a horizontal scroll offset, clamped; RTL offsets are passed already normalised by the caller. */
export function galleryIndex(offsetX: number, pageWidth: number, slides: number): number {
  if (pageWidth <= 0) return 0;
  return Math.max(0, Math.min(slides - 1, Math.round(offsetX / pageWidth)));
}
