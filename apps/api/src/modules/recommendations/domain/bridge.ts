/** Single seam to the pure recommendations domain. Aliases only; no behaviour (see history/domain/bridge.ts). */
import { recommendations as rec } from "@outlet/domain";

export type Candidate = rec.Candidate;
export type ScoredCandidate = rec.ScoredCandidate;
export type Neighbor = rec.Neighbor;
export type UserFeatures = rec.UserFeatures;
export type Rng = rec.Rng;
export type ExplorationStats = rec.ExplorationStats;
export type PriceDrop = rec.PriceDrop;
export type PersonalizationReason = rec.PersonalizationReason;
export const baselineScore = rec.baselineScore;
export const personalScore = rec.personalScore;
export const sortByScore = rec.sortByScore;
export const diversify = rec.diversify;
export const maxExplorationSlots = rec.maxExplorationSlots;
export const pickExploration = rec.pickExploration;
export const mergeExploration = rec.mergeExploration;
export const personalizationDecision = rec.personalizationDecision;
export const isVisible = rec.isVisible;
export const isSimilarForLess = rec.isSimilarForLess;
export const restockDue = rec.restockDue;
export const priceDrops = rec.priceDrops;
export const seededRng = rec.seededRng;
export const cosine = rec.cosine;
export const forbiddenFeatureKeys = rec.forbiddenFeatureKeys;
