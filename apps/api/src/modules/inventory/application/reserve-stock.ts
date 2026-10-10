import {
  planReservation,
  type PlanErrorCode,
  type ReserveOutcome,
  type ReserveRequestLine,
  type Shortfall,
} from "../domain/core";
import type { ClockPort, IdPort, InventoryStore, SkuDirectory } from "../domain/ports";
import { ReserveStockInput } from "./schemas";

export type ReserveStockResult =
  | { readonly kind: "reserved"; readonly reservationId: string; readonly expiresAt: string; readonly replayed: boolean }
  | { readonly kind: "insufficient"; readonly shortfalls: readonly Shortfall[] }
  | { readonly kind: "invalid"; readonly code: PlanErrorCode | "unknown_sku" | "invalid_input"; readonly skuId?: string }
  | { readonly kind: "conflict" }
  | { readonly kind: "closed"; readonly reservationStatus: string };

/**
 * Checkout saga step `ReserveInventory` (spec 7). One reservation per OrderGroup: a retry with the
 * same lines returns the same reservation, different lines are a conflict. The shopper's price
 * and cart are not this module's business: only stock is held.
 */
export class ReserveStock {
  constructor(
    private readonly store: InventoryStore,
    private readonly directory: SkuDirectory,
    private readonly clock: ClockPort,
    private readonly ids: IdPort,
  ) {}

  async execute(raw: unknown): Promise<ReserveStockResult> {
    const parsed = ReserveStockInput.safeParse(raw);
    if (!parsed.success) return { kind: "invalid", code: "invalid_input" };
    const input = parsed.data;
    const nowMs = this.clock.nowMs();

    const lines: ReserveRequestLine[] = [];
    for (const l of input.lines) {
      const loc = await this.directory.lookup(l.skuId);
      if (loc === null) return { kind: "invalid", code: "unknown_sku", skuId: l.skuId };
      lines.push({ skuId: l.skuId, locationId: loc.locationId, storeId: loc.storeId, qty: l.qty, dropId: loc.dropId });
    }
    const dropIds = [...new Set(lines.flatMap((l) => (l.dropId === null ? [] : [l.dropId])))];
    const [policies, pools] = await Promise.all([this.store.ttlPolicies(nowMs), this.store.poolIds(dropIds)]);

    const planned = planReservation(input.paymentMethod, lines, {
      policies,
      standardPoolId: pools.standard,
      fawryPoolId: pools.fawry,
      dropPoolIds: pools.drops,
    });
    if (!planned.ok) {
      return planned.error.skuId === undefined
        ? { kind: "invalid", code: planned.error.code }
        : { kind: "invalid", code: planned.error.code, skuId: planned.error.skuId };
    }

    const outcome: ReserveOutcome = await this.store.reserve({
      reservationId: this.ids.newId(),
      orderGroupId: input.orderGroupId,
      userId: input.userId,
      plan: planned.plan,
      nowMs,
    });
    switch (outcome.status) {
      case "reserved":
        return {
          kind: "reserved",
          reservationId: outcome.reservationId,
          expiresAt: new Date(outcome.expiresAtMs).toISOString(),
          replayed: outcome.replayed,
        };
      case "insufficient":
        return { kind: "insufficient", shortfalls: outcome.shortfalls };
      case "conflict":
        return { kind: "conflict" };
      case "closed":
        return { kind: "closed", reservationStatus: outcome.reservationStatus };
    }
  }
}
