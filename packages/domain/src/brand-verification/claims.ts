/** Duplicate / conflicting brand-claim detection and priority (ADR-0031 decision 7). Pure. */
import { SAME_NAME_THRESHOLD, SIMILAR_NAME_THRESHOLD, compareNormalisedNames, normaliseBrandName } from "./name";
import type { BrandKind } from "./policy";

export interface ClaimView {
  readonly applicationId: string;
  readonly applicantId: string;
  readonly kind: BrandKind;
  readonly country: string;
  readonly brandNameNorm: string;
  /** Verified registrable domain, or null. */
  readonly domain: string | null;
  /** "OFFICE:number" upper-cased, or null. */
  readonly trademarkKey: string | null;
  readonly domainVerifiedAtMs: number | null;
  readonly trademarkMatchedAtMs: number | null;
  readonly submittedAtMs: number | null;
}

export type ConflictReason = "same_name" | "similar_name" | "same_domain" | "same_trademark";
export interface ConflictFinding {
  readonly otherApplicationId: string;
  readonly reasons: readonly ConflictReason[];
  readonly nameScore: number;
}

export const trademarkKeyOf = (office: string, number: string): string => `${office.toUpperCase()}:${number.replace(/[\s-]+/g, "").toUpperCase()}`;
export const claimNameNorm = (brandName: string): string => normaliseBrandName(brandName);

/** Another application of the SAME applicant is never a conflict. Results sorted by application id. */
export function detectClaimConflicts(candidate: ClaimView, others: readonly ClaimView[]): readonly ConflictFinding[] {
  const out: ConflictFinding[] = [];
  for (const o of others) {
    if (o.applicationId === candidate.applicationId || o.applicantId === candidate.applicantId) continue;
    const reasons: ConflictReason[] = [];
    const cmp = compareNormalisedNames(candidate.brandNameNorm, o.brandNameNorm);
    if (candidate.country === o.country) {
      if (cmp.score >= SAME_NAME_THRESHOLD) reasons.push("same_name");
      else if (cmp.score >= SIMILAR_NAME_THRESHOLD) reasons.push("similar_name");
    }
    if (candidate.domain !== null && candidate.domain === o.domain) reasons.push("same_domain");
    if (candidate.trademarkKey !== null && candidate.trademarkKey === o.trademarkKey) reasons.push("same_trademark");
    if (reasons.length > 0) out.push({ otherApplicationId: o.applicationId, reasons, nameScore: cmp.score });
  }
  return out.sort((a, b) => (a.otherApplicationId < b.otherApplicationId ? -1 : 1));
}

/** Verified claims outrank unverified; then earliest evidence; then submitted_at; then id (total order). */
export function claimPriorityKey(c: ClaimView): readonly [number, number, string] {
  const evidence = [c.domainVerifiedAtMs, c.trademarkMatchedAtMs].filter((x): x is number => x !== null);
  if (evidence.length > 0) return [0, Math.min(...evidence), c.applicationId];
  return [1, c.submittedAtMs ?? Number.MAX_SAFE_INTEGER, c.applicationId];
}

export function orderByPriority(claims: readonly ClaimView[]): readonly ClaimView[] {
  return [...claims].sort((a, b) => {
    const ka = claimPriorityKey(a);
    const kb = claimPriorityKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || (ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0);
  });
}

export const CONFLICT_OUTCOMES = ["keep_first", "replace_with_this", "both_valid", "reject_all"] as const;
export type ConflictOutcome = (typeof CONFLICT_OUTCOMES)[number];
