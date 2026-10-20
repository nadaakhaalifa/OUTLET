/** Public surface of the wardrobe module (A2.3). Other code imports only this file. */
export { WardrobeModule, MissingWardrobePortsError, type WardrobeModuleOptions } from "./wardrobe.module";
export * from "./adapters/tokens";
export { FakeConsent, FakeVision, FakeWardrobeImages, InMemoryWardrobeStore, StaticWardrobeFlags } from "./adapters/in-memory";
export { KyselyWardrobeStore, type WardrobeDb } from "./adapters/kysely-store";
export { UnconfiguredVision, UnconfiguredWardrobeImages } from "./adapters/unconfigured";
export { DEFAULT_WARDROBE_CONFIG, FLAG_WARDROBE, FLAG_WARDROBE_VISION, type WardrobeConfig } from "./application/shared";
export type { SuggestOwnedSlots, CompleteFromWardrobe } from "./application/complete";
export type {
  AttributeSuggestion,
  VisionAttributePort,
  WardrobeConsentPort,
  WardrobeFlagPort,
  WardrobeImageStorePort,
  WardrobeItem,
  WardrobeStore,
} from "./domain/ports";
