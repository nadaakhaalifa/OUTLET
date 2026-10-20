/** Public surface of the visual-search module (A2.3). Other code imports only this file. */
export { VisualSearchModule, type VisualSearchModuleOptions } from "./visual-search.module";
export * from "./adapters/tokens";
export {
  EMBED_DIM,
  FAKE_MODEL_VERSION,
  FakeFaceDetector,
  FakeImageEmbedder,
  FakeImageSafety,
  FakeQueryImageStore,
  FakeShopperContext,
  FakeVisualCatalog,
  FakeVisualConsent,
  InMemoryVisualIndex,
  InMemoryVisualMetrics,
  InMemoryVisualStore,
  NoFaceDetector,
  StaticVisualFlags,
  UnconfiguredImageEmbedder,
  UnconfiguredImageSafety,
  UnconfiguredQueryImageStore,
  seededUnitVector,
} from "./adapters/in-memory";
export { KyselyVisualIndex, KyselyVisualStore, type KyselyVisualIndexOptions, type VisualDb } from "./adapters/kysely-store";
export type { IssueQueryUpload, SearchByImage, SimilarByProduct, SweepVisualSearch } from "./application/visual-search";
export { evaluateRetrieval } from "./eval/harness";
export type * from "./domain/ports";

/** Pure image-bytes helpers (sniff, dimension cap, metadata strip), reused by product-media. */
export { sanitizeImage, sniff as sniffImage, type Sanitized as SanitizedImage } from "./domain/image";
