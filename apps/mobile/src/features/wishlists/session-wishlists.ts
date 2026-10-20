/**
 * The Saved port every screen sees. Signed in: the server lists. Signed out: this phone's lists (ADR-0055).
 * The choice is made on each call, so signing in at the Checkout gate switches Saved with no screen change.
 */
import type { NewWishlistDraft, SaveItemHint, ShareLink, Wishlist, WishlistIntent, WishlistsPort } from "./model";

export class SessionWishlistsPort implements WishlistsPort {
  constructor(private readonly server: WishlistsPort, private readonly guest: WishlistsPort, private readonly signedIn: () => Promise<boolean>) {}
  private async pick(): Promise<WishlistsPort> { return (await this.signedIn()) ? this.server : this.guest; }

  async isGuest(): Promise<boolean> { return !(await this.signedIn()); }
  async list(): Promise<readonly Wishlist[]> { return (await this.pick()).list(); }
  async create(d: NewWishlistDraft): Promise<Wishlist> { return (await this.pick()).create(d); }
  async setCoolOff(listId: string, enabled: boolean): Promise<void> { return (await this.pick()).setCoolOff(listId, enabled); }
  async createShare(listId: string, expiresAtMs: number | null, hide?: boolean): Promise<ShareLink> { return (await this.pick()).createShare(listId, expiresAtMs, hide); }
  async revokeShare(listId: string): Promise<void> { return (await this.pick()).revokeShare(listId); }
  async startCoolOff(listId: string, itemId: string, nowMs: number): Promise<void> { return (await this.pick()).startCoolOff(listId, itemId, nowMs); }
  async removeItem(listId: string, itemId: string): Promise<void> { return (await this.pick()).removeItem(listId, itemId); }
  async addToBag(skuId: string): Promise<void> { return (await this.pick()).addToBag(skuId); }
  async bagProductIds(): Promise<readonly string[]> { return (await this.pick()).bagProductIds(); }
  async saveItem(productId: string, intent: WishlistIntent, hint: SaveItemHint): Promise<void> { return (await this.pick()).saveItem(productId, intent, hint); }
}
