export const HISTORY_STORE = Symbol("history.HistoryStore");
export const HISTORY_CONSENT = Symbol("history.PersonalizationConsentPort");
export const HISTORY_PRODUCTS = Symbol("history.ProductLookupPort");
export const HISTORY_FLAGS = Symbol("history.FlagPort");

export const RECORD_HISTORY_EVENT = Symbol("history.RecordHistoryEvent");
export const LIST_HISTORY = Symbol("history.ListHistory");
export const CLEAR_HISTORY = Symbol("history.ClearHistory");
export const SET_HISTORY_PAUSED = Symbol("history.SetHistoryPaused");
export const SET_PERSONALIZATION = Symbol("history.SetPersonalization");
export const RECORD_PRODUCT_VIEW = Symbol("history.RecordProductView");
export const LIST_RECENTLY_VIEWED = Symbol("history.ListRecentlyViewed");
export const BUILD_USER_FEATURES = Symbol("history.BuildUserFeatures");
export const REBUILD_FEATURES_BATCH = Symbol("history.RebuildFeaturesBatch");
export const SWEEP_CLEAR_REQUESTS = Symbol("history.SweepClearRequests");
export const PURGE_EXPIRED_EVENTS = Symbol("history.PurgeExpiredEvents");
