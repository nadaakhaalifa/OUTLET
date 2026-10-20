import {
  MAX_UNITS_PER_SKU,
  effectiveThreshold,
  freeDelivery,
  money,
  planAdd,
  priceBag,
  rankSuggestions,
  thresholdChange,
  validateQty,
  type FreeDelivery,
  type GroupStatus,
  type Money,
  type PriceChange,
  type StoreTerms,
  type ThresholdChange,
} from "../domain/bridge";
import {
  CatalogUnavailableError,
  type CartEventPublisher,
  type CartLineRecord,
  type CartRecord,
  type CartRepository,
  type CatalogPort,
  type LineSource,
  type LocalizedText,
  type MembershipPort,
  type PlatformConfigPort,
  type SkuFacts,
  type StoreFacts,
  type StoreSummaryFacts,
  type SuggestionFacts,
} from "../domain/ports";

export { CatalogUnavailableError };

export interface BagLineView {
  readonly id: string;
  readonly skuId: string;
  readonly productId: string;
  readonly title: LocalizedText;
  readonly sizeLabel: string | undefined;
  readonly imageUrl: string | undefined;
  readonly qty: number;
  readonly unitPrice: Money;
  readonly priceAtAdd: Money;
  readonly priceChange: PriceChange;
  readonly available: boolean;
  readonly source: LineSource | null;
  readonly savedForLater: boolean;
  readonly counted: boolean;
}

export interface BagGroupView {
  readonly store: StoreSummaryFacts;
  readonly status: GroupStatus;
  readonly lines: readonly BagLineView[];
  readonly merchandiseSubtotal: Money;
  readonly freeDelivery: FreeDelivery;
  readonly deliveryFee: Money;
  /** Set only by `QuoteBagForCheckout`. */
  readonly thresholdChange: ThresholdChange | null;
}

export interface BagView {
  readonly cartId: string;
  readonly updatedAtMs: number;
  /** All lines the shopper holds (in bag plus saved), as counted against the 50 line cap. */
  readonly lineCount: number;
  readonly groups: readonly BagGroupView[];
}

export interface Clock {
  nowMs(): number;
}
export interface Ids {
  uuidV7(): string;
}

export interface BagDeps {
  readonly repo: CartRepository;
  readonly catalog: CatalogPort;
  readonly membership: MembershipPort;
  readonly platform: PlatformConfigPort;
  readonly events: CartEventPublisher;
  readonly clock: Clock;
  readonly ids: Ids;
}

const MAX_RETRIES = 3;

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** Builds the priced bag view. Reads only; writes nothing. */
export async function buildBagView(deps: BagDeps, cart: CartRecord, opts: { forCheckout: boolean }): Promise<{
  view: BagView;
  facts: ReadonlyMap<string, SkuFacts>;
  stores: ReadonlyMap<string, StoreFacts>;
}> {
  const skus = await deps.catalog.skus(unique(cart.lines.map((l) => l.skuId)));
  const known = cart.lines.filter((l) => skus.has(l.skuId));
  const stores = await deps.catalog.stores(unique(known.map((l) => skus.get(l.skuId)?.storeId ?? l.storeId)), cart.userId);
  const [plus, platformThreshold] = await Promise.all([
    deps.membership.isPlusMember(cart.userId),
    deps.platform.freeDeliveryThreshold(),
  ]);

  const terms = new Map<string, StoreTerms>();
  for (const [id, s] of stores) {
    terms.set(id, { open: s.open, thresholdOverride: s.freeDeliveryThreshold, standardDeliveryFee: s.standardDeliveryFee });
  }
  const lineById = new Map(known.map((l) => [l.id, l]));
  const priced = priceBag({
    lines: known.flatMap((l) => {
      const f = skus.get(l.skuId);
      return f === undefined
        ? []
        : [
            {
              lineId: l.id,
              skuId: l.skuId,
              storeId: f.storeId,
              qty: l.qty,
              unitPrice: f.unitPrice,
              priceAtAdd: l.priceAtAdd,
              state: l.state,
              available: f.available,
            },
          ];
    }),
    stores: terms,
    platformThreshold,
    plusMember: plus,
  });

  const groups: BagGroupView[] = [];
  for (const g of priced) {
    const store = stores.get(g.storeId);
    if (store === undefined) continue; // unknown store: lines cannot be rendered; see spec edge cases
    let change: ThresholdChange | null = null;
    if (opts.forCheckout) {
      const latest = g.lines
        .map((l) => lineById.get(l.lineId))
        .filter((l): l is CartLineRecord => l !== undefined && l.state === "IN_BAG" && l.thresholdAtAdd !== null)
        .sort((a, b) => b.addedAtMs - a.addedAtMs)[0];
      change = thresholdChange(latest?.thresholdAtAdd ?? null, effectiveThreshold(terms.get(g.storeId), platformThreshold));
    }
    groups.push({
      store: store.summary,
      status: g.status,
      merchandiseSubtotal: g.merchandiseSubtotal,
      freeDelivery: g.freeDelivery,
      deliveryFee: g.deliveryFee,
      thresholdChange: change,
      lines: g.lines.flatMap((l) => {
        const rec = lineById.get(l.lineId);
        const f = skus.get(l.skuId);
        if (rec === undefined || f === undefined) return [];
        return [
          {
            id: l.lineId,
            skuId: l.skuId,
            productId: f.productId,
            title: f.title,
            sizeLabel: f.sizeLabel,
            imageUrl: f.imageUrl,
            qty: l.qty,
            unitPrice: l.unitPrice,
            priceAtAdd: l.priceAtAdd,
            priceChange: l.priceChange,
            available: f.available,
            source: rec.source,
            savedForLater: l.state === "SAVED_FOR_LATER",
            counted: l.counted,
          },
        ];
      }),
    });
  }
  return {
    view: { cartId: cart.id, updatedAtMs: cart.updatedAtMs, lineCount: cart.lines.length, groups },
    facts: skus,
    stores,
  };
}

/** Retries an optimistic mutation. Returns null when every attempt lost the race. */
async function mutate<T>(
  deps: BagDeps,
  userId: string,
  fn: (cart: CartRecord) => Promise<{ next: CartRecord; result: T } | { reject: T }>,
): Promise<{ result: T; cart: CartRecord; saved: boolean } | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const cart = await deps.repo.getOrCreate(userId, deps.ids.uuidV7(), deps.clock.nowMs());
    const out = await fn(cart);
    if ("reject" in out) return { result: out.reject, cart, saved: false };
    const now = deps.clock.nowMs();
    if (await deps.repo.save(out.next, cart.version, now)) {
      return { result: out.result, cart: { ...out.next, version: cart.version + 1, updatedAtMs: now }, saved: true };
    }
  }
  return null;
}

export class GetCart {
  constructor(private readonly deps: BagDeps) {}

  async execute(userId: string): Promise<BagView> {
    const d = this.deps;
    const cart = await d.repo.getOrCreate(userId, d.ids.uuidV7(), d.clock.nowMs());
    const { view, facts, stores } = await buildBagView(d, cart, { forCheckout: false });
    await this.syncAvailability(cart, facts, stores);
    return view;
  }

  /** Emits `cart.line_unavailable` once per unavailability episode and clears it on recovery. */
  private async syncAvailability(
    cart: CartRecord,
    facts: ReadonlyMap<string, SkuFacts>,
    stores: ReadonlyMap<string, StoreFacts>,
  ): Promise<void> {
    const changes: { lineId: string; sinceMs: number | null }[] = [];
    for (const line of cart.lines) {
      const f = facts.get(line.skuId);
      if (f === undefined) continue;
      const storeOpen = stores.get(f.storeId)?.open === true;
      const ok = f.available && storeOpen;
      if (!ok && line.unavailableSinceMs === null) {
        await this.deps.events.publish({
          name: "cart.line_unavailable",
          userId: cart.userId,
          cartId: cart.id,
          skuId: line.skuId,
          reason: storeOpen ? "sold_out" : "store_suspended",
        });
        changes.push({ lineId: line.id, sinceMs: this.deps.clock.nowMs() });
      } else if (ok && line.unavailableSinceMs !== null) {
        changes.push({ lineId: line.id, sinceMs: null });
      }
    }
    if (changes.length > 0) await this.deps.repo.setUnavailableSince(cart.userId, changes);
  }
}

export type AddLineResult =
  | { readonly kind: "ok"; readonly view: BagView }
  | {
      readonly kind:
        | "unknown_sku"
        | "sku_unavailable"
        | "store_suspended"
        | "line_limit_reached"
        | "sku_unit_limit_reached"
        | "conflict";
    };

export class AddLine {
  constructor(private readonly deps: BagDeps) {}

  async execute(input: { userId: string; skuId: string; qty: number; source: LineSource | null }): Promise<AddLineResult> {
    const d = this.deps;
    const qty = validateQty(input.qty);
    const sku = (await d.catalog.skus([input.skuId])).get(input.skuId);
    if (sku === undefined) return { kind: "unknown_sku" };
    if (!sku.available) return { kind: "sku_unavailable" };
    const store = (await d.catalog.stores([sku.storeId], input.userId)).get(sku.storeId);
    if (store === undefined || !store.open) return { kind: "store_suspended" };
    const threshold = effectiveThreshold(
      { open: true, thresholdOverride: store.freeDeliveryThreshold, standardDeliveryFee: store.standardDeliveryFee },
      await d.platform.freeDeliveryThreshold(),
    );

    const out = await mutate<AddLineResult["kind"] | "ok">(d, input.userId, async (cart) => {
      const plan = planAdd(
        cart.lines.map((l) => ({ lineId: l.id, skuId: l.skuId, qty: l.qty, state: l.state })),
        input.skuId,
        qty,
      );
      if (plan.kind === "rejected") return { reject: plan.reason };
      const now = d.clock.nowMs();
      if (plan.kind === "create") {
        const line: CartLineRecord = {
          id: d.ids.uuidV7(),
          skuId: sku.skuId,
          storeId: sku.storeId,
          qty: plan.qty,
          priceAtAdd: sku.unitPrice,
          thresholdAtAdd: threshold,
          state: "IN_BAG",
          source: input.source,
          unavailableSinceMs: null,
          addedAtMs: now,
        };
        return { next: { ...cart, lines: [...cart.lines, line] }, result: "ok" };
      }
      return {
        next: {
          ...cart,
          lines: cart.lines.map((l) =>
            l.id === plan.lineId
              ? { ...l, qty: plan.qty, state: "IN_BAG", priceAtAdd: sku.unitPrice, thresholdAtAdd: threshold, addedAtMs: now }
              : l,
          ),
        },
        result: "ok",
      };
    });
    if (out === null) return { kind: "conflict" };
    if (!out.saved || out.result !== "ok") return { kind: out.result === "ok" ? "conflict" : out.result };
    const { view } = await buildBagView(d, out.cart, { forCheckout: false });
    return { kind: "ok", view };
  }
}

export type UpdateLineResult =
  | { readonly kind: "ok"; readonly view: BagView }
  | { readonly kind: "not_found" | "conflict" | "sku_unit_limit_reached" };

export class UpdateLine {
  constructor(private readonly deps: BagDeps) {}

  async execute(input: { userId: string; lineId: string; qty?: number; savedForLater?: boolean }): Promise<UpdateLineResult> {
    const d = this.deps;
    const qty = input.qty === undefined ? undefined : validateQty(input.qty);
    if (qty !== undefined && qty > MAX_UNITS_PER_SKU) return { kind: "sku_unit_limit_reached" };
    const out = await mutate<"ok" | "not_found">(d, input.userId, async (cart) => {
      const line = cart.lines.find((l) => l.id === input.lineId);
      if (line === undefined) return { reject: "not_found" };
      const next: CartLineRecord = {
        ...line,
        qty: qty ?? line.qty,
        state: input.savedForLater === undefined ? line.state : input.savedForLater ? "SAVED_FOR_LATER" : "IN_BAG",
      };
      return { next: { ...cart, lines: cart.lines.map((l) => (l.id === line.id ? next : l)) }, result: "ok" };
    });
    if (out === null) return { kind: "conflict" };
    if (out.result === "not_found") return { kind: "not_found" };
    const { view } = await buildBagView(d, out.cart, { forCheckout: false });
    return { kind: "ok", view };
  }
}

export class RemoveLine {
  constructor(private readonly deps: BagDeps) {}

  async execute(input: { userId: string; lineId: string }): Promise<UpdateLineResult> {
    const d = this.deps;
    const out = await mutate<"ok" | "not_found">(d, input.userId, async (cart) => {
      if (!cart.lines.some((l) => l.id === input.lineId)) return { reject: "not_found" };
      return { next: { ...cart, lines: cart.lines.filter((l) => l.id !== input.lineId) }, result: "ok" };
    });
    if (out === null) return { kind: "conflict" };
    if (out.result === "not_found") return { kind: "not_found" };
    const { view } = await buildBagView(d, out.cart, { forCheckout: false });
    return { kind: "ok", view };
  }
}

export interface SuggestionsView {
  readonly storeId: string;
  readonly remaining: Money;
  readonly suggestions: readonly SuggestionFacts[];
}

export class GetFreeDeliverySuggestions {
  constructor(private readonly deps: BagDeps) {}

  async execute(input: { userId: string; storeId: string }): Promise<SuggestionsView | null> {
    const d = this.deps;
    const store = (await d.catalog.stores([input.storeId], input.userId)).get(input.storeId);
    if (store === undefined) return null;
    const cart = await d.repo.getOrCreate(input.userId, d.ids.uuidV7(), d.clock.nowMs());
    const { view } = await buildBagView(d, cart, { forCheckout: false });
    const group = view.groups.find((g) => g.store.id === input.storeId);
    let fd = group?.freeDelivery;
    if (fd === undefined) {
      const plus = await d.membership.isPlusMember(input.userId);
      const platform = await d.platform.freeDeliveryThreshold();
      fd = freeDelivery(
        money(0n, platform.currency),
        effectiveThreshold(
          { open: store.open, thresholdOverride: store.freeDeliveryThreshold, standardDeliveryFee: store.standardDeliveryFee },
          platform,
        ),
        plus,
        store.open,
      );
    }
    if (fd.unlocked || !store.open) return { storeId: input.storeId, remaining: fd.remaining, suggestions: [] };
    const candidates = await d.catalog.freeDeliveryCandidates({
      storeId: input.storeId,
      userId: input.userId,
      excludeSkuIds: cart.lines.map((l) => l.skuId),
      limit: 50,
    });
    const inBag = new Set(cart.lines.map((l) => l.skuId));
    const eligible = candidates.filter((c) => c.store.id === input.storeId && !inBag.has(c.skuId));
    return { storeId: input.storeId, remaining: fd.remaining, suggestions: rankSuggestions(fd.remaining, eligible, 20) };
  }
}

/** Exported for the checkout module: server-side re-pricing with the checkout-time threshold. */
export class QuoteBagForCheckout {
  constructor(private readonly deps: BagDeps) {}

  async execute(userId: string): Promise<BagView> {
    const cart = await this.deps.repo.getOrCreate(userId, this.deps.ids.uuidV7(), this.deps.clock.nowMs());
    return (await buildBagView(this.deps, cart, { forCheckout: true })).view;
  }
}
