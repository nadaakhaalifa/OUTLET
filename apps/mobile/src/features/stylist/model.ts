/** AI stylist (spec §11, phase2/04). Money is integer piastres (bigint). Pure model, ports and fakes. */
import { PortError, type PortFailure } from "../worlds/model";

export { PortError };
export type { PortFailure };

export const OCCASIONS = ["work", "weddingGuest", "date", "eid", "beach", "gym", "university"] as const;
export type Occasion = (typeof OCCASIONS)[number];
export const VIBES = ["classic", "street", "minimal", "bold"] as const;
export type Vibe = (typeof VIBES)[number];
export const SLOTS = ["top", "bottom", "dress", "shoes", "bag", "accessory"] as const;
export type Slot = (typeof SLOTS)[number];

/** Spec: 3-5 outfits per request. */
export const MAX_OUTFITS = 5;

export interface OutfitRequest {
  readonly occasion: Occasion;
  readonly vibe: Vibe;
  readonly modest: boolean;
  /** Piastres, or null for no limit. */
  readonly budget: bigint | null;
}

export interface OutfitItem {
  readonly skuId: string;
  readonly slot: Slot;
  readonly title: string;
  readonly storeId: string;
  readonly storeName: string;
  readonly sizeLabel: string;
  readonly unitPrice: bigint;
}

export interface StoreDelivery {
  readonly storeId: string;
  readonly storeName: string;
  /** Server-computed fee in piastres; 0n means free. */
  readonly fee: bigint;
}

export interface MissingSlot {
  readonly slot: Slot;
  /** Server-computed extra amount needed to complete the slot. */
  readonly shortfall: bigint;
}

export interface Outfit {
  readonly id: string;
  readonly items: readonly OutfitItem[];
  readonly deliveries: readonly StoreDelivery[];
  readonly missing: readonly MissingSlot[];
}

export type OutfitSource = "ai" | "rules";

export interface OutfitResult {
  readonly outfits: readonly Outfit[];
  readonly source: OutfitSource;
}

export type FeedbackSignal = "like" | "dislike";

export type RejectReason = "soldOut" | "paused" | "priceChanged";
export interface RejectedItem {
  readonly skuId: string;
  readonly reason: RejectReason;
  /** Present for priceChanged: the re-validated current price. */
  readonly currentPrice: bigint | null;
}
export interface AddOutfitResult {
  readonly added: readonly string[];
  readonly rejected: readonly RejectedItem[];
}

export interface StylistPort {
  generate(req: OutfitRequest): Promise<OutfitResult>;
  swap(outfitId: string, skuId: string): Promise<Outfit>;
  feedback(outfitId: string, skuId: string, signal: FeedbackSignal): Promise<void>;
}

/**
 * Add-to-bag side of the bag port for outfits. The server re-validates stock and price for every
 * item and reports rejections explicitly; nothing is silently dropped (spec 04 acceptance).
 */
export interface OutfitBagPort {
  addOutfit(outfitId: string, idempotencyKey: string): Promise<AddOutfitResult>;
}

/** Parses the budget field into piastres. Empty = no limit. Whole EGP only. */
export type BudgetParse = { readonly ok: true; readonly value: bigint | null } | { readonly ok: false };
export function parseBudgetEgp(raw: string): BudgetParse {
  const s = raw.trim().replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  if (s === "") return { ok: true, value: null };
  if (!/^[0-9]{1,7}$/.test(s)) return { ok: false };
  const egp = BigInt(s);
  return egp === 0n ? { ok: false } : { ok: true, value: egp * 100n };
}

export function itemsTotal(o: Pick<Outfit, "items">): bigint {
  return o.items.reduce((s, i) => s + i.unitPrice, 0n);
}

export type BudgetFit =
  | { readonly kind: "none" }
  | { readonly kind: "exact" }
  | { readonly kind: "fits"; readonly spare: bigint }
  | { readonly kind: "over"; readonly by: bigint };

export function budgetFit(total: bigint, budget: bigint | null): BudgetFit {
  if (budget === null) return { kind: "none" };
  if (total === budget) return { kind: "exact" };
  return total < budget ? { kind: "fits", spare: budget - total } : { kind: "over", by: total - budget };
}

export interface OutfitView {
  readonly outfit: Outfit;
  readonly total: bigint;
  readonly fit: BudgetFit;
  readonly isPartial: boolean;
  readonly missing: readonly MissingSlot[];
  readonly deliveries: readonly StoreDelivery[];
}

/** Keeps at most MAX_OUTFITS; drops outfits with no items (nothing to show or add). */
export function buildOutfitViews(outfits: readonly Outfit[], budget: bigint | null): readonly OutfitView[] {
  return outfits
    .filter((o) => o.items.length > 0)
    .slice(0, MAX_OUTFITS)
    .map((outfit) => {
      const total = itemsTotal(outfit);
      return { outfit, total, fit: budgetFit(total, budget), isPartial: outfit.missing.length > 0, missing: outfit.missing, deliveries: outfit.deliveries };
    });
}

export function replaceOutfit(outfits: readonly Outfit[], next: Outfit): readonly Outfit[] {
  return outfits.map((o) => (o.id === next.id ? next : o));
}

export type StylistScreenState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly offline: boolean }
  | { readonly status: "ready"; readonly result: OutfitResult; readonly budget: bigint | null };

export function stylistFailureState(e: unknown): StylistScreenState {
  return { status: "error", offline: e instanceof PortError && e.kind === "offline" };
}

export interface AddOutcome {
  readonly kind: "added" | "partial" | "none";
  readonly rejected: readonly RejectedItem[];
}
export function addOutcome(r: AddOutfitResult): AddOutcome {
  if (r.rejected.length === 0) return { kind: "added", rejected: [] };
  return { kind: r.added.length > 0 ? "partial" : "none", rejected: r.rejected };
}

/* ---- in-memory fakes (development and tests only; synthetic data) ---- */

const item = (skuId: string, slot: Slot, title: string, storeId: string, storeName: string, price: bigint): OutfitItem => ({
  skuId, slot, title, storeId, storeName, sizeLabel: "M", unitPrice: price,
});

export const FIXTURE_OUTFITS: readonly Outfit[] = [
  {
    id: "o1",
    items: [
      item("a1", "dress", "Linen midi dress", "s1", "Cairo Denim", 120_000n),
      item("a2", "shoes", "Leather flats", "s3", "Atlas Sport", 60_000n),
      item("a3", "bag", "Canvas tote", "s1", "Cairo Denim", 30_000n),
    ],
    deliveries: [
      { storeId: "s1", storeName: "Cairo Denim", fee: 0n },
      { storeId: "s3", storeName: "Atlas Sport", fee: 6_000n },
    ],
    missing: [],
  },
  {
    id: "o2",
    items: [item("b1", "top", "Cotton shirt", "s1", "Cairo Denim", 45_000n), item("b2", "bottom", "Wide trousers", "s3", "Atlas Sport", 80_000n)],
    deliveries: [
      { storeId: "s1", storeName: "Cairo Denim", fee: 5_000n },
      { storeId: "s3", storeName: "Atlas Sport", fee: 6_000n },
    ],
    missing: [{ slot: "shoes", shortfall: 25_000n }],
  },
];

export class InMemoryStylistPort implements StylistPort, OutfitBagPort {
  readonly feedbackLog: string[] = [];
  readonly added: string[] = [];
  constructor(
    private readonly outfits: readonly Outfit[] = FIXTURE_OUTFITS,
    private readonly source: OutfitSource = "ai",
    private failure: PortFailure | null = null,
    private readonly rejections: readonly RejectedItem[] = [],
  ) {}
  setFailure(f: PortFailure | null): void {
    this.failure = f;
  }
  private check(): void {
    if (this.failure !== null) throw new PortError(this.failure);
  }
  async generate(): Promise<OutfitResult> {
    this.check();
    return { outfits: this.outfits, source: this.source };
  }
  async swap(outfitId: string, skuId: string): Promise<Outfit> {
    this.check();
    const o = this.outfits.find((x) => x.id === outfitId);
    if (o === undefined) throw new PortError("failed");
    return { ...o, items: o.items.map((i) => (i.skuId === skuId ? { ...i, skuId: `${skuId}-alt`, title: `${i.title} (alt)` } : i)) };
  }
  async feedback(outfitId: string, skuId: string, signal: FeedbackSignal): Promise<void> {
    this.check();
    this.feedbackLog.push(`${outfitId}:${skuId}:${signal}`);
  }
  async addOutfit(outfitId: string): Promise<AddOutfitResult> {
    this.check();
    const o = this.outfits.find((x) => x.id === outfitId);
    const rejectedIds = new Set(this.rejections.map((r) => r.skuId));
    const added = (o?.items ?? []).map((i) => i.skuId).filter((id) => !rejectedIds.has(id));
    this.added.push(...added);
    return { added, rejected: this.rejections };
  }
}
