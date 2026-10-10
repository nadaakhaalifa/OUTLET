import type { Resource } from "@outlet/policy";
import type {
  CatalogProduct,
  CatalogReadPort,
  OwnerProfilePort,
  WishlistEvent,
  WishlistEventPublisher,
  WishlistRepository,
} from "../domain/ports";
import type { Wishlist, WishlistItem } from "../domain/types";

/** DEVELOPMENT FIXTURE. Not shared between processes; the production adapter is Postgres + outbox. */
export class InMemoryWishlistRepository implements WishlistRepository {
  private readonly lists = new Map<string, Wishlist>();
  private readonly itemsById = new Map<string, WishlistItem>();
  private readonly dedupe = new Map<string, string>();

  async countByUser(userId: string): Promise<number> {
    return [...this.lists.values()].filter((l) => l.userId === userId).length;
  }

  async insert(list: Wishlist): Promise<void> {
    this.lists.set(list.id, list);
  }

  async get(id: string): Promise<Wishlist | null> {
    return this.lists.get(id) ?? null;
  }

  async save(list: Wishlist): Promise<void> {
    if (this.lists.has(list.id)) this.lists.set(list.id, list);
  }

  async delete(id: string): Promise<void> {
    this.lists.delete(id);
    for (const [k, i] of this.itemsById) if (i.wishlistId === id) this.itemsById.delete(k);
    for (const [k, w] of this.dedupe) if (w === id) this.dedupe.delete(k);
  }

  async listByUser(
    userId: string,
    page: { after: { createdAtMs: number; id: string } | null; limit: number },
  ): Promise<readonly Wishlist[]> {
    const sorted = [...this.lists.values()]
      .filter((l) => l.userId === userId)
      .sort((a, b) => (b.createdAtMs - a.createdAtMs !== 0 ? b.createdAtMs - a.createdAtMs : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const after = page.after;
    const rest =
      after === null
        ? sorted
        : sorted.filter((l) => l.createdAtMs < after.createdAtMs || (l.createdAtMs === after.createdAtMs && l.id < after.id));
    return rest.slice(0, page.limit);
  }

  async findByShareHash(tokenHash: string): Promise<Wishlist | null> {
    for (const l of this.lists.values()) if (l.share?.tokenHash === tokenHash) return l;
    return null;
  }

  async listWithDates(): Promise<readonly Wishlist[]> {
    return [...this.lists.values()].filter((l) => l.targetDate !== null || (l.giftFor?.date ?? null) !== null);
  }

  async items(wishlistId: string): Promise<readonly WishlistItem[]> {
    return [...this.itemsById.values()]
      .filter((i) => i.wishlistId === wishlistId)
      .sort((a, b) => a.addedAtMs - b.addedAtMs || (a.id < b.id ? -1 : 1));
  }

  async itemCount(wishlistId: string): Promise<number> {
    return (await this.items(wishlistId)).length;
  }

  async insertItem(item: WishlistItem): Promise<void> {
    this.itemsById.set(item.id, item);
  }

  async deleteItem(wishlistId: string, itemId: string): Promise<boolean> {
    const i = this.itemsById.get(itemId);
    if (i === undefined || i.wishlistId !== wishlistId) return false;
    return this.itemsById.delete(itemId);
  }

  async clearCoolOff(wishlistId: string): Promise<void> {
    for (const [k, i] of this.itemsById) {
      if (i.wishlistId === wishlistId && i.coolOffUntilMs !== null) this.itemsById.set(k, { ...i, coolOffUntilMs: null });
    }
  }

  async itemsByProduct(productId: string): Promise<readonly WishlistItem[]> {
    return [...this.itemsById.values()].filter((i) => i.productId === productId);
  }

  async claimAlert(dedupeKey: string, wishlistId: string): Promise<boolean> {
    if (this.dedupe.has(dedupeKey)) return false;
    this.dedupe.set(dedupeKey, wishlistId);
    return true;
  }
}

/** DEVELOPMENT FIXTURE. Synthetic catalog seeded by tests; empty by default. */
export class InMemoryCatalogRead implements CatalogReadPort {
  private readonly byId = new Map<string, CatalogProduct>();
  /** Test switch: simulates a catalog outage. */
  failing = false;

  seed(product: CatalogProduct): void {
    this.byId.set(product.id, product);
  }

  async products(ids: readonly string[]): Promise<ReadonlyMap<string, CatalogProduct>> {
    if (this.failing) throw new Error("catalog unavailable");
    const out = new Map<string, CatalogProduct>();
    for (const id of ids) {
      const p = this.byId.get(id);
      if (p !== undefined) out.set(id, p);
    }
    return out;
  }
}

export class InMemoryOwnerProfiles implements OwnerProfilePort {
  private readonly names = new Map<string, string>();
  set(userId: string, nickname: string): void {
    this.names.set(userId, nickname);
  }
  async nickname(userId: string): Promise<string | null> {
    return this.names.get(userId) ?? null;
  }
}

export class InMemoryWishlistEventLog implements WishlistEventPublisher {
  readonly events: WishlistEvent[] = [];
  async publish(event: WishlistEvent): Promise<void> {
    this.events.push(event);
  }
}

export class WishlistResourceResolver {
  constructor(private readonly repo: WishlistRepository) {}

  async resolve(input: { id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || input.id.length > 64) return null;
    const l = await this.repo.get(input.id);
    if (l === null) return null;
    return { type: "wishlist", id: l.id, ownerUserId: l.userId, state: "active" };
  }
}
