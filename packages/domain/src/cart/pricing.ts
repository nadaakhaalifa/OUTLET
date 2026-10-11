import { add, compare, money, type Money } from "../money";
import { InvalidCartInputError } from "./errors";
import type {
  BagLineInput,
  FreeDelivery,
  PriceChange,
  PricedGroup,
  PricedLine,
  StoreTerms,
} from "./types";

export interface PriceBagInput {
  /** Lines in the order the shopper added them; group order follows first appearance. */
  readonly lines: readonly BagLineInput[];
  /** A store missing from the map is treated as not open. */
  readonly stores: ReadonlyMap<string, StoreTerms>;
  readonly platformThreshold: Money;
  readonly plusMember: boolean;
}

const ZERO = (like: Money): Money => money(0n, like.currency);

function assertNonNegative(m: Money, what: string): void {
  if (m.amount < 0n) throw new InvalidCartInputError(`${what} must not be negative`);
}

/** Honest statement about the shopper's own add: never a discount claim. */
export function priceChange(atAdd: Money, current: Money): PriceChange {
  const c = compare(current, atAdd);
  return c < 0 ? "dropped" : c > 0 ? "rose" : "none";
}

export function effectiveThreshold(terms: StoreTerms | undefined, platform: Money): Money {
  const t = terms?.thresholdOverride ?? platform;
  assertNonNegative(t, "free-delivery threshold");
  return t;
}

/**
 * Free-delivery progress for one store. The subtotal is the merchandise subtotal after
 * item-level discounts and before vouchers and store credit (ADR-0010).
 */
export function freeDelivery(subtotal: Money, threshold: Money, plusMember: boolean, storeOpen: boolean): FreeDelivery {
  assertNonNegative(subtotal, "subtotal");
  assertNonNegative(threshold, "threshold");
  const reached = compare(subtotal, threshold) >= 0;
  const unlocked = storeOpen && (plusMember || reached);
  const remaining = unlocked ? ZERO(threshold) : money(threshold.amount - subtotal.amount, threshold.currency);
  return { threshold, remaining: remaining.amount < 0n ? ZERO(threshold) : remaining, unlocked, plusMember };
}

function priceLine(line: BagLineInput, storeOpen: boolean): PricedLine {
  if (!Number.isInteger(line.qty) || line.qty < 1) throw new InvalidCartInputError("qty must be a positive integer");
  assertNonNegative(line.unitPrice, "unit price");
  assertNonNegative(line.priceAtAdd, "price at add");
  return {
    ...line,
    lineTotal: money(line.unitPrice.amount * BigInt(line.qty), line.unitPrice.currency),
    priceChange: priceChange(line.priceAtAdd, line.unitPrice),
    counted: storeOpen && line.state === "IN_BAG" && line.available,
  };
}

/** Pure bag pricing: groups by store, counts only billable lines, computes free-delivery per store. */
export function priceBag(input: PriceBagInput): readonly PricedGroup[] {
  const order: string[] = [];
  const byStore = new Map<string, BagLineInput[]>();
  for (const line of input.lines) {
    const bucket = byStore.get(line.storeId);
    if (bucket === undefined) {
      order.push(line.storeId);
      byStore.set(line.storeId, [line]);
    } else {
      bucket.push(line);
    }
  }
  const zero = ZERO(input.platformThreshold);
  return order.map((storeId): PricedGroup => {
    const terms = input.stores.get(storeId);
    const open = terms?.open === true;
    const lines = (byStore.get(storeId) ?? []).map((l) => priceLine(l, open));
    const subtotal = lines.reduce((acc, l) => (l.counted ? add(acc, l.lineTotal) : acc), zero);
    const fd = freeDelivery(subtotal, effectiveThreshold(terms, input.platformThreshold), input.plusMember, open);
    const billable = open && subtotal.amount > 0n && !fd.unlocked;
    const fee = terms?.standardDeliveryFee ?? zero;
    assertNonNegative(fee, "delivery fee");
    return {
      storeId,
      status: open ? "open" : "locked_store_suspended",
      lines,
      merchandiseSubtotal: subtotal,
      freeDelivery: fd,
      deliveryFee: billable ? fee : zero,
    };
  });
}

export interface ThresholdChange {
  readonly previous: Money;
  readonly current: Money;
}

/** Checkout-time threshold wins; a change versus what the shopper saw at add is surfaced. */
export function thresholdChange(atAdd: Money | null, current: Money): ThresholdChange | null {
  if (atAdd === null) return null;
  return atAdd.amount === current.amount && atAdd.currency === current.currency ? null : { previous: atAdd, current };
}
