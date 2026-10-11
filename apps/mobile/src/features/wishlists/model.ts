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
  createShare(listId: string, expiresAtMs: number | null): Promise<ShareLink>;
  revokeShare(listId: string): Promise<void>;
  startCoolOff(listId: string, itemId: string, nowMs: number): Promise<void>;
  /** Save a product into the shopper's list for an intent (created on first use). Idempotent per (intent, product). */
  saveItem(productId: string, intent: WishlistIntent, hint: SaveItemHint): Promise<void>;
}

export interface SaveItemHint {
  readonly title: string;
  readonly price: bigint;
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
      { id: "i1", productId: "p1", title: "Straight jeans", addedPrice: 129_000n, currentPrice: 119_000n, status: "listed", note: null, coolOffStartedAtMs: null },
      { id: "i2", productId: "p9", title: "Wool scarf", addedPrice: 40_000n, currentPrice: null, status: "delisted", note: null, coolOffStartedAtMs: null },
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
  async createShare(listId: string, expiresAtMs: number | null): Promise<ShareLink> {
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
    const item: WishlistItem = { id: `i${this.seq++}`, productId, title: hint.title, addedPrice: hint.price, currentPrice: hint.price, status: "listed", note: null, coolOffStartedAtMs: null };
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
