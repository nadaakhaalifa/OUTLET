export interface VerifiedClaim {
  /** Verified Reference Price in integer piastres (spec §9). */
  readonly referenceMinor: bigint;
  /** Integer percent computed server-side. */
  readonly percent: number;
  readonly verified: boolean;
}

export type PriceView =
  | { readonly kind: "plain" }
  | { readonly kind: "launch" }
  | { readonly kind: "claim"; readonly percent: number };

/** Minimum percent a claim may show (spec §9.3 claim_allowed). */
export const MIN_CLAIM_PERCENT = 5;

/**
 * A strike-through and percent appear only for a verified claim that is arithmetically consistent:
 * reference > price and percent === floor((ref - price) * 100 / ref) and percent >= 5. Anything else is plain.
 */
export function isValidClaim(priceMinor: bigint, claim: VerifiedClaim | undefined | null): claim is VerifiedClaim {
  if (!claim || claim.verified !== true) return false;
  if (claim.referenceMinor <= 0n || priceMinor < 0n || claim.referenceMinor <= priceMinor) return false;
  if (!Number.isInteger(claim.percent) || claim.percent < MIN_CLAIM_PERCENT) return false;
  const expected = ((claim.referenceMinor - priceMinor) * 100n) / claim.referenceMinor;
  return BigInt(claim.percent) === expected;
}

export function priceView(priceMinor: bigint, claim: VerifiedClaim | undefined | null, launch: boolean): PriceView {
  if (isValidClaim(priceMinor, claim)) return { kind: "claim", percent: claim.percent };
  return launch ? { kind: "launch" } : { kind: "plain" };
}
