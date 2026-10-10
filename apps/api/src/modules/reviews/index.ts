/** Public surface of the reviews module. Other code imports only this file (A2.3). */
export { ReviewsModule, MissingReviewsPortsError, type ReviewsModuleOptions } from "./reviews.module";
export * from "./adapters/tokens";
export {
  FakeImageClassifier,
  FakePhotoUploads,
  FakeProductStore,
  FakePurchaseVerification,
  FakeReviewerProfiles,
  FakeSellerIdentity,
  FakeToxicityClassifier,
  InMemoryReviewStore,
} from "./adapters/in-memory";
export { KyselyReviewStore, type ReviewDb } from "./adapters/kysely-store";
export type { SweepQaSla } from "./application/qa";
export type { ProcessModerationBacklog } from "./application/moderation";
export type {
  ImageClassifierPort,
  PhotoUploadPort,
  ProductStorePort,
  PurchaseVerificationPort,
  ReviewEvent,
  ReviewStore,
  ReviewerProfilePort,
  SellerIdentityPort,
  ToxicityClassifierPort,
} from "./domain/ports";
