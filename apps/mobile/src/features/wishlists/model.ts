/** Wishlists with intent (spec §8). Pure model, port and in-memory fake; no UI imports. */
import { PortError, type PortFailure } from "../worlds/model";

export { PortError };
export type { PortFailure };

export type WishlistIntent = "need" | "want" | "treat" | "laterThisMonth" | "birthday" | "eidRamadan" | "gift" | "custom";
export const WISHLIST_INTENTS: readonly WishlistIntent[] = ["need", "want", "treat", "laterThisMonth", "birthday", "eidRamadan", "gift", "custom"];

/** Birthday and gift lists are the shareable ones (spec §8). Any list may still be shared by the owner. */
export const COOL_OFF_MS = 24 * 60 * 60 * 1000;

export interface WishlistItem {
  readonly id: string;
  readonly productId: string;
  readonly title: string;
  /** Price when it was saved, and current price. Both are shown as plain numbers, never as a discount. */
  readonly addedPrice: bigint;
  readonly currentPrice: bigint | null;
  /** Delisted items stay as ghost entries with "find similar". */
  readonly status: "listed" | "delisted";
  readonly note: string | null;
  /** Store name from the product summary; null when the server sent no product. */
  readonly storeName: string | null;
  readonly storeVerified: boolean;
  /** Preferred size SKU; null opens the product page size selector instead of adding straight to the bag. */
  readonly skuPref: string | null;
  /** Epoch ms when the shopper first asked to buy during cool-off; null when never. */
  readonly coolOffStartedAtMs: number | null;
}

export interface ShareLink {
  readonly url: string;
  readonly expiresAtMs: number | null;
}

export interface Wishlist {
  readonly id: string;
  readonly intent: WishlistIntent;
  readonly title: string;
  readonly targetDate: string | null;
  readonly budget: bigint | null;
  readonly recipientNickname: string | null;
  readonly occasion: string | null;
  /** Optional 24h cool-off on Want lists: Buy becomes Remind me tomorrow. */
  readonly coolOffEnabled: boolean;
  readonly share: ShareLink | null;
  readonly items: readonly WishlistItem[];
}

export interface NewWishlistDraft {
  readonly intent: WishlistIntent;
  readonly title: string;
  readonly targetDate: string | null;
  readonly budget: bigint | null;
  readonly recipientNickname: string | null;
  readonly occasion: string | null;
}

export interface WishlistsPort {
  list(): Promise<readonly Wishlist[]>;
  create(draft: NewWishlistDraft): Promise<Wishlist>;
  setCoolOff(listId: string, enabled: boolean): Promise<void>;
  /** Creates (or replaces) the unguessable share link. */
  createShare(listId: string, expiresAtMs: number | null, hidePricesFromOwner?: boolean): Promise<ShareLink>;
  revokeShare(listId: string): Promise<void>;
  startCoolOff(listId: string, itemId: string, nowMs: number): Promise<void>;
  removeItem(listId: string, itemId: string): Promise<void>;
  /** Adds one unit of a size SKU to the bag (source "wishlist"). */
  addToBag(skuId: string): Promise<void>;
  /** Product ids currently in the bag (GET /v1/cart). */
  bagProductIds(): Promise<readonly string[]>;
  /** Save a product into the shopper's list for an intent (created on first use). Idempotent per (intent, product). */
  saveItem(productId: string, intent: WishlistIntent, hint: SaveItemHint): Promise<void>;
  /**
   * True when this port serves a signed-out shopper from the phone (ADR-0055). The screen then hides new lists and sharing
   * (they need an account) and shows a plain "kept on this phone" note, never a sign-up prompt. Absent = signed in.
   */
  isGuest?(): Promise<boolean>;
}

export interface SaveItemHint {
  readonly title: string;
  readonly price: bigint;
  /** Selected size SKU, when one was chosen: lets Saved add the item to the bag directly. */
  readonly skuId?: string;
}

export type DraftError = "titleRequired" | "titleTooLong" | "nicknameRequired" | "occasionRequired" | "budgetInvalid" | "dateInvalid";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateDraft(d: NewWishlistDraft): readonly DraftError[] {
  const errors: DraftError[] = [];
  const title = d.title.trim();
  if (title.length === 0) errors.push("titleRequired");
  if (title.length > 60) errors.push("titleTooLong");
  if (d.intent === "gift") {
    if ((d.recipientNickname ?? "").trim().length === 0) errors.push("nicknameRequired");
    if ((d.occasion ?? "").trim().length === 0) errors.push("occasionRequired");
  }
  if (d.budget !== null && d.budget <= 0n) errors.push("budgetInvalid");
  if (d.targetDate !== null) {
    const ok = ISO_DATE.test(d.targetDate) && !Number.isNaN(Date.parse(`${d.targetDate}T00:00:00Z`));
    if (!ok) errors.push("dateInvalid");
  }
  return errors;
}

export type BuyAction =
  | { readonly kind: "buy" }
  | { readonly kind: "remindTomorrow" }
  | { readonly kind: "waiting"; readonly remainingMs: number }
  | { readonly kind: "unavailable" };

/**
 * Cool-off applies only to Want lists that opted in. The first press starts a real 24h window
 * (stored server-side); once it has elapsed Buy is available. No countdown is invented.
 */
export function buyAction(list: Pick<Wishlist, "intent" | "coolOffEnabled">, item: WishlistItem, nowMs: number): BuyAction {
  if (item.status === "delisted") return { kind: "unavailable" };
  if (list.intent !== "want" || !list.coolOffEnabled) return { kind: "buy" };
  if (item.coolOffStartedAtMs === null) return { kind: "remindTomorrow" };
  const elapsed = nowMs - item.coolOffStartedAtMs;
  return elapsed >= COOL_OFF_MS ? { kind: "buy" } : { kind: "waiting", remainingMs: COOL_OFF_MS - elapsed };
}

export interface ItemView {
  readonly item: WishlistItem;
  readonly action: BuyAction;
  readonly priceMoved: "same" | "lower" | "higher" | "unknown";
}

export interface ListView {
  readonly list: Wishlist;
  readonly items: readonly ItemView[];
  readonly total: bigint;
  /** Budget minus total of listed items; negative means over budget. Null with no budget. */
  readonly budgetLeft: bigint | null;
  readonly shareActive: boolean;
  readonly canCoolOff: boolean;
}

export function buildList(list: Wishlist, nowMs: number): ListView {
  const items: ItemView[] = list.items.map((item) => {
    const cur = item.currentPrice;
    const priceMoved = item.status === "delisted" || cur === null ? "unknown" : cur === item.addedPrice ? "same" : cur < item.addedPrice ? "lower" : "higher";
    return { item, action: buyAction(list, item, nowMs), priceMoved };
  });
  const total = list.items.filter((i) => i.status === "listed").reduce((s, i) => s + (i.currentPrice ?? i.addedPrice), 0n);
  const shareActive = list.share !== null && (list.share.expiresAtMs === null || list.share.expiresAtMs > nowMs);
  return {
    list,
    items,
    total,
    budgetLeft: list.budget === null ? null : list.budget - total,
    shareActive,
    canCoolOff: list.intent === "want",
  };
}

export type WishlistsScreenState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly offline: boolean }
  | { readonly status: "ready"; readonly lists: readonly Wishlist[] };

export function wishlistsFailureState(e: unknown): WishlistsScreenState {
  return { status: "error", offline: e instanceof PortError && e.kind === "offline" };
}

export function replaceList(lists: readonly Wishlist[], next: Wishlist): readonly Wishlist[] {
  return lists.map((l) => (l.id === next.id ? next : l));
}

/* ---- in-memory fakes (development and tests only; synthetic data) ---- */

export const FIXTURE_WISHLISTS: readonly Wishlist[] = [
  {
    id: "w1", intent: "want", title: "Autumn wardrobe", targetDate: null, budget: 300_000n, recipientNickname: null, occasion: null,
    coolOffEnabled: true, share: null,
    items: [
      { id: "i1", productId: "p1", title: "Straight jeans", addedPrice: 129_000n, currentPrice: 119_000n, status: "listed", note: null, storeName: "Nile Denim", storeVerified: true, skuPref: "sku1", coolOffStartedAtMs: null },
      { id: "i2", productId: "p9", title: "Wool scarf", addedPrice: 40_000n, currentPrice: null, status: "delisted", note: null, storeName: "Cairo Loom", storeVerified: false, skuPref: null, coolOffStartedAtMs: null },
    ],
  },
  {
    id: "w2", intent: "gift", title: "For Mona", targetDate: "2026-12-01", budget: null, recipientNickname: "Mona", occasion: "Birthday",
    coolOffEnabled: false, share: { url: "https://example.invalid/shared/wishlists/TOKEN", expiresAtMs: null },
    items: [],
  },
];

export class InMemoryWishlistsPort implements WishlistsPort {
  private lists: Wishlist[];
  private seq = 100;
  constructor(initial: readonly Wishlist[] = FIXTURE_WISHLISTS, private failure: PortFailure | null = null) {
    this.lists = [...initial];
  }
  setFailure(f: PortFailure | null): void {
    this.failure = f;
  }
  private check(): void {
    if (this.failure !== null) throw new PortError(this.failure);
  }
  private patch(id: string, f: (l: Wishlist) => Wishlist): void {
    this.lists = this.lists.map((l) => (l.id === id ? f(l) : l));
  }
  async list(): Promise<readonly Wishlist[]> {
    this.check();
    return this.lists;
  }
  async create(d: NewWishlistDraft): Promise<Wishlist> {
    this.check();
    const created: Wishlist = { ...d, id: `w${this.seq++}`, title: d.title.trim(), coolOffEnabled: false, share: null, items: [] };
    this.lists = [...this.lists, created];
    return created;
  }
  async setCoolOff(listId: string, enabled: boolean): Promise<void> {
    this.check();
    this.patch(listId, (l) => ({ ...l, coolOffEnabled: enabled }));
  }
  readonly removed: string[] = [];
  readonly bagged: string[] = [];
  bag: string[] = [];
  async removeItem(listId: string, itemId: string): Promise<void> {
    this.check();
    this.removed.push(itemId);
    this.patch(listId, (l) => ({ ...l, items: l.items.filter((i) => i.id !== itemId) }));
  }
  async addToBag(skuId: string): Promise<void> {
    this.check();
    this.bagged.push(skuId);
  }
  async bagProductIds(): Promise<readonly string[]> {
    this.check();
    return this.bag;
  }
  async createShare(listId: string, expiresAtMs: number | null, _hidePrices = false): Promise<ShareLink> {
    this.check();
    const share: ShareLink = { url: `https://example.invalid/shared/wishlists/T${this.seq++}`, expiresAtMs };
    this.patch(listId, (l) => ({ ...l, share }));
    return share;
  }
  async saveItem(productId: string, intent: WishlistIntent, hint: SaveItemHint): Promise<void> {
    this.check();
    let list = this.lists.find((l) => l.intent === intent);
    if (list === undefined) {
      list = { id: `w${this.seq++}`, intent, title: intent, targetDate: null, budget: null, recipientNickname: null, occasion: null, coolOffEnabled: false, share: null, items: [] };
      this.lists = [...this.lists, list];
    }
    if (list.items.some((i) => i.productId === productId)) return;
    const item: WishlistItem = { id: `i${this.seq++}`, productId, title: hint.title, addedPrice: hint.price, currentPrice: hint.price, status: "listed", note: null, storeName: null, storeVerified: false, skuPref: null, coolOffStartedAtMs: null };
    this.patch(list.id, (l) => ({ ...l, items: [...l.items, item] }));
  }
  async revokeShare(listId: string): Promise<void> {
    this.check();
    this.patch(listId, (l) => ({ ...l, share: null }));
  }
  async startCoolOff(listId: string, itemId: string, nowMs: number): Promise<void> {
    this.check();
    this.patch(listId, (l) => ({ ...l, items: l.items.map((i) => (i.id === itemId && i.coolOffStartedAtMs === null ? { ...i, coolOffStartedAtMs: nowMs } : i)) }));
  }
}

/** Whole hours left in a real cool-off window, rounded up so "1 hour" never shows as "0". */
export function coolOffHoursLeft(remainingMs: number): number {
  return Math.max(1, Math.ceil(remainingMs / 3_600_000));
}

/* ---- Saved tab view model (round-2 item 9) ---- */

/** Real window for the Undo snackbar before the DELETE is sent. */
export const UNDO_MS = 5_000;

export type SavedSort = "newest" | "priceLow" | "priceHigh" | "priceChanged";
export const SAVED_SORTS: readonly SavedSort[] = ["newest", "priceLow", "priceHigh", "priceChanged"];

export type SavedBadge = "unavailable" | "inBag" | null;
export type SavedAction =
  | { readonly kind: "addToBag" }
  | { readonly kind: "remindTomorrow" }
  | { readonly kind: "waiting"; readonly hours: number }
  | { readonly kind: "findSimilar" }
  | { readonly kind: "viewBag" };

export interface SavedRowView {
  readonly item: WishlistItem;
  readonly badge: SavedBadge;
  /** 50% art opacity for delisted items. */
  readonly dimmed: boolean;
  /** Price shown; null when the item is no longer available (price hidden). */
  readonly price: bigint | null;
  /** "Was X when saved, now Y" only when both are real and differ; never a percentage. */
  readonly priceLine: { readonly was: bigint; readonly now: bigint; readonly lower: boolean } | null;
  readonly action: SavedAction;
}

export function savedRow(list: Pick<Wishlist, "intent" | "coolOffEnabled">, item: WishlistItem, nowMs: number, inBag: boolean): SavedRowView {
  if (item.status === "delisted") {
    return { item, badge: "unavailable", dimmed: true, price: null, priceLine: null, action: { kind: "findSimilar" } };
  }
  const now = item.currentPrice ?? item.addedPrice;
  const priceLine = item.currentPrice !== null && item.currentPrice !== item.addedPrice
    ? { was: item.addedPrice, now: item.currentPrice, lower: item.currentPrice < item.addedPrice }
    : null;
  const base = { item, dimmed: false, price: now, priceLine };
  if (inBag) return { ...base, badge: "inBag", action: { kind: "viewBag" } };
  const a = buyAction(list, item, nowMs);
  switch (a.kind) {
    case "buy": return { ...base, badge: null, action: { kind: "addToBag" } };
    case "remindTomorrow": return { ...base, badge: null, action: { kind: "remindTomorrow" } };
    case "waiting": return { ...base, badge: null, action: { kind: "waiting", hours: coolOffHoursLeft(a.remainingMs) } };
    case "unavailable": return { ...base, badge: "unavailable", action: { kind: "findSimilar" } };
  }
}

const priceOf = (i: WishlistItem): bigint => i.currentPrice ?? i.addedPrice;
const deltaOf = (i: WishlistItem): bigint => {
  if (i.status === "delisted" || i.currentPrice === null) return 0n;
  const d = i.currentPrice - i.addedPrice;
  return d < 0n ? -d : d;
};

/** Stable sort. "newest" keeps the server order (newest saved first); unavailable items always sink to the end. */
export function sortItems(items: readonly WishlistItem[], sort: SavedSort): readonly WishlistItem[] {
  const indexed = items.map((item, index) => ({ item, index }));
  const cmp = (a: { item: WishlistItem; index: number }, b: { item: WishlistItem; index: number }): number => {
    const ua = a.item.status === "delisted" ? 1 : 0;
    const ub = b.item.status === "delisted" ? 1 : 0;
    if (ua !== ub) return ua - ub;
    let d = 0n;
    if (sort === "priceLow") d = priceOf(a.item) - priceOf(b.item);
    else if (sort === "priceHigh") d = priceOf(b.item) - priceOf(a.item);
    else if (sort === "priceChanged") d = deltaOf(b.item) - deltaOf(a.item);
    return d !== 0n ? (d < 0n ? -1 : 1) : a.index - b.index;
  };
  return indexed.sort(cmp).map((x) => x.item);
}

export interface SavedFilter {
  readonly stores: readonly string[];
  readonly availableOnly: boolean;
  /** List budget (not the monthly budget): keeps items whose price fits in it. */
  readonly inBudget: boolean;
}
export const EMPTY_SAVED_FILTER: SavedFilter = { stores: [], availableOnly: false, inBudget: false };

export function savedFilterCount(f: SavedFilter): number {
  return (f.stores.length > 0 ? 1 : 0) + (f.availableOnly ? 1 : 0) + (f.inBudget ? 1 : 0);
}

export function filterItems(items: readonly WishlistItem[], f: SavedFilter, budget: bigint | null): readonly WishlistItem[] {
  return items.filter((i) => {
    if (f.stores.length > 0 && (i.storeName === null || !f.stores.includes(i.storeName))) return false;
    if (f.availableOnly && i.status === "delisted") return false;
    if (f.inBudget && budget !== null && (i.status === "delisted" || priceOf(i) > budget)) return false;
    return true;
  });
}

export function storeNamesOf(items: readonly WishlistItem[]): readonly string[] {
  return [...new Set(items.flatMap((i) => (i.storeName !== null ? [i.storeName] : [])))].sort((a, b) => a.localeCompare(b));
}

/** Gift and birthday lists are the shareable ones (spec section 8). */
export function canShare(list: Pick<Wishlist, "intent">): boolean {
  return list.intent === "gift" || list.intent === "birthday";
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const REAL_TIMERS: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/** Deferred removal: the row is hidden at once, the DELETE is sent once after `delay` unless undone. */
export class UndoTracker {
  private readonly pending = new Map<string, unknown>();
  private readonly commits = new Map<string, () => void>();
  constructor(private readonly delay: number = UNDO_MS, private readonly timers: Timers = REAL_TIMERS) {}
  has(key: string): boolean { return this.pending.has(key); }
  keys(): readonly string[] { return [...this.pending.keys()]; }
  schedule(key: string, commit: () => void): void {
    if (this.pending.has(key)) return;
    this.commits.set(key, commit);
    this.pending.set(key, this.timers.set(() => this.fire(key), this.delay));
  }
  /** True when the removal was still pending (and is now cancelled, with no API call). */
  undo(key: string): boolean {
    const h = this.pending.get(key);
    if (h === undefined) return false;
    this.timers.clear(h);
    this.pending.delete(key);
    this.commits.delete(key);
    return true;
  }
  /** Sends every pending removal now (leaving the screen must not drop a delete the shopper did not undo). */
  flush(): void {
    for (const key of this.keys()) {
      const h = this.pending.get(key);
      if (h !== undefined) this.timers.clear(h);
      this.fire(key);
    }
  }
  private fire(key: string): void {
    const commit = this.commits.get(key);
    this.pending.delete(key);
    this.commits.delete(key);
    commit?.();
  }
}

export function subtitleCounts(lists: readonly Wishlist[]): { items: number; lists: number } {
  return { items: lists.reduce((n, l) => n + l.items.length, 0), lists: lists.length };
}
