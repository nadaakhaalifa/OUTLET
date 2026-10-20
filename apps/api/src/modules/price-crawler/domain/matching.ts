/**
 * Single seam to the pure price-matching domain (packages/domain/src/price-matching). Aliases and
 * re-exports only, no behaviour (ADR-0018).
 */
import { priceMatching as pm } from "@outlet/domain";

export const {
  BREAKER_CLOSED,
  DEFAULT_TAU_BP,
  DomainPacer,
  EVIDENCE_STALE_MS,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  MIN_REQUEST_GAP_MS,
  MS_PER_DAY,
  ROBOTS_CACHE_MS,
  SNAPSHOT_WINDOW_DAYS,
  assertResolvedPublic,
  backoffMs,
  breakerCanAttempt,
  breakerOnFailure,
  breakerOnSuccess,
  chooseTau,
  cohenKappaMilli,
  connectedAddressMatches,
  deriveExternalEvidence,
  gateEvidence,
  isEvidenceStale,
  isPathAllowed,
  isPlausiblePublicDomain,
  labelledSetReady,
  robotsFromFetch,
  scoreMatch,
  shouldStoreSnapshot,
  snapshotDelta,
  validateEgressUrl,
  validateRedirect,
} = pm;
export type DomainPacer = pm.DomainPacer;
export type AttributeVerdict = pm.AttributeVerdict;
export type BreakerState = pm.BreakerState;
export type EgressTarget = pm.EgressTarget;
export type EvidenceGate = pm.EvidenceGate;
export type MatchMethod = pm.MatchMethod;
export type MatchScore = pm.MatchScore;
export type PriceSnapshot = pm.PriceSnapshot;
export type ProductFingerprint = pm.ProductFingerprint;
export type UrlRejection = pm.UrlRejection;
