/** Public surface of the guest-merge module (A2.3). Other code imports only this file. */
export { GuestMergeModule, type GuestMergeModuleOverrides } from "./guest-merge.module";
export { KyselyGuestMergeUnitOfWork, type GuestMergeDb } from "./adapters/kysely-uow";
export { InMemoryGuestMergeUnitOfWork, InMemoryRecentlyViewedWriter, StaticPersonalizationConsent } from "./adapters/in-memory";
export { GUEST_MERGE_UOW, MERGE_GUEST } from "./adapters/tokens";
export type { GuestMergedEvent, GuestMergeUnitOfWork, MergeTx } from "./domain/ports";
