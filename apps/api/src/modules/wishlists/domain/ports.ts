import type { PlannedAlert } from "./alerts";
import type { Money, ShareLink, Wishlist, WishlistItem } from "./types";

export interface Clock {
  nowMs(): number;
}

export interface IdPort {
  uuidV7(): string;
}

/** Source of random bytes for share tokens (CSPRNG in production). */
export interface TokenEntropy {
  randomBytes(length: number): Uint8Array;
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Opaque catalog summary, passed through to the wire unchanged (ProductSummary). */
export interface ProductSummaryView {
  readonly id: string;
  readonly [key: string]: JsonValue;
}

export interface CatalogProduct {
  readonly id: string;
  /** False when the product is delisted, paused or its store is suspended. */
  readonly listed: boolean;
  readonly currentPrice: Money | null;
  readonly skuIds: readonly string[];
  readonly summary: ProductSummaryView;
}

/** Read side of the catalog. A missing id is simply absent from the map. */
export interface CatalogReadPort {
  products(ids: readonly string[]): Promise<ReadonlyMap<string, CatalogProduct>>;
}

export interface OwnerProfilePort {
  /** Public nickname of the owner, or null when none is set. Never a legal name. */
  nickname(userId: string): Promise<string | null>;
}

/**
 * Port only. The users module issues an opaque token that resolves to the owner's hidden
 * delivery address inside checkout. The buyer receives the token, never the address.
 */
export interface GiftAddressTokenPort {
  issue(input: { readonly ownerUserId: string; readonly wishlistId: string }): Promise<{ readonly token: string }>;
}

export interface WishlistRepository {
  countByUser(userId: string): Promise<number>;
  insert(list: Wishlist): Promise<void>;
  get(id: string): Promise<Wishlist | null>;
  /**
   * `events` are appended to the outbox in the SAME transaction as the write (Postgres) so state
   * and event commit or roll back together.
   */
  save(list: Wishlist, events?: readonly WishlistEvent[]): Promise<void>;
  /** Removes the list, its items and its alert dedupe rows. */
  delete(id: string): Promise<void>;
  listByUser(userId: string, page: { readonly after: { readonly createdAtMs: number; readonly id: string } | null; readonly limit: number }): Promise<readonly Wishlist[]>;
  findByShareHash(tokenHash: string): Promise<Wishlist | null>;
  listWithDates(): Promise<readonly Wishlist[]>;

  items(wishlistId: string): Promise<readonly WishlistItem[]>;
  itemCount(wishlistId: string): Promise<number>;
  insertItem(item: WishlistItem): Promise<void>;
  deleteItem(wishlistId: string, itemId: string): Promise<boolean>;
  clearCoolOff(wishlistId: string): Promise<void>;
  itemsByProduct(productId: string): Promise<readonly WishlistItem[]>;

  /** Claims a dedupe key and appends `events` in the same transaction. True only for the first claim (events are written only then). */
  claimAlert(dedupeKey: string, wishlistId: string, events?: readonly WishlistEvent[]): Promise<boolean>;
}

export type WishlistEvent =
  | { readonly type: "wishlist.shared"; readonly wishlistId: string; readonly userId: string; readonly expiresAtMs: number | null; readonly hidePrices: boolean }
  | { readonly type: "wishlist.share_revoked"; readonly wishlistId: string; readonly userId: string }
  | { readonly type: "wishlist.alert_due"; readonly alert: PlannedAlert };

/** In-memory sink only. Postgres writes the outbox row inside the repository transaction (save/claimAlert). */
export interface WishlistEventPublisher {
  publish(event: WishlistEvent): Promise<void>;
}

export type { ShareLink };
