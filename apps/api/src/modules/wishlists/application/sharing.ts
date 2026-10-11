import { sha256Hex } from "@outlet/idempotency";
import { isShareActive, newShareLink, revokeShare } from "../domain/wishlist";
import type {
  CatalogReadPort,
  Clock,
  JsonValue,
  OwnerProfilePort,
  ProductSummaryView,
  TokenEntropy,
  WishlistEventPublisher,
  WishlistRepository,
} from "../domain/ports";
import type { Wishlist, WishlistIntent } from "../domain/types";
import { readCatalog } from "./read-model";
import type { NotFound } from "./wishlists";

export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

export function hashShareToken(token: string): string {
  return sha256Hex(`wishlist-share-v1:${token}`);
}

export class CreateShareLink {
  constructor(
    private readonly repo: WishlistRepository,
    private readonly clock: Clock,
    private readonly entropy: TokenEntropy,
    private readonly events: WishlistEventPublisher,
    private readonly baseUrl: string,
  ) {}

  async execute(
    userId: string,
    wishlistId: string,
    input: { readonly expiresAtMs: number | null; readonly hidePrices: boolean },
  ): Promise<
    | { readonly kind: "created"; readonly url: string; readonly createdAtMs: number; readonly expiresAtMs: number | null }
    | NotFound
    | { readonly kind: "invalid_expiry" }
  > {
    const list = await this.repo.get(wishlistId);
    if (list === null || list.userId !== userId) return { kind: "not_found" };
    const nowMs = this.clock.nowMs();
    // 128 bits from the CSPRNG; base64url gives 22 characters.
    const token = Buffer.from(this.entropy.randomBytes(16)).toString("base64url");
    const link = newShareLink({ tokenHash: hashShareToken(token), ...input }, nowMs);
    if (!link.ok) return { kind: "invalid_expiry" };
    // Rotation: overwriting the share columns invalidates the previous token at once.
    await this.repo.save({ ...list, share: link.value, updatedAtMs: nowMs });
    await this.events.publish({
      type: "wishlist.shared",
      wishlistId: list.id,
      userId,
      expiresAtMs: input.expiresAtMs,
      hidePrices: input.hidePrices,
    });
    return {
      kind: "created",
      url: `${this.baseUrl}/${token}`,
      createdAtMs: nowMs,
      expiresAtMs: input.expiresAtMs,
    };
  }
}

export class RevokeShareLink {
  constructor(
    private readonly repo: WishlistRepository,
    private readonly clock: Clock,
    private readonly events: WishlistEventPublisher,
  ) {}

  async execute(userId: string, wishlistId: string): Promise<{ readonly kind: "revoked" } | NotFound> {
    const list = await this.repo.get(wishlistId);
    if (list === null || list.userId !== userId) return { kind: "not_found" };
    // Revoking when nothing is shared is a no-op that still answers 204 (idempotent DELETE).
    if (list.share === null || list.share.revokedAtMs !== null) return { kind: "revoked" };
    const nowMs = this.clock.nowMs();
    await this.repo.save({ ...list, share: revokeShare(list.share, nowMs), updatedAtMs: nowMs });
    await this.events.publish({ type: "wishlist.share_revoked", wishlistId: list.id, userId });
    return { kind: "revoked" };
  }
}

export interface SharedItemView {
  readonly product: ProductSummaryView;
  readonly priceHidden: boolean;
}

export interface SharedWishlistView {
  readonly title: string;
  readonly intent: WishlistIntent;
  readonly ownerNickname: string | null;
  readonly targetDate: string | null;
  readonly items: readonly SharedItemView[];
}

function stripPrice(summary: ProductSummaryView): ProductSummaryView {
  const out: { [key: string]: JsonValue } = {};
  for (const [k, v] of Object.entries(summary)) if (k !== "price") out[k] = v;
  return { ...out, id: summary.id };
}

export class GetSharedWishlist {
  constructor(
    private readonly repo: WishlistRepository,
    private readonly catalog: CatalogReadPort,
    private readonly owners: OwnerProfilePort,
    private readonly clock: Clock,
  ) {}

  /** Unknown, revoked and expired tokens are indistinguishable: all return null. */
  async execute(token: string): Promise<SharedWishlistView | null> {
    if (!SHARE_TOKEN_PATTERN.test(token)) return null;
    const list: Wishlist | null = await this.repo.findByShareHash(hashShareToken(token));
    const nowMs = this.clock.nowMs();
    if (list === null || !isShareActive(list.share, nowMs)) return null;
    const hide = list.share.hidePrices;
    const items = await this.repo.items(list.id);
    const catalog = await readCatalog(this.catalog, items.map((i) => i.productId));
    const views: SharedItemView[] = [];
    for (const i of items) {
      const p = catalog?.get(i.productId);
      // Ghosts and unknowns are not shown to other people.
      if (p === undefined || !p.listed) continue;
      views.push({ product: hide ? stripPrice(p.summary) : p.summary, priceHidden: hide });
    }
    return {
      title: list.title,
      intent: list.intent,
      ownerNickname: await this.owners.nickname(list.userId),
      targetDate: list.targetDate,
      items: views,
    };
  }
}
