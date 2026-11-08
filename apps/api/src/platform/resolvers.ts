import type { ResourceResolver } from "./decorators.js";

/** The active store of a store-tenant route (membership already proven by PolicyGuard). */
export const activeStore: ResourceResolver = (c) => (c.storeId === undefined ? null : { type: "store", storeId: c.storeId, marketId: c.marketId });

/** Data owned by the caller and keyed by the token subject (no object id in the path, so no BOLA surface). */
export const self: ResourceResolver = (c) => ({ type: "user", ownerUserId: c.userId, marketId: c.marketId });
