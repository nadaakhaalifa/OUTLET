import { MAX_CART_LINES, MAX_UNITS_PER_SKU, type LineState } from "./types";

/**
 * Pure bag merge for guest sign-in (ADR-0055, spec guest-browsing section 3).
 *
 * Rules (owner decisions 2026-10-16): lines are united by SKU, a SKU present on both sides keeps the LARGER
 * quantity (never the sum), the bag never exceeds 50 lines or 10 units per SKU, the server's existing lines win
 * the cap, and prices are not an input at all (the caller re-reads them from the catalog). No I/O, no clock.
 */

export const GUEST_MERGE_LIMITS = {
  maxBagLines: MAX_CART_LINES,
  maxUnitsPerSku: MAX_UNITS_PER_SKU,
  maxSavedItems: 200,
  maxViewed: 100,
} as const;

export interface GuestBagLine {
  readonly skuId: string;
  readonly qty: number;
  readonly savedForLater: boolean;
  /** Epoch ms from the device; only an ordering hint for who keeps the last free slots. Never trusted otherwise. */
  readonly addedAtMs: number;
}

export interface ServerBagLine {
  readonly lineId: string;
  readonly skuId: string;
  readonly qty: number;
  readonly state: LineState;
}

/** What the catalog says about a guest SKU right now. */
export type GuestSkuStatus =
  | { readonly kind: "unknown" }
  | { readonly kind: "store_suspended" }
  | { readonly kind: "unavailable"; readonly productId: string }
  | { readonly kind: "ok"; readonly productId: string };

export type MergeLineResult =
  | "added"
  | "qty_raised"
  | "moved_to_bag"
  | "unchanged"
  | "moved_to_saved"
  | "unavailable"
  | "store_suspended"
  | "limit_clamped";

export type MergeReason = "over_cap" | "unavailable";

export interface MergeLineOutcome {
  readonly skuId: string;
  readonly result: MergeLineResult;
  readonly reason: MergeReason | null;
  /** Quantity on the server after the merge; null when the line is not in the bag. */
  readonly qty: number | null;
  /** Quantity the server already held, null when it held none. */
  readonly previousQty: number | null;
}

export interface PlannedBagLine {
  readonly skuId: string;
  readonly qty: number;
  readonly state: LineState;
  /** Null for a line that does not exist yet. */
  readonly existingLineId: string | null;
  /** True when the caller must write this line (new, or its quantity / state changed). */
  readonly touched: boolean;
}

export interface SavedCandidate {
  readonly productId: string;
  readonly skuId: string;
  readonly reason: MergeReason;
}

export interface BagMergePlan {
  /** The complete bag after the merge: untouched server lines, changed lines and new lines. */
  readonly lines: readonly PlannedBagLine[];
  /** One outcome per distinct guest SKU, in processing order. */
  readonly outcomes: readonly MergeLineOutcome[];
  /** Products that move to Saved (over the cap, or unavailable). Deduplicated by product and SKU. */
  readonly toSaved: readonly SavedCandidate[];
}

interface NormalisedGuestLine {
  readonly skuId: string;
  readonly qty: number;
  readonly savedForLater: boolean;
  readonly addedAtMs: number;
  readonly clamped: boolean;
}

/** One entry per SKU: largest quantity, "in bag" wins over "saved", earliest add time. Order-independent. */
function normalise(guest: readonly GuestBagLine[]): NormalisedGuestLine[] {
  const bySku = new Map<string, NormalisedGuestLine>();
  for (const g of guest) {
    const clamped = g.qty > MAX_UNITS_PER_SKU;
    const qty = Math.min(Math.max(1, Math.trunc(g.qty)), MAX_UNITS_PER_SKU);
    const cur = bySku.get(g.skuId);
    bySku.set(
      g.skuId,
      cur === undefined
        ? { skuId: g.skuId, qty, savedForLater: g.savedForLater, addedAtMs: g.addedAtMs, clamped }
        : {
            skuId: g.skuId,
            qty: Math.max(cur.qty, qty),
            savedForLater: cur.savedForLater && g.savedForLater,
            addedAtMs: Math.min(cur.addedAtMs, g.addedAtMs),
            clamped: cur.clamped || clamped,
          },
    );
  }
  return [...bySku.values()].sort((a, b) => a.addedAtMs - b.addedAtMs || (a.skuId < b.skuId ? -1 : a.skuId > b.skuId ? 1 : 0));
}

export function planGuestBagMerge(
  server: readonly ServerBagLine[],
  guest: readonly GuestBagLine[],
  statusOf: (skuId: string) => GuestSkuStatus,
): BagMergePlan {
  const planned = new Map<string, PlannedBagLine>(
    server.map((l) => [l.skuId, { skuId: l.skuId, qty: l.qty, state: l.state, existingLineId: l.lineId, touched: false }]),
  );
  const outcomes: MergeLineOutcome[] = [];
  const toSaved = new Map<string, SavedCandidate>();
  const save = (productId: string, skuId: string, reason: MergeReason): void => {
    toSaved.set(`${productId}|${skuId}`, { productId, skuId, reason });
  };

  for (const g of normalise(guest)) {
    const status = statusOf(g.skuId);
    const held = planned.get(g.skuId);
    const previousQty = held?.qty ?? null;
    const outcome = (result: MergeLineResult, reason: MergeReason | null, qty: number | null): void => {
      outcomes.push({ skuId: g.skuId, result: g.clamped && result === "added" ? "limit_clamped" : result, reason, qty, previousQty });
    };

    if (status.kind === "unknown") {
      outcome("unavailable", "unavailable", held?.qty ?? null);
      continue;
    }
    if (status.kind === "store_suspended") {
      outcome("store_suspended", null, held?.qty ?? null);
      continue;
    }
    if (status.kind === "unavailable") {
      save(status.productId, g.skuId, "unavailable");
      outcome("unavailable", "unavailable", held?.qty ?? null);
      continue;
    }

    if (held !== undefined) {
      const qty = Math.max(held.qty, g.qty);
      const state: LineState = g.savedForLater ? held.state : "IN_BAG";
      if (qty === held.qty && state === held.state) {
        outcome("unchanged", null, held.qty);
        continue;
      }
      planned.set(g.skuId, { ...held, qty, state, touched: true });
      outcome(qty > held.qty ? "qty_raised" : held.state !== state ? "moved_to_bag" : "added", null, qty);
      continue;
    }

    if (planned.size >= MAX_CART_LINES) {
      save(status.productId, g.skuId, "over_cap");
      outcome("moved_to_saved", "over_cap", null);
      continue;
    }
    planned.set(g.skuId, {
      skuId: g.skuId,
      qty: g.qty,
      state: g.savedForLater ? "SAVED_FOR_LATER" : "IN_BAG",
      existingLineId: null,
      touched: true,
    });
    outcome("added", null, g.qty);
  }

  return { lines: [...planned.values()], outcomes, toSaved: [...toSaved.values()] };
}
