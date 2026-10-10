/** Multi-store bag (spec §6). Money is integer piastres (bigint). Pure model, ports and fakes. */
import { PortError, type PortFailure } from "../worlds/model";

export { PortError };
export type { PortFailure };

/** Default threshold from spec §6 (2,000 EGP). The real value always comes from store config. */
export const DEFAULT_FREE_DELIVERY_THRESHOLD = 200_000n;

export type Availability = "available" | "soldOut" | "paused";

export interface BagStore {
  readonly id: string;
  readonly name: string;
  readonly status: "active" | "suspended";
  readonly freeDeliveryThreshold: bigint;
}

export interface BagLine {
  readonly id: string;
  readonly storeId: string;
  readonly title: string;
  readonly sizeLabel: string | null;
  readonly qty: number;
  readonly unitPrice: bigint;
  readonly priceAtAdd: bigint;
  readonly availability: Availability;
  readonly savedForLater: boolean;
}

export interface BagSnapshot {
  readonly stores: readonly BagStore[];
  readonly lines: readonly BagLine[];
  readonly isPlusMember: boolean;
}

export interface Suggestion {
  readonly skuId: string;
  readonly title: string;
  readonly sizeLabel: string;
  readonly unitPrice: bigint;
}

export interface BagPort {
  load(): Promise<BagSnapshot>;
  /** Candidates already filtered to the shopper's size and in stock; ranking is done in the view model. */
  inSizeSuggestions(storeId: string): Promise<readonly Suggestion[]>;
  setSavedForLater(lineId: string, saved: boolean): Promise<void>;
}

export type PriceChange = { readonly kind: "same" } | { readonly kind: "dropped" | "rose"; readonly delta: bigint };

/** Both directions are shown honestly (spec §6). */
export function priceChange(line: Pick<BagLine, "unitPrice" | "priceAtAdd">): PriceChange {
  const d = line.unitPrice - line.priceAtAdd;
  if (d === 0n) return { kind: "same" };
  return d < 0n ? { kind: "dropped", delta: -d } : { kind: "rose", delta: d };
}

export function lineTotal(line: Pick<BagLine, "unitPrice" | "qty">): bigint {
  return line.unitPrice * BigInt(line.qty);
}

export interface LineView {
  readonly line: BagLine;
  readonly total: bigint;
  readonly change: PriceChange;
  /** Locked lines cannot be purchased: store suspended, or the SKU is sold out or paused. */
  readonly purchasable: boolean;
}

export interface FreeDelivery {
  readonly threshold: bigint;
  readonly unlocked: boolean;
  readonly viaPlus: boolean;
  readonly remaining: bigint;
  /** Integer 0..100, floor, from piastres. Never rounded up to look further along. */
  readonly progressPct: number;
}

export interface StoreGroup {
  readonly store: BagStore;
  readonly locked: boolean;
  readonly lines: readonly LineView[];
  readonly saved: readonly LineView[];
  readonly subtotal: bigint;
  readonly freeDelivery: FreeDelivery;
}

export interface BagView {
  readonly groups: readonly StoreGroup[];
  readonly purchasableLineCount: number;
  readonly total: bigint;
  readonly isEmpty: boolean;
}

function freeDelivery(subtotal: bigint, threshold: bigint, plus: boolean, locked: boolean): FreeDelivery {
  const viaPlus = plus && !locked;
  const unlocked = viaPlus || (!locked && threshold > 0n && subtotal >= threshold) || (!locked && threshold === 0n);
  const remaining = unlocked || locked ? 0n : threshold - subtotal;
  const progressPct = unlocked ? 100 : threshold <= 0n ? 0 : Number((subtotal * 100n) / threshold);
  return { threshold, unlocked, viaPlus, remaining, progressPct: Math.max(0, Math.min(100, progressPct)) };
}

/**
 * Threshold applies to the merchandise subtotal after item-level discounts and before vouchers
 * and store credit (spec §6). Item prices here are already item-level discounted unit prices.
 * Unavailable, saved-for-later and suspended-store lines never count toward the subtotal.
 */
export function buildBag(snapshot: BagSnapshot): BagView {
  const groups: StoreGroup[] = [];
  for (const store of snapshot.stores) {
    const locked = store.status === "suspended";
    const mine = snapshot.lines.filter((l) => l.storeId === store.id);
    if (mine.length === 0) continue;
    const toView = (l: BagLine): LineView => ({
      line: l,
      total: lineTotal(l),
      change: priceChange(l),
      purchasable: !locked && l.availability === "available",
    });
    const active = mine.filter((l) => !l.savedForLater).map(toView);
    const saved = mine.filter((l) => l.savedForLater).map(toView);
    const subtotal = active.filter((v) => v.purchasable).reduce((s, v) => s + v.total, 0n);
    groups.push({
      store,
      locked,
      lines: active,
      saved,
      subtotal,
      freeDelivery: freeDelivery(subtotal, store.freeDeliveryThreshold, snapshot.isPlusMember, locked),
    });
  }
  const purchasableLineCount = groups.reduce((n, g) => n + g.lines.filter((v) => v.purchasable).length, 0);
  return {
    groups,
    purchasableLineCount,
    total: groups.reduce((s, g) => s + g.subtotal, 0n),
    isEmpty: groups.every((g) => g.lines.length === 0 && g.saved.length === 0),
  };
}

/**
 * Cheapest in-size items that close the gap first; if nothing closes it, the priciest
 * cheap-to-reach items that get nearest. Max 3. Deterministic.
 */
export function rankSuggestions(candidates: readonly Suggestion[], remaining: bigint, max = 3): readonly Suggestion[] {
  if (remaining <= 0n) return [];
  const cmp = (a: Suggestion, b: Suggestion) =>
    a.unitPrice < b.unitPrice ? -1 : a.unitPrice > b.unitPrice ? 1 : a.skuId.localeCompare(b.skuId);
  const closing = candidates.filter((c) => c.unitPrice >= remaining).sort(cmp);
  const rest = candidates.filter((c) => c.unitPrice < remaining).sort((a, b) => cmp(b, a));
  return [...closing, ...rest].slice(0, max);
}

export type BagScreenState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly offline: boolean }
  | { readonly status: "ready"; readonly snapshot: BagSnapshot };

export function bagFailureState(e: unknown): BagScreenState {
  return { status: "error", offline: e instanceof PortError && e.kind === "offline" };
}

export function applySaved(snapshot: BagSnapshot, lineId: string, saved: boolean): BagSnapshot {
  return { ...snapshot, lines: snapshot.lines.map((l) => (l.id === lineId ? { ...l, savedForLater: saved } : l)) };
}

/* ---- in-memory fakes (development and tests only; synthetic data) ---- */

export const FIXTURE_BAG: BagSnapshot = {
  isPlusMember: false,
  stores: [
    { id: "s1", name: "Cairo Denim", status: "active", freeDeliveryThreshold: DEFAULT_FREE_DELIVERY_THRESHOLD },
    { id: "s3", name: "Atlas Sport", status: "active", freeDeliveryThreshold: DEFAULT_FREE_DELIVERY_THRESHOLD },
    { id: "s4", name: "Delta Dresses", status: "suspended", freeDeliveryThreshold: DEFAULT_FREE_DELIVERY_THRESHOLD },
  ],
  lines: [
    { id: "l1", storeId: "s1", title: "Straight jeans", sizeLabel: "M", qty: 1, unitPrice: 119_000n, priceAtAdd: 129_000n, availability: "available", savedForLater: false },
    { id: "l2", storeId: "s1", title: "Denim jacket", sizeLabel: "M", qty: 1, unitPrice: 76_000n, priceAtAdd: 70_000n, availability: "available", savedForLater: false },
    { id: "l3", storeId: "s3", title: "Running shorts", sizeLabel: "L", qty: 1, unitPrice: 45_000n, priceAtAdd: 45_000n, availability: "soldOut", savedForLater: false },
    { id: "l4", storeId: "s4", title: "Linen dress", sizeLabel: "M", qty: 1, unitPrice: 90_000n, priceAtAdd: 90_000n, availability: "available", savedForLater: false },
    { id: "l5", storeId: "s3", title: "Sport socks", sizeLabel: null, qty: 2, unitPrice: 9_000n, priceAtAdd: 9_000n, availability: "available", savedForLater: true },
  ],
};

export const FIXTURE_SUGGESTIONS: readonly Suggestion[] = [
  { skuId: "x1", title: "Cotton belt", sizeLabel: "M", unitPrice: 15_000n },
  { skuId: "x2", title: "Graphic tee", sizeLabel: "M", unitPrice: 30_000n },
  { skuId: "x3", title: "Canvas cap", sizeLabel: "M", unitPrice: 8_000n },
];

export class InMemoryBagPort implements BagPort {
  private snapshot: BagSnapshot;
  constructor(initial: BagSnapshot = FIXTURE_BAG, private readonly suggestions: readonly Suggestion[] = FIXTURE_SUGGESTIONS, private failure: PortFailure | null = null) {
    this.snapshot = initial;
  }
  setFailure(f: PortFailure | null): void {
    this.failure = f;
  }
  private check(): void {
    if (this.failure !== null) throw new PortError(this.failure);
  }
  async load(): Promise<BagSnapshot> {
    this.check();
    return this.snapshot;
  }
  async inSizeSuggestions(): Promise<readonly Suggestion[]> {
    this.check();
    return this.suggestions;
  }
  async setSavedForLater(lineId: string, saved: boolean): Promise<void> {
    this.check();
    this.snapshot = applySaved(this.snapshot, lineId, saved);
  }
}
