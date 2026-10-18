/** Narrow read/write surface for screens (G2..G5). GuestStore implements it. */
import type { GuestStore } from "./store";
export type GuestStorePort = Pick<GuestStore,
  "hydrate" | "getState" | "subscribe" | "addToBag" | "setQty" | "removeLine" | "setLineSavedForLater" | "save" | "unsave" | "view" | "like" | "clearHistory" | "watch" | "setCoolOff" | "setHistoryPaused" | "unwatch" | "watches" |
  "setConsentBanner" | "setMergePending" | "removeMerged" | "completeMerge" | "clearAll" | "flush" | "consumeResetNotice" | "isReadOnly" | "isPersisting">;
