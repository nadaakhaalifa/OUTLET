import { z } from "zod";
import { planDateAlerts, planSignalAlert, type CatalogSignal, type PlannedAlert } from "../domain/alerts";
import type { Clock, WishlistRepository } from "../domain/ports";

const Id = z.string().min(1).max(64);
const Piastres = z.string().regex(/^[0-9]{1,18}$/);

/** Wire shape of catalog and pricing signals consumed from the queue. Validated at the boundary. */
export const CatalogSignalSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("verified_price_drop"),
      event_id: Id,
      product_id: Id,
      claim_id: Id,
      new_price: z.object({ amount: Piastres, currency: z.literal("EGP") }).strict(),
    })
    .strict(),
  z.object({ kind: z.literal("back_in_size"), event_id: Id, product_id: Id, sku_id: Id }).strict(),
  z
    .object({
      kind: z.literal("stock_level"),
      event_id: Id,
      product_id: Id,
      sku_id: Id,
      available: z.number().int().min(0).max(1_000_000),
    })
    .strict(),
]);

export function toSignal(wire: z.infer<typeof CatalogSignalSchema>): CatalogSignal {
  switch (wire.kind) {
    case "verified_price_drop":
      return {
        kind: wire.kind,
        eventId: wire.event_id,
        productId: wire.product_id,
        claimId: wire.claim_id,
        newPrice: { amount: BigInt(wire.new_price.amount), currency: "EGP" },
      };
    case "back_in_size":
      return { kind: wire.kind, eventId: wire.event_id, productId: wire.product_id, skuId: wire.sku_id };
    case "stock_level":
      return {
        kind: wire.kind,
        eventId: wire.event_id,
        productId: wire.product_id,
        skuId: wire.sku_id,
        available: wire.available,
      };
  }
}

/** The dedupe claim and the outbox event commit together: a crash can neither lose nor duplicate an alert. */
async function emit(repo: WishlistRepository, alerts: readonly PlannedAlert[]): Promise<number> {
  let n = 0;
  for (const a of alerts) {
    if (!(await repo.claimAlert(a.dedupeKey, a.wishlistId, [{ type: "wishlist.alert_due", alert: a }]))) continue;
    n += 1;
  }
  return n;
}

/** Idempotent consumer of catalog signals. Plans alerts; never sends anything. */
export class HandleCatalogSignal {
  constructor(
    private readonly repo: WishlistRepository,
  ) {}

  async execute(raw: unknown): Promise<{ readonly kind: "invalid" } | { readonly kind: "handled"; readonly emitted: number }> {
    const parsed = CatalogSignalSchema.safeParse(raw);
    if (!parsed.success) return { kind: "invalid" };
    const signal = toSignal(parsed.data);
    const items = await this.repo.itemsByProduct(signal.productId);
    const planned: PlannedAlert[] = [];
    for (const item of items) {
      const p = planSignalAlert(signal, item);
      if (p !== null) planned.push(p);
    }
    return { kind: "handled", emitted: await emit(this.repo, planned) };
  }
}

/** Daily job: 7 days and 1 day before a list's target date. */
export class ScheduleDateAlerts {
  constructor(
    private readonly repo: WishlistRepository,
    private readonly clock: Clock,
  ) {}

  async execute(): Promise<{ readonly emitted: number }> {
    const nowMs = this.clock.nowMs();
    const planned: PlannedAlert[] = [];
    for (const list of await this.repo.listWithDates()) planned.push(...planDateAlerts(list, nowMs));
    return { emitted: await emit(this.repo, planned) };
  }
}
