/**
 * Single seam to the pure recommendations domain (packages/domain/src/recommendations).
 * Aliases only; no behaviour. The integrator exposes the same code as `recommendations` from
 * @outlet/domain (packages/domain/src/index.ts is not editable by this module's owner), after which
 * this import can switch to the namespace form used by the other modules.
 */
import { recommendations as rec } from "@outlet/domain";

export type HistoryEvent = rec.HistoryEvent;
export type HistoryEventType = rec.HistoryEventType;
export type RecentlyViewed = rec.RecentlyViewed;
export type UserFeatures = rec.UserFeatures;
export const HISTORY_EVENT_TYPES = rec.HISTORY_EVENT_TYPES;
export const RECENTLY_VIEWED_CAP = rec.RECENTLY_VIEWED_CAP;
export const buildFeatures = rec.buildFeatures;
export const clearDeadline = rec.clearDeadline;
export const forbiddenFeatureKeys = rec.forbiddenFeatureKeys;
export const isClearOverdue = rec.isClearOverdue;
export const normalizeDetail = rec.normalizeDetail;
export const recordDecision = rec.recordDecision;
export const retentionCutoffMs = rec.retentionCutoffMs;
export const upsertRecentlyViewed = rec.upsertRecentlyViewed;
export const featuresAreFresh = rec.featuresAreFresh;
export const DETAIL_MAX = rec.DETAIL_MAX;
