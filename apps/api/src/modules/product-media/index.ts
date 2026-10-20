/** Public surface of the product-media module (A2.3). Other code imports only this file. */
export { ProductMediaModule, MissingProductMediaPortsError, type ProductMediaModuleOptions } from "./product-media.module";
export * from "./adapters/tokens";
export {
  DenyCrossBorderConsent,
  FakeBackgroundRemoval,
  FakeProductMediaBlobs,
  InMemoryProductMediaStore,
  StaticProductMediaFlags,
} from "./adapters/in-memory";
export { KyselyProductMediaStore, type ProductMediaDb } from "./adapters/kysely-store";
export { RembgHttpBackgroundRemoval, type RembgHttpOptions } from "./adapters/rembg-http";
export { UnconfiguredBackgroundRemoval, UnconfiguredProductMediaBlobs } from "./adapters/unconfigured";
export { DEFAULT_PRODUCT_MEDIA_CONFIG, type ProductMediaConfig } from "./application/shared";
export { assessQuality, READY_THRESHOLD, type QualityAssessment } from "./domain/quality";
export { TRANSITIONS, assertTransition, InvalidTransitionError } from "./domain/machine";
export * from "./domain/ports";
export { ProductImageLinker, type ClaimImageResult, type LinkedProductImage } from "./application/catalog-link";
