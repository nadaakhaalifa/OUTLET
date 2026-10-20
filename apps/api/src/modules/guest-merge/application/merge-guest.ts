import {
  GUEST_MERGE_LIMITS,
  effectiveThreshold,
  planGuestBagMerge,
  type GuestBagLine,
  type GuestSkuStatus,
  type MergeLineOutcome,
  type Money,
} from "@outlet/domain";
import { CatalogUnavailableError } from "../../cart";
import type { BagView, CartLineRecord, CartRecord, CatalogPort, PlatformConfigPort, SkuFacts, StoreFacts } from "../../cart";
import {
  WISHLIST_LIMITS,
  createWishlist,
  type CatalogReadPort,
  type WishlistIntent,
  type WishlistRepository,
} from "../../wishlists";
import type { Clock, IdGenerator } from "../../../platform/ports";
import {
  GuestCatalogUnavailableError,
  MergeConflictError,
  type GuestMergeUnitOfWork,
  type MergeTx,
  type GuestSavedIntent,
  type PersonalizationConsentReader,
  type RecentlyViewedWriter,
} from "../domain/ports";

export interface GuestSavedItem {
  readonly productId: string;
  readonly skuId: string | null;
  readonly intent: GuestSavedIntent;
}

export interface GuestMergeInput {
  readonly userId: string;
  readonly bag: readonly GuestBagLine[];
  readonly saved: readonly GuestSavedItem[];
  readonly viewed: readonly { readonly productId: string; readonly viewedAtMs: number }[];
}

export interface SavedCounts {
  added: number;
  duplicates: number;
  overCap: number;
  /** Product unknown, delisted or without a price: nothing to save. */
  unavailable: number;
}

export type ViewedResult = "accepted" | "ignored_no_consent" | "not_recorded";

export interface GuestMergeResult {
  readonly cart: BagView;
  readonly lines: readonly MergeLineOutcome[];
  readonly saved: SavedCounts;
  readonly viewed: ViewedResult;
}

/** Late-bound ports: resolved per call so the module works before every other module has booted. */
export interface GuestMergePorts {
  readonly uow: GuestMergeUnitOfWork;
  readonly catalog: () => CatalogPort;
  readonly platform: () => PlatformConfigPort;
  readonly products: () => CatalogReadPort;
  readonly readCart: (userId: string) => Promise<BagView>;
  readonly consent: () => PersonalizationConsentReader;
  readonly viewed: () => RecentlyViewedWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Receives the cause of a catalog outage (logged by the composition root). */
  readonly onPrefetchError?: (cause: unknown) => void;
}

const MAX_ATTEMPTS = 3;

const INTENT: Record<GuestSavedIntent, WishlistIntent> = {
  need: "need",
  want: "want",
  treat: "treat",
  later: "buy_later_this_month",
};

/** Arabic first (CPL 181/2018); a list created by the merge is a normal list the owner can rename. */
const TITLE: Record<WishlistIntent, string> = {
  need: "أحتاجه",
  want: "أريده",
  treat: "مكافأة لنفسي",
  buy_later_this_month: "لاحقاً",
  birthday: "عيد ميلادي",
  eid_ramadan: "العيد ورمضان",
  gift_for_someone: "هدية",
  custom: "قائمتي",
};

const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

interface Candidate {
  readonly intent: WishlistIntent;
  readonly productId: string;
  readonly skuId: string | null;
}

/**
 * POST /v1/me/guest-merge (ADR-0055). Reads the catalog first (prices and availability are ALWAYS the server's;
 * the request carries no price), then applies the bag merge, the Saved items and the outbox row in ONE unit of
 * work. Idempotency of the HTTP call is the platform's Idempotency-Key store; the merge itself is also idempotent
 * (the larger quantity wins, so a replay changes nothing).
 */
export class MergeGuest {
  constructor(private readonly p: GuestMergePorts) {}

  async execute(input: GuestMergeInput): Promise<GuestMergeResult> {
    const ctx = await this.prefetch(input);
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        const done = await this.p.uow.run(input.userId, (tx) => this.apply(tx, input, ctx));
        const [cart, viewed] = await Promise.all([this.p.readCart(input.userId), this.recordViewed(input)]);
        return { cart, lines: done.lines, saved: done.saved, viewed };
      } catch (e) {
        if (!(e instanceof MergeConflictError)) throw e;
        lastError = e;
      }
    }
    throw lastError instanceof Error ? lastError : new MergeConflictError();
  }

  private async prefetch(input: GuestMergeInput): Promise<Prefetch> {
    try {
      const skuIds = unique(input.bag.map((l) => l.skuId));
      const catalog = this.p.catalog();
      const skus = await catalog.skus(skuIds);
      const storeIds = unique([...skus.values()].map((s) => s.storeId));
      const [stores, platformThreshold] = await Promise.all([
        catalog.stores(storeIds, input.userId),
        this.p.platform().freeDeliveryThreshold(),
      ]);
      const productIds = unique([...input.saved.map((s) => s.productId), ...[...skus.values()].map((s) => s.productId)]);
      const products = productIds.length === 0 ? new Map() : await this.p.products().products(productIds);
      return { skus, stores, platformThreshold, products };
    } catch (cause) {
      // Programming errors must surface as 500s, not masquerade as an outage.
      if (!(cause instanceof CatalogUnavailableError)) throw cause;
      this.p.onPrefetchError?.(cause);
      // A catalog failure must never produce a merge priced from guesses.
      throw new GuestCatalogUnavailableError();
    }
  }

  private statusOf(ctx: Prefetch, skuId: string): GuestSkuStatus {
    const sku = ctx.skus.get(skuId);
    if (sku === undefined) return { kind: "unknown" };
    const store = ctx.stores.get(sku.storeId);
    if (store === undefined || !store.open) return { kind: "store_suspended" };
    if (!sku.available) return { kind: "unavailable", productId: sku.productId };
    return { kind: "ok", productId: sku.productId };
  }

  private async apply(
    tx: MergeTx,
    input: GuestMergeInput,
    ctx: Prefetch,
  ): Promise<{ lines: readonly MergeLineOutcome[]; saved: SavedCounts }> {
    const now = this.p.clock.nowMs();
    const cart = await tx.cart.getOrCreate(input.userId, this.p.ids.uuidV7(), now);
    const plan = planGuestBagMerge(
      cart.lines.map((l) => ({ lineId: l.id, skuId: l.skuId, qty: l.qty, state: l.state })),
      input.bag,
      (skuId) => this.statusOf(ctx, skuId),
    );

    if (plan.lines.some((l) => l.touched)) {
      const byId = new Map(cart.lines.map((l) => [l.id, l]));
      const next: CartRecord = {
        ...cart,
        lines: plan.lines.flatMap((l): CartLineRecord[] => {
          const existing = l.existingLineId === null ? undefined : byId.get(l.existingLineId);
          if (existing !== undefined && !l.touched) return [existing];
          const sku = ctx.skus.get(l.skuId);
          if (sku === undefined) return existing === undefined ? [] : [existing];
          const threshold = this.thresholdFor(ctx, sku);
          return [
            existing !== undefined
              ? // Only qty/state change: the price-at-add and add time stay the baseline for "price changed since you added".
                { ...existing, qty: l.qty, state: l.state }
              : {
                  id: this.p.ids.uuidV7(),
                  skuId: sku.skuId,
                  storeId: sku.storeId,
                  qty: l.qty,
                  // The price is the server's, read just now. A device price is not part of the request.
                  priceAtAdd: sku.unitPrice,
                  thresholdAtAdd: threshold,
                  state: l.state,
                  source: "merged_guest",
                  unavailableSinceMs: null,
                  addedAtMs: now,
                },
          ];
        }),
      };
      if (!(await tx.cart.save(next, cart.version, now))) throw new MergeConflictError();
    }

    const candidates: Candidate[] = [
      ...input.saved.map((s) => ({ intent: INTENT[s.intent], productId: s.productId, skuId: s.skuId })),
      // Bag lines that could not stay (cap, sold out) wait in the default Saved list ("want").
      ...plan.toSaved.map((s) => ({ intent: "want" as const, productId: s.productId, skuId: s.skuId })),
    ];
    const saved = await this.saveItems(tx.wishlists, input.userId, candidates, ctx, now);

    const count = (r: MergeLineOutcome["result"]): number => plan.outcomes.filter((o) => o.result === r).length;
    const counts = {
      added: count("added") + count("limit_clamped") + count("moved_to_bag"),
      qtyRaised: count("qty_raised"),
      movedToSaved: count("moved_to_saved"),
      unavailable: count("unavailable"),
      storeSuspended: count("store_suspended"),
      savedAdded: saved.added,
    };
    if (counts.added + counts.qtyRaised + counts.movedToSaved + counts.savedAdded > 0) {
      await tx.emit({ type: "cart.guest_merged", userId: input.userId, cartId: cart.id, counts });
    }
    return { lines: plan.outcomes, saved };
  }

  private thresholdFor(ctx: Prefetch, sku: SkuFacts): Money {
    const store = ctx.stores.get(sku.storeId);
    return effectiveThreshold(
      {
        open: true,
        thresholdOverride: store?.freeDeliveryThreshold ?? null,
        standardDeliveryFee: store?.standardDeliveryFee ?? { amount: 0n, currency: "EGP" },
      },
      ctx.platformThreshold,
    );
  }

  private async saveItems(
    repo: WishlistRepository,
    userId: string,
    candidates: readonly Candidate[],
    ctx: Prefetch,
    now: number,
  ): Promise<SavedCounts> {
    const counts: SavedCounts = { added: 0, duplicates: 0, overCap: 0, unavailable: 0 };
    if (candidates.length === 0) return counts;

    // Existing lists, oldest first: the first list of an intent is its default list.
    const lists = [...(await repo.listByUser(userId, { after: null, limit: WISHLIST_LIMITS.maxWishlistsPerUser + 1 }))].sort(
      (a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : 1),
    );
    let listCount = lists.length;
    const defaultList = new Map<WishlistIntent, (typeof lists)[number]>();
    for (const l of lists) if (!defaultList.has(l.intent)) defaultList.set(l.intent, l);

    const intents = unique(candidates.map((c) => c.intent)).sort() as WishlistIntent[];
    for (const intent of intents) {
      const mine = candidates.filter((c) => c.intent === intent).sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
      const valid = mine.filter((c) => {
        const p = ctx.products.get(c.productId);
        const ok = p !== undefined && p.listed && p.currentPrice !== null;
        if (!ok) counts.unavailable += 1;
        return ok;
      });
      if (valid.length === 0) continue;

      let list = defaultList.get(intent);
      if (list === undefined) {
        if (listCount >= WISHLIST_LIMITS.maxWishlistsPerUser) {
          counts.overCap += valid.length;
          continue;
        }
        const created = createWishlist(
          { intent, title: TITLE[intent], targetDate: null, budget: null, giftFor: null, coolOffEnabled: false },
          { id: this.p.ids.uuidV7(), userId, nowMs: now },
        );
        if (!created.ok) {
          counts.overCap += valid.length;
          continue;
        }
        await repo.insert(created.value);
        listCount += 1;
        list = created.value;
        defaultList.set(intent, list);
      }

      const existing = await repo.items(list.id);
      const have = new Set(existing.map((i) => i.productId));
      let size = existing.length;
      for (const c of valid) {
        if (have.has(c.productId)) {
          counts.duplicates += 1;
          continue;
        }
        if (size >= WISHLIST_LIMITS.maxItemsPerWishlist) {
          counts.overCap += 1;
          continue;
        }
        const product = ctx.products.get(c.productId);
        if (product === undefined || product.currentPrice === null) continue;
        await repo.insertItem({
          id: this.p.ids.uuidV7(),
          wishlistId: list.id,
          userId,
          productId: c.productId,
          skuPref: c.skuId !== null && product.skuIds.includes(c.skuId) ? c.skuId : null,
          addedPrice: product.currentPrice,
          note: null,
          coolOffUntilMs: null,
          addedAtMs: now,
        });
        have.add(c.productId);
        size += 1;
        counts.added += 1;
      }
    }
    return counts;
  }

  /** After the commit: recently viewed is best effort and consent-gated; it never fails the merge. */
  private async recordViewed(input: GuestMergeInput): Promise<ViewedResult> {
    if (input.viewed.length === 0) return "accepted";
    const granted = await this.p.consent().isGranted(input.userId).catch(() => false);
    if (!granted) return "ignored_no_consent";
    const ordered = [...input.viewed]
      .sort((a, b) => a.viewedAtMs - b.viewedAtMs)
      .map((v) => v.productId)
      .slice(-GUEST_MERGE_LIMITS.maxViewed);
    try {
      await this.p.viewed().record(input.userId, unique(ordered));
      return "accepted";
    } catch {
      return "not_recorded";
    }
  }
}

interface Prefetch {
  readonly skus: ReadonlyMap<string, SkuFacts>;
  readonly stores: ReadonlyMap<string, StoreFacts>;
  readonly platformThreshold: Money;
  readonly products: ReadonlyMap<string, { readonly listed: boolean; readonly currentPrice: Money | null; readonly skuIds: readonly string[] }>;
}
