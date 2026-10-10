import { holdReasonFor, selectPolicy, type TtlPolicy } from "./ttl-policy";
import {
  MAX_RESERVATION_LINES,
  MAX_UNITS_PER_SKU,
  compareLines,
  type HoldPoolKind,
  type HoldReason,
  type PaymentMethod,
  type StockLine,
} from "./types";

/** A requested line before pool resolution. */
export interface ReserveRequestLine {
  readonly skuId: string;
  readonly locationId: string;
  readonly storeId: string;
  readonly qty: number;
  /** Set for drop SKUs: stock lives in the drop's own pool and never in the Fawry pool. */
  readonly dropId: string | null;
}

export interface ReservePlanContext {
  readonly policies: readonly TtlPolicy[];
  readonly standardPoolId: string;
  readonly fawryPoolId: string;
  readonly dropPoolIds: ReadonlyMap<string, string>;
}

export type PlanErrorCode =
  | "empty_request"
  | "too_many_lines"
  | "invalid_quantity"
  | "quantity_over_limit"
  | "duplicate_sku"
  | "no_ttl_policy"
  | "drop_sku_not_allowed_for_fawry"
  | "unknown_drop_pool";

export interface PlanError {
  readonly code: PlanErrorCode;
  readonly skuId?: string;
}

export interface ReservePlan {
  readonly lines: readonly StockLine[];
  readonly ttlSeconds: number;
  readonly ttlPolicyId: string;
  readonly poolKind: HoldPoolKind;
  readonly holdReason: HoldReason;
  /** Canonical text of the sorted lines. Two requests are the same request iff fingerprints are equal. */
  readonly fingerprint: string;
}

export type PlanResult =
  | { readonly ok: true; readonly plan: ReservePlan }
  | { readonly ok: false; readonly error: PlanError };

const err = (code: PlanErrorCode, skuId?: string): PlanResult => ({
  ok: false,
  error: skuId === undefined ? { code } : { code, skuId },
});

export const fingerprintLines = (lines: readonly StockLine[]): string =>
  [...lines]
    .sort(compareLines)
    .map((l) => `${l.skuId}:${l.locationId}:${l.poolId}:${l.qty}`)
    .join(",");

/**
 * Validates a reservation request and produces the sorted, pool-resolved lines and the TTL.
 * Pure: the same input always yields the same plan. Fails closed on every ambiguity.
 */
export const planReservation = (
  method: PaymentMethod,
  requested: readonly ReserveRequestLine[],
  ctx: ReservePlanContext,
): PlanResult => {
  if (requested.length === 0) return err("empty_request");
  if (requested.length > MAX_RESERVATION_LINES) return err("too_many_lines");
  const policy = selectPolicy(method, ctx.policies);
  if (policy === null) return err("no_ttl_policy");

  const seen = new Set<string>();
  const lines: StockLine[] = [];
  for (const r of requested) {
    if (!Number.isSafeInteger(r.qty) || r.qty < 1) return err("invalid_quantity", r.skuId);
    const cap = policy.maxQtyPerLine === null ? MAX_UNITS_PER_SKU : Math.min(MAX_UNITS_PER_SKU, policy.maxQtyPerLine);
    if (r.qty > cap) return err("quantity_over_limit", r.skuId);
    const id = `${r.skuId}|${r.locationId}`;
    if (seen.has(id)) return err("duplicate_sku", r.skuId);
    seen.add(id);

    let poolId: string;
    if (r.dropId !== null) {
      if (policy.poolKind === "FAWRY") return err("drop_sku_not_allowed_for_fawry", r.skuId);
      const dropPool = ctx.dropPoolIds.get(r.dropId);
      if (dropPool === undefined) return err("unknown_drop_pool", r.skuId);
      poolId = dropPool;
    } else {
      poolId = policy.poolKind === "FAWRY" ? ctx.fawryPoolId : ctx.standardPoolId;
    }
    lines.push({ skuId: r.skuId, locationId: r.locationId, poolId, storeId: r.storeId, qty: r.qty });
  }
  lines.sort(compareLines);
  return {
    ok: true,
    plan: {
      lines,
      ttlSeconds: policy.ttlSeconds,
      ttlPolicyId: policy.id,
      poolKind: policy.poolKind,
      holdReason: holdReasonFor(method),
      fingerprint: fingerprintLines(lines),
    },
  };
};

/** Absolute expiry for a reservation created at `nowMs`. */
export const expiresAtMs = (nowMs: number, ttlSeconds: number): number => nowMs + ttlSeconds * 1000;
