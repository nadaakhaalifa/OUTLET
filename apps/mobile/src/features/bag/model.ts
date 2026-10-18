/** Multi-store bag (spec §6). Money is integer piastres (bigint). Pure model, ports and fakes. */
import { PortError, type PortFailure } from "../worlds/model";

declare const __DEV__: boolean | undefined;

export { PortError };
export type { PortFailure };

/** Default threshold from spec §6 (2,000 EGP). The real value always comes from store config. */
export const DEFAULT_FREE_DELIVERY_THRESHOLD = 200_000n;

/** Spec §6: max 10 units per SKU. */
export const MAX_UNITS_PER_SKU = 10;

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
  /** Optional brand label (eyebrow). Falls back to the store name when absent. */
  readonly brand?: string | undefined;
  /** Optional photo. A real URL always wins over any dev fixture image. */
  readonly imageUrl?: string | undefined;
  /** Guest bag: the live price read failed, so `unitPrice` is the last price this phone saw, at `seenAt` (epoch ms). */
  readonly priceStale?: boolean | undefined;
  readonly seenAt?: number | undefined;
  /** Optional server-verified claim (spec §9). Never computed on the client. */
  readonly claim?: LineClaim | undefined;
}

/** Verified reference price and whole percent as sent by the server. */
export interface LineClaim {
  readonly referencePrice: bigint;
  readonly percent: number;
  /** Dev fixture only: the board's own percent is shown as given (honoured in __DEV__ builds only). */
  readonly fixture?: true | undefined;
}

/** Fail closed: the claim only shows when it is internally consistent (reference above price, >= 5%, exact floor). */
export function claimOf(line: Pick<BagLine, "unitPrice" | "claim">): LineClaim | null {
  const c = line.claim;
  if (c === undefined || c.referencePrice <= line.unitPrice || c.percent < 5) return null;
  const pct = ((c.referencePrice - line.unitPrice) * 100n) / c.referencePrice;
  const devFixture = c.fixture === true && typeof __DEV__ !== "undefined" && __DEV__ === true;
  return pct === BigInt(c.percent) || devFixture ? c : null;
}

export interface BagSnapshot {
  readonly stores: readonly BagStore[];
  readonly lines: readonly BagLine[];
  readonly isPlusMember: boolean;
  /** Server-provided discount total (voucher or promo). Absent when the server sends none; the row then hides. */
  readonly discount?: bigint | undefined;
  /** Server-provided payable total after the discount. Absent: the merchandise total is shown. */
  readonly payable?: bigint | undefined;
  /** True when the lines come from this phone's guest store (nothing is held for the shopper, spec F2). */
  readonly guest?: boolean | undefined;
  /** Guest bag: the public price read failed (offline or down). Checkout is disabled until prices are live (E1). */
  readonly offline?: boolean | undefined;
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
  /** Sets the unit count (1..MAX_UNITS_PER_SKU). The server re-prices; the bag reloads after. */
  setQuantity(lineId: string, qty: number): Promise<void>;
  removeLine(lineId: string): Promise<void>;
  /** Adds one unit of a SKU. The real API prices server-side; the hint only feeds the in-memory fake. */
  addLine(skuId: string, hint: AddLineHint): Promise<void>;
  /**
   * Optional: apply a promo code and return the fresh snapshot. Only the in-memory dev fake implements it;
   * the production adapter leaves it undefined, so the promo field is hidden.
   */
  applyCode?(code: string): Promise<BagSnapshot>;
}

export interface AddLineHint {
  /** Guest bag only: the product the SKU belongs to and its photo. The server bag ignores both. */
  readonly productId?: string | undefined;
  readonly imageUrl?: string | undefined;
  readonly storeId: string;
  readonly storeName: string;
  readonly title: string;
  readonly sizeLabel: string | null;
  readonly unitPrice: bigint;
}

/** Spec E13: the guest bag holds 50 lines and 10 units of an item. Raised by the guest bag; the server enforces the same caps. */
export class BagCapError extends PortError {
  constructor(readonly cap: "lines" | "units") {
    super("failed");
    this.name = "BagCapError";
  }
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
  /** Server-provided discount, or null (row hidden). */
  readonly discount: bigint | null;
  /** Server-provided payable total, or the merchandise total when the server sent none. */
  readonly payable: bigint;
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
    discount: snapshot.discount ?? null,
    payable: snapshot.payable ?? groups.reduce((s, g) => s + g.subtotal, 0n),
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

export function applyQty(snapshot: BagSnapshot, lineId: string, qty: number): BagSnapshot {
  const q = Math.max(1, Math.min(MAX_UNITS_PER_SKU, Math.floor(qty)));
  return { ...snapshot, lines: snapshot.lines.map((l) => (l.id === lineId ? { ...l, qty: q } : l)) };
}

export function applyRemoved(snapshot: BagSnapshot, lineId: string): BagSnapshot {
  return { ...snapshot, lines: snapshot.lines.filter((l) => l.id !== lineId) };
}

/** Hint for adding a rail suggestion through the same port as the product page. */
export function suggestionHint(store: Pick<BagStore, "id" | "name">, s: Suggestion): AddLineHint {
  return { storeId: store.id, storeName: store.name, title: s.title, sizeLabel: s.sizeLabel, unitPrice: s.unitPrice };
}

/** Honest line headline: the change since the shopper added it, in piastres, or null when unchanged. */
export function changeHeadline(c: PriceChange): { readonly direction: "dropped" | "rose"; readonly delta: bigint } | null {
  return c.kind === "same" ? null : { direction: c.kind, delta: c.delta };
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

/** Dev-only snapshot that mirrors the design board (one store, three branded lines, a server-sent discount). */
export const BOARD_BAG: BagSnapshot = {
  isPlusMember: false,
  discount: 8_098n,
  payable: 7_999n,
  stores: [{ id: "b1", name: "Z-OUTLET", status: "active", freeDeliveryThreshold: 0n }],
  lines: [
    { id: "b-l1", storeId: "b1", brand: "ZARA", title: "Linen Blend Blazer", sizeLabel: "Beige · M", qty: 1, unitPrice: 4_999n, priceAtAdd: 4_999n, availability: "available", savedForLater: false, claim: { referencePrice: 9_999n, percent: 50 } },
    { id: "b-l2", storeId: "b1", brand: "MANGO", title: "Satin Dress", sizeLabel: "Black · S", qty: 1, unitPrice: 3_999n, priceAtAdd: 3_999n, availability: "available", savedForLater: false, claim: { referencePrice: 6_999n, percent: 40, fixture: true } },
    { id: "b-l3", storeId: "b1", brand: "BERSHKA", title: "Leather Jacket", sizeLabel: "Black · M", qty: 1, unitPrice: 6_999n, priceAtAdd: 6_999n, availability: "available", savedForLater: false, claim: { referencePrice: 9_999n, percent: 30, fixture: true } },
  ],
};

export const FIXTURE_SUGGESTIONS: readonly Suggestion[] = [
  { skuId: "x1", title: "Cotton belt", sizeLabel: "M", unitPrice: 15_000n },
  { skuId: "x2", title: "Graphic tee", sizeLabel: "M", unitPrice: 30_000n },
  { skuId: "x3", title: "Canvas cap", sizeLabel: "M", unitPrice: 8_000n },
];

export class InMemoryBagPort implements BagPort {
  private snapshot: BagSnapshot;
  constructor(
    initial: BagSnapshot = typeof __DEV__ !== "undefined" && __DEV__ === true ? BOARD_BAG : FIXTURE_BAG,
    private readonly suggestions: readonly Suggestion[] = initial === BOARD_BAG ? [] : FIXTURE_SUGGESTIONS,
    private failure: PortFailure | null = null,
  ) {
    this.snapshot = initial;
  }
  /** Dev fake only: the discount value comes from the fixture, never from client arithmetic. */
  async applyCode(code: string): Promise<BagSnapshot> {
    this.check();
    if (code.trim().length === 0) return this.snapshot;
    return this.snapshot;
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
  async setQuantity(lineId: string, qty: number): Promise<void> {
    this.check();
    this.snapshot = applyQty(this.snapshot, lineId, qty);
  }
  async removeLine(lineId: string): Promise<void> {
    this.check();
    this.snapshot = applyRemoved(this.snapshot, lineId);
  }
  async addLine(skuId: string, hint: AddLineHint): Promise<void> {
    this.check();
    const id = `sku-${skuId}`;
    const stores = this.snapshot.stores.some((s) => s.id === hint.storeId)
      ? this.snapshot.stores
      : [...this.snapshot.stores, { id: hint.storeId, name: hint.storeName, status: "active" as const, freeDeliveryThreshold: DEFAULT_FREE_DELIVERY_THRESHOLD }];
    const existing = this.snapshot.lines.find((l) => l.id === id);
    const lines = existing !== undefined
      ? this.snapshot.lines.map((l) => (l.id === id ? { ...l, qty: l.qty + 1, savedForLater: false } : l))
      : [...this.snapshot.lines, { id, storeId: hint.storeId, title: hint.title, sizeLabel: hint.sizeLabel, qty: 1, unitPrice: hint.unitPrice, priceAtAdd: hint.unitPrice, availability: "available" as const, savedForLater: false }];
    this.snapshot = { ...this.snapshot, stores, lines };
  }
}
