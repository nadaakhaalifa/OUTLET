import type { CartRepository } from "../../cart";
import type { WishlistRepository } from "../../wishlists";

/** The only intents a guest can hold on the device (spec guest-browsing 2, F2). `later` maps to buy_later_this_month. */
export const GUEST_SAVED_INTENTS = ["need", "want", "treat", "later"] as const;
export type GuestSavedIntent = (typeof GUEST_SAVED_INTENTS)[number];

export interface GuestMergedEvent {
  readonly type: "cart.guest_merged";
  readonly userId: string;
  readonly cartId: string;
  /** Counts only. No SKU, product, price or device data. Consumers that derive analytics must check consent first. */
  readonly counts: {
    readonly added: number;
    readonly qtyRaised: number;
    readonly movedToSaved: number;
    readonly unavailable: number;
    readonly storeSuspended: number;
    readonly savedAdded: number;
  };
}

/** Everything inside one unit of work commits or rolls back together (cart write, wishlist writes, outbox row). */
export interface MergeTx {
  readonly cart: CartRepository;
  readonly wishlists: WishlistRepository;
  /** Appends the outbox row in the SAME transaction (Postgres). */
  emit(event: GuestMergedEvent): Promise<void>;
}

export interface GuestMergeUnitOfWork {
  /** `userId` serialises concurrent merges of one account (Postgres advisory lock). */
  run<T>(userId: string, fn: (tx: MergeTx) => Promise<T>): Promise<T>;
}

/** A concurrent writer won (cart version moved, or a unique key was taken). The unit of work was rolled back. */
export class MergeConflictError extends Error {
  constructor() {
    super("guest merge lost a race");
    this.name = "MergeConflictError";
  }
}

export class GuestCatalogUnavailableError extends Error {
  constructor() {
    super("catalog unavailable");
    this.name = "GuestCatalogUnavailableError";
  }
}

/** The `personalization` purpose, read at the moment of the merge. Fails closed. */
export interface PersonalizationConsentReader {
  isGranted(userId: string): Promise<boolean>;
}

/** Writes recently viewed entries for the account (history module). Server time and server price; the device's are ignored. */
export interface RecentlyViewedWriter {
  record(userId: string, productIds: readonly string[]): Promise<void>;
}
