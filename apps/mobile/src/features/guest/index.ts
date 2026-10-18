export * from "./schema";
export * from "./model";
export * from "./affinity";
export * from "./storage";
export { GuestStore, type AddToBagInput, type GuestResult, type ResetCause } from "./store";
export type { GuestStorePort } from "./port";
export { SqliteGuestStorage, expoSqliteOpener, GUEST_DB_NAME } from "./sqlite-storage";
/** The Bag and Saved empty states must tell guests their data lives on this phone only (spec E7). Strings to add by the i18n owner: guest.localOnlyNote. */
export const GUEST_LOCAL_ONLY_NOTICE = { uninstallLosesData: true, i18nKey: "guest.localOnlyNote" } as const;
export {
  buildMergePayload, hasMergeWork, runGuestMerge, summarizeMerge,
  type MergeDeps, type MergeHttpResult, type MergeNote, type MergeNoteKind, type MergeOutcome, type MergePayload, type MergeSummary, type MergeTransport,
} from "./merge";
export { ApiMergeTransport } from "./merge-api";
export { newMergeKey } from "./merge-key";
export { isGuestSession, readGuestSignals, withGuestStore } from "./signals";
export { GUEST_SIZE_PROFILE_KEY, onSignedOut, wipeGuestData } from "./session";
export { noteText } from "./merge-notes";
