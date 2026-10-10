import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { DEFAULT_REVIEW_CONFIG, type ReviewRulesConfig } from "./domain/bridge";
import type {
  ImageClassifierPort,
  PhotoUploadPort,
  ProductStorePort,
  PurchaseVerificationPort,
  ReviewStore,
  ReviewerProfilePort,
  SellerIdentityPort,
  ToxicityClassifierPort,
} from "./domain/ports";
import {
  FakeImageClassifier,
  FakePhotoUploads,
  FakeProductStore,
  FakePurchaseVerification,
  FakeReviewerProfiles,
  FakeSellerIdentity,
  FakeToxicityClassifier,
  InMemoryReviewStore,
} from "./adapters/in-memory";
import {
  ModerationResolver,
  OrderLineResolver,
  OwnReviewResolver,
  StoreListResolver,
  StoreQuestionResolver,
  StoreReviewResolver,
} from "./adapters/resolvers";
import { ReviewsController } from "./adapters/reviews.controller";
import * as T from "./adapters/tokens";
import { DecideModeration, ListModerationQueue, ModerationPipeline, ProcessModerationBacklog } from "./application/moderation";
import { AnswerQuestion, AskQuestion, ListProductQuestions, ListSellerQuestions, SweepQaSla } from "./application/qa";
import { ReportContent } from "./application/reports";
import {
  DeleteReview,
  EditReview,
  ListMyReviews,
  ListProductReviews,
  ListSellerReviews,
  ReplyToReview,
  SubmitReview,
  type ReviewPorts,
} from "./application/reviews";
import type { ReviewDeps } from "./application/shared";

export interface ReviewsModuleOptions {
  readonly config?: ReviewRulesConfig;
  /** Replaces the in-memory store (KyselyReviewStore) once persistence is wired. */
  readonly store?: ReviewStore;
  readonly purchases?: PurchaseVerificationPort;
  readonly sellers?: SellerIdentityPort;
  readonly products?: ProductStorePort;
  readonly profiles?: ReviewerProfilePort;
  readonly photos?: PhotoUploadPort;
  readonly toxicity?: ToxicityClassifierPort;
  readonly images?: ImageClassifierPort;
}

/**
 * Thrown outside test mode when a port owned by another module is missing: reviews must never
 * decide "verified purchase" from an empty fixture, nor publish after a stub classifier.
 */
export class MissingReviewsPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`ReviewsModule requires real ${missing.join(", ")} outside test mode`);
    this.name = "MissingReviewsPortsError";
  }
}

@Module({})
export class ReviewsModule {
  static forRoot(config: AppConfig, o: ReviewsModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && o.store === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing: string[] = [];
      if (o.purchases === undefined) missing.push("purchases (delivered order lines)");
      if (o.sellers === undefined) missing.push("sellers (store membership)");
      if (o.products === undefined) missing.push("products (product to store)");
      if (o.profiles === undefined) missing.push("profiles (first name)");
      if (o.photos === undefined) missing.push("photos (upload ownership)");
      if (o.toxicity === undefined) missing.push("toxicity (AR/EN classifier)");
      if (o.images === undefined) missing.push("images (image classifier)");
      if (missing.length > 0) throw new MissingReviewsPortsError(missing);
    }
    const store = o.store ?? new InMemoryReviewStore();
    const purchases = o.purchases ?? new FakePurchaseVerification();
    const sellers = o.sellers ?? new FakeSellerIdentity();
    const products = o.products ?? new FakeProductStore();
    const profiles = o.profiles ?? new FakeReviewerProfiles();
    const photos = o.photos ?? new FakePhotoUploads();
    const toxicity = o.toxicity ?? new FakeToxicityClassifier();
    const images = o.images ?? new FakeImageClassifier();
    const cfg = o.config ?? DEFAULT_REVIEW_CONFIG;

    const runtime = (clock: Clock, ids: IdGenerator) => {
      const d: ReviewDeps = { store, clock, ids, cfg };
      const ports: ReviewPorts = { purchases, sellers, profiles, photos };
      const pipeline = new ModerationPipeline(d, toxicity, images);
      return {
        submit: new SubmitReview(d, ports, pipeline),
        edit: new EditReview(d, ports, pipeline),
        remove: new DeleteReview(d),
        productReviews: new ListProductReviews(d, profiles),
        myReviews: new ListMyReviews(d),
        sellerReviews: new ListSellerReviews(d, profiles),
        reply: new ReplyToReview(d, pipeline),
        ask: new AskQuestion(d, products, pipeline),
        productQuestions: new ListProductQuestions(d, profiles),
        sellerQuestions: new ListSellerQuestions(d, profiles),
        answer: new AnswerQuestion(d, pipeline),
        sweepSla: new SweepQaSla(d),
        report: new ReportContent(d),
        queue: new ListModerationQueue(d),
        decide: new DecideModeration(d),
        backlog: new ProcessModerationBacklog(d, pipeline),
      };
    };
    const RUNTIME = Symbol("reviews.Runtime");
    type Runtime = ReturnType<typeof runtime>;
    const from = (token: symbol, pick: (r: Runtime) => unknown) => ({
      provide: token,
      inject: [RUNTIME],
      useFactory: (r: Runtime) => pick(r),
    });

    return {
      module: ReviewsModule,
      controllers: [ReviewsController],
      providers: [
        { provide: T.REVIEW_STORE, useValue: store },
        { provide: T.REVIEW_PURCHASES, useValue: purchases },
        { provide: T.REVIEW_SELLERS, useValue: sellers },
        { provide: T.REVIEW_PRODUCTS, useValue: products },
        { provide: T.REVIEW_PROFILES, useValue: profiles },
        { provide: T.REVIEW_PHOTOS, useValue: photos },
        { provide: T.REVIEW_TOXICITY, useValue: toxicity },
        { provide: T.REVIEW_IMAGES, useValue: images },
        { provide: T.REVIEW_ORDER_LINE_RESOLVER, useValue: new OrderLineResolver(purchases) },
        { provide: T.REVIEW_OWN_RESOLVER, useValue: new OwnReviewResolver(store) },
        { provide: T.REVIEW_STORE_RESOLVER, useValue: new StoreReviewResolver(store) },
        { provide: T.REVIEW_STORE_LIST_RESOLVER, useValue: new StoreListResolver() },
        { provide: T.REVIEW_QUESTION_STORE_RESOLVER, useValue: new StoreQuestionResolver(store) },
        { provide: T.REVIEW_MODERATION_RESOLVER, useValue: new ModerationResolver() },
        {
          provide: RUNTIME,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (c: Clock, ids: IdGenerator) => runtime(c, ids),
        },
        from(T.SUBMIT_REVIEW, (r) => r.submit),
        from(T.EDIT_REVIEW, (r) => r.edit),
        from(T.DELETE_REVIEW, (r) => r.remove),
        from(T.LIST_PRODUCT_REVIEWS, (r) => r.productReviews),
        from(T.LIST_MY_REVIEWS, (r) => r.myReviews),
        from(T.LIST_SELLER_REVIEWS, (r) => r.sellerReviews),
        from(T.REPLY_TO_REVIEW, (r) => r.reply),
        from(T.ASK_QUESTION, (r) => r.ask),
        from(T.LIST_PRODUCT_QUESTIONS, (r) => r.productQuestions),
        from(T.LIST_SELLER_QUESTIONS, (r) => r.sellerQuestions),
        from(T.ANSWER_QUESTION, (r) => r.answer),
        from(T.SWEEP_QA_SLA, (r) => r.sweepSla),
        from(T.REPORT_CONTENT, (r) => r.report),
        from(T.LIST_MODERATION_QUEUE, (r) => r.queue),
        from(T.DECIDE_MODERATION, (r) => r.decide),
        from(T.PROCESS_MODERATION_BACKLOG, (r) => r.backlog),
      ],
    };
  }
}
