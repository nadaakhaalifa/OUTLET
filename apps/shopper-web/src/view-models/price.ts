import type { PriceBlock, PriceEvidence } from "./types";

export type BadgeKind = "verified_discount" | "lowest_30d" | "launch_price" | "none";

export interface PriceView {
  /** Current selling price, integer piastres. */
  readonly amount: bigint;
  readonly badge: BadgeKind;
  /** Present ONLY for a verified claim (spec 9): reference price and integer percent. */
  readonly claim: { readonly reference: bigint; readonly pct: number } | null;
}

const toBig = (s: string): bigint | null => (/^-?[0-9]{1,18}$/.test(s) ? BigInt(s) : null);

/**
 * Honest price display. A strike-through / "% off" exists only when ALL hold:
 * the API block says verified_discount with a claim id, reference price and percent; the reference is higher than the
 * price; the percent equals floor((ref-price)*100/ref) (integer math, spec 9.3); and, where evidence was fetched,
 * the evidence summary agrees (display_kind verified_discount). Anything else fails closed to the plain price.
 * `evidence`: undefined = not fetched (listing cards), null = fetch failed (fail closed).
 */
export function priceView(block: PriceBlock, evidence: PriceEvidence | null | undefined): PriceView {
  const amount = toBig(block.price.amount) ?? 0n;
  const plain: PriceView = { amount, badge: "none", claim: null };
  if (evidence === null) return plain;
  if (block.badge === "lowest_30d" || block.badge === "launch_price") {
    if (evidence !== undefined && evidence.display_kind !== block.badge) return plain;
    return { amount, badge: block.badge, claim: null };
  }
  if (block.badge !== "verified_discount") return plain;
  const ref = block.reference_price === null || block.reference_price === undefined ? null : toBig(block.reference_price.amount);
  const pct = block.discount_pct;
  if (ref === null || pct === null || pct === undefined || block.claim_id === null || block.claim_id === undefined) return plain;
  if (ref <= 0n || ref <= amount) return plain;
  if ((ref - amount) * 100n / ref !== BigInt(pct) || pct < 5) return plain;
  if (evidence !== undefined && evidence.display_kind !== "verified_discount") return plain;
  return { amount, badge: "verified_discount", claim: { reference: ref, pct } };
}
