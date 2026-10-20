/** Single seam to the pure SSRF and politeness rules shared with the price crawler (packages/domain/src/price-matching). */
import { priceMatching as pm } from "@outlet/domain";

export const {
  DomainPacer,
  MAX_RESPONSE_BYTES,
  MIN_REQUEST_GAP_MS,
  assertResolvedPublic,
  breakerCanAttempt,
  breakerOnFailure,
  breakerOnSuccess,
  connectedAddressMatches,
  isPlausiblePublicDomain,
  validateEgressUrl,
} = pm;
export type DomainPacer = pm.DomainPacer;
