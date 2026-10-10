import {
  applyUpdate,
  coolOffUntil,
  createWishlist,
  itemKey,
  validateNote,
  type NewWishlistInput,
  type WishlistPatch,
} from "../domain/wishlist";
import { LIMITS, type Wishlist, type WishlistItem, type WishlistRuleViolation } from "../domain/types";
import type { CatalogReadPort, Clock, IdPort, WishlistRepository } from "../domain/ports";
import { itemView, readCatalog, viewOf, type ItemView, type WishlistDetailView, type WishlistView } from "./read-model";

export type NotFound = { readonly kind: "not_found" };
const NOT_FOUND: NotFound = { kind: "not_found" };

async function owned(repo: WishlistRepository, userId: string, id: string): Promise<Wishlist | null> {
  const list = await repo.get(id);
  // Defence in depth: the policy guard already answered 404 for foreign ids.
  return list !== null && list.userId === userId ? list : null;
}

export class CreateWishlist {
  constructor(
    private readonly repo: WishlistRepository,
    private readonly clock: Clock,
    private readonly ids: IdPort,
  ) {}

  async execute(
    userId: string,
    input: NewWishlistInput,
  ): Promise<
    | { readonly kind: "created"; readonly view: WishlistView }
    | { readonly kind: "rule"; readonly violation: WishlistRuleViolation }
    | { readonly kind: "limit_reached" }
  > {
    if ((await this.repo.countByUser(userId)) >= LIMITS.maxWishlistsPerUser) return { kind: "limit_reached" };
    const nowMs = this.clock.nowMs();
    const r = createWishlist(input, { id: this.ids.uuidV7(), userId, nowMs });
    if (!r.ok) return { kind: "rule", violation: r.error };
    await this.repo.insert(r.value);
    return { kind: "created", view: viewOf(r.value, 0, nowMs) };
  }
}

const CURSOR_RE = /^[A-Za-z0-9_-]{1,512}$/;

export function encodeCursor(c: { createdAtMs: number; id: string }): string {
  return Buffer.from(JSON.stringify([c.createdAtMs, c.id]), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): { createdAtMs: number; id: string } | null {
  if (!CURSOR_RE.test(raw)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [t, id] = parsed as unknown[];
    if (typeof t !== "number" || !Number.isSafeInteger(t) || typeof id !== "string" || id.length === 0 || id.length > 64) return null;
    return { createdAtMs: t, id };
  } catch {
    return null;
  }
}

export class ListWishlists {
  constructor(
    private readonly repo: WishlistRepository,
    private readonly clock: Clock,
  ) {}

  async execute(
    userId: string,
    page: { readonly cursor: string | undefined; readonly limit: number },
  ): Promise<
    | { readonly kind: "page"; readonly items: readonly WishlistView[]; readonly nextCursor: string | null }
    | { readonly kind: "invalid_cursor" }
  > {
    let after: { createdAtMs: number; id: string } | null = null;
    if (page.cursor !== undefined) {
      after = decodeCursor(page.cursor);
      if (after === null) return { kind: "invalid_cursor" };
    }
    const rows = await this.repo.listByUser(userId, { after, limit: page.limit + 1 });
    const hasMore = rows.length > page.limit;
    const slice = rows.slice(0, page.limit);
    const nowMs = this.clock.nowMs();
    const items: WishlistView[] = [];
    for (const l of slice) items.push(viewOf(l, await this.repo.itemCount(l.id), nowMs));
    const last = slice[slice.length - 1];
    return {
      kind: "page",
      items,
      nextCursor: hasMore && last !== undefined ? encodeCursor({ createdAtMs: last.createdAtMs, id: last.id }) : null,
    };
  }
}

/** Builds the detail read model (shared by GET, PATCH and the ETag computation). */
export class WishlistDetails {
  constructor(
    private readonly repo: WishlistRepository,
    private readonly catalog: CatalogReadPort,
    private readonly clock: Clock,
  ) {}

  async forOwner(userId: string, wishlistId: string): Promise<WishlistDetailView | NotFound> {
    const list = await owned(this.repo, userId, wishlistId);
    if (list === null) return NOT_FOUND;
    return this.build(list);
  }

  async build(list: Wishlist): Promise<WishlistDetailView> {
    const nowMs = this.clock.nowMs();
    const items = await this.repo.items(list.id);
    const catalog = await readCatalog(this.catalog, items.map((i) => i.productId));
    const views: ItemView[] = items.map((i) => itemView(i, catalog, nowMs));
    return { ...viewOf(list, items.length, nowMs), items: views };
  }
}

export class UpdateWishlist {
  constructor(
    private readonly repo: WishlistRepository,
    private readonly details: WishlistDetails,
    private readonly clock: Clock,
  ) {}

  async execute(
    userId: string,
    wishlistId: string,
    patch: WishlistPatch,
    /** Called with the current detail before any change; returning false aborts (If-Match). */
    precondition: (current: WishlistDetailView) => boolean,
  ): Promise<
    | { readonly kind: "updated"; readonly view: WishlistDetailView }
    | NotFound
    | { readonly kind: "precondition_failed" }
    | { readonly kind: "rule"; readonly violation: WishlistRuleViolation }
  > {
    const list = await owned(this.repo, userId, wishlistId);
    if (list === null) return NOT_FOUND;
    const current = await this.details.build(list);
    if (!precondition(current)) return { kind: "precondition_failed" };
    const r = applyUpdate(list, patch, this.clock.nowMs());
    if (!r.ok) return { kind: "rule", violation: r.error };
    await this.repo.save(r.value.wishlist);
    if (r.value.clearCoolOffTimers) await this.repo.clearCoolOff(list.id);
    return { kind: "updated", view: await this.details.build(r.value.wishlist) };
  }
}

export class DeleteWishlist {
  constructor(private readonly repo: WishlistRepository) {}

  async execute(userId: string, wishlistId: string): Promise<{ readonly kind: "deleted" } | NotFound> {
    const list = await owned(this.repo, userId, wishlistId);
    if (list === null) return NOT_FOUND;
    await this.repo.delete(list.id);
    return { kind: "deleted" };
  }
}

export type AddItemFailure =
  | "product_unavailable"
  | "sku_not_in_product"
  | "duplicate_item"
  | "item_limit_reached"
  | "note_invalid"
  | "catalog_unavailable";

export class AddWishlistItem {
  constructor(
    private readonly repo: WishlistRepository,
    private readonly catalog: CatalogReadPort,
    private readonly clock: Clock,
    private readonly ids: IdPort,
  ) {}

  async execute(
    userId: string,
    wishlistId: string,
    input: { readonly productId: string; readonly skuPref: string | null; readonly note: string | undefined },
  ): Promise<
    | { readonly kind: "added"; readonly view: ItemView }
    | NotFound
    | { readonly kind: "rejected"; readonly reason: AddItemFailure }
  > {
    const list = await owned(this.repo, userId, wishlistId);
    if (list === null) return NOT_FOUND;
    const note = validateNote(input.note);
    if (!note.ok) return { kind: "rejected", reason: "note_invalid" };

    const existing = await this.repo.items(list.id);
    if (existing.length >= LIMITS.maxItemsPerWishlist) return { kind: "rejected", reason: "item_limit_reached" };
    if (existing.some((i) => itemKey(i.productId, i.skuPref) === itemKey(input.productId, input.skuPref))) {
      return { kind: "rejected", reason: "duplicate_item" };
    }

    const catalog = await readCatalog(this.catalog, [input.productId]);
    // The price paid attention to must be honest: without the catalog there is no added_price.
    if (catalog === null) return { kind: "rejected", reason: "catalog_unavailable" };
    const product = catalog.get(input.productId);
    if (product === undefined || !product.listed || product.currentPrice === null) {
      return { kind: "rejected", reason: "product_unavailable" };
    }
    if (input.skuPref !== null && !product.skuIds.includes(input.skuPref)) {
      return { kind: "rejected", reason: "sku_not_in_product" };
    }

    const nowMs = this.clock.nowMs();
    const item: WishlistItem = {
      id: this.ids.uuidV7(),
      wishlistId: list.id,
      userId,
      productId: input.productId,
      skuPref: input.skuPref,
      addedPrice: product.currentPrice,
      note: note.value,
      coolOffUntilMs: coolOffUntil(list, nowMs),
      addedAtMs: nowMs,
    };
    await this.repo.insertItem(item);
    return { kind: "added", view: itemView(item, catalog, nowMs) };
  }
}

export class RemoveWishlistItem {
  constructor(private readonly repo: WishlistRepository) {}

  async execute(userId: string, wishlistId: string, itemId: string): Promise<{ readonly kind: "removed" } | NotFound> {
    const list = await owned(this.repo, userId, wishlistId);
    if (list === null) return NOT_FOUND;
    return (await this.repo.deleteItem(list.id, itemId)) ? { kind: "removed" } : NOT_FOUND;
  }
}
