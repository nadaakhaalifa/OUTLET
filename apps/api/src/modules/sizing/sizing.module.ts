import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import {
  DevAesGcmFieldCipher,
  InMemoryDemandRepository,
  InMemoryFeedbackRepository,
  InMemoryFitCatalog,
  InMemoryMeasurementsConsent,
  InMemoryOrderLines,
  InMemorySizeChartRepository,
  InMemorySizeProfileRepository,
  InMemorySizingEventLog,
  SizingStoreResolver,
} from "./adapters/in-memory";
import type {
  DemandRepository,
  FeedbackRepository,
  FieldCipherPort,
  FitCatalogPort,
  MeasurementsConsentPort,
  OrderLineFitPort,
  SizeChartRepository,
  SizeProfileRepository,
  SizingEventPublisher,
} from "./domain/ports";
import { SizingController } from "./adapters/sizing.controller";
import {
  CREATE_SIZE_CHART,
  CREATE_SIZE_PROFILE,
  DELETE_SIZE_PROFILE,
  FIELD_CIPHER,
  FIT_CATALOG,
  FIT_FEEDBACK_REPOSITORY,
  GET_SIZE_DEMAND,
  GET_SIZE_PROFILE,
  LIST_SIZE_CHARTS,
  LIST_SIZE_PROFILES,
  MEASUREMENTS_CONSENT,
  ORDER_LINE_FIT,
  RECOMMEND_FIT,
  SIZE_CHART_REPOSITORY,
  SIZE_DEMAND_REPOSITORY,
  SIZE_PROFILE_REPOSITORY,
  SIZING_EVENTS,
  SIZING_STORE_RESOLVER,
  SUBMIT_FIT_FEEDBACK,
  UPDATE_SIZE_PROFILE,
} from "./adapters/tokens";
import { CreateSizeChart, GetSizeDemand, ListSizeCharts } from "./application/charts";
import { ProfileCodec } from "./application/codec";
import { SubmitFitFeedback } from "./application/feedback";
import {
  CreateSizeProfile,
  DeleteSizeProfile,
  GetSizeProfile,
  ListSizeProfiles,
  UpdateSizeProfile,
} from "./application/profiles";
import { RecommendFit } from "./application/recommend";

const CODEC = Symbol("sizing.ProfileCodec");

export interface SizingModuleOptions {
  /** Postgres repositories (KyselySizing*). Omitted means the in-memory fixtures. */
  readonly repositories?: {
    readonly profiles: SizeProfileRepository;
    readonly charts: SizeChartRepository;
    readonly feedback: FeedbackRepository;
    readonly demand: DemandRepository;
  };
  /**
   * Required when config.adapters is "production". The cipher is the KMS envelope cipher; there is
   * NO default, so a production boot without one throws and the dev AES key can never be reached.
   */
  readonly production?: {
    readonly cipher: FieldCipherPort;
    readonly consent: MeasurementsConsentPort;
    readonly fitCatalog: FitCatalogPort;
    readonly orderLines: OrderLineFitPort;
    readonly events: SizingEventPublisher;
  };
}

@Module({})
export class SizingModule {
  static forRoot(config: AppConfig, options: SizingModuleOptions = {}): DynamicModule {
    const prod = options.production;
    if (config.adapters !== "in-memory-dev" && (prod === undefined || options.repositories === undefined)) {
      throw new NoProductionAdaptersError();
    }
    // The dev cipher exists only on the in-memory-dev branch; production never falls back to it.
    const dev = config.adapters === "in-memory-dev" ? { cipher: new DevAesGcmFieldCipher() } : null;
    const cipher: FieldCipherPort | undefined = prod?.cipher ?? dev?.cipher;
    if (cipher === undefined) throw new NoProductionAdaptersError();
    return {
      module: SizingModule,
      controllers: [SizingController],
      providers: [
        { provide: SIZE_PROFILE_REPOSITORY, useValue: options.repositories?.profiles ?? new InMemorySizeProfileRepository() },
        { provide: SIZE_CHART_REPOSITORY, useValue: options.repositories?.charts ?? new InMemorySizeChartRepository() },
        { provide: FIT_FEEDBACK_REPOSITORY, useValue: options.repositories?.feedback ?? new InMemoryFeedbackRepository() },
        { provide: SIZE_DEMAND_REPOSITORY, useValue: options.repositories?.demand ?? new InMemoryDemandRepository() },
        { provide: FIELD_CIPHER, useValue: cipher },
        { provide: MEASUREMENTS_CONSENT, useValue: prod?.consent ?? new InMemoryMeasurementsConsent() },
        { provide: FIT_CATALOG, useValue: prod?.fitCatalog ?? new InMemoryFitCatalog() },
        { provide: ORDER_LINE_FIT, useValue: prod?.orderLines ?? new InMemoryOrderLines() },
        { provide: SIZING_EVENTS, useValue: prod?.events ?? new InMemorySizingEventLog() },
        { provide: SIZING_STORE_RESOLVER, useValue: new SizingStoreResolver() },
        { provide: CODEC, inject: [FIELD_CIPHER], useFactory: (c: FieldCipherPort) => new ProfileCodec(c) },
        {
          provide: CREATE_SIZE_PROFILE,
          inject: [SIZE_PROFILE_REPOSITORY, CODEC, MEASUREMENTS_CONSENT, SIZING_EVENTS, CLOCK, ID_GENERATOR],
          useFactory: (
            r: SizeProfileRepository,
            c: ProfileCodec,
            consent: MeasurementsConsentPort,
            ev: SizingEventPublisher,
            clock: Clock,
            ids: IdGenerator,
          ) => new CreateSizeProfile(r, c, consent, ev, clock, ids),
        },
        {
          provide: LIST_SIZE_PROFILES,
          inject: [SIZE_PROFILE_REPOSITORY, CODEC],
          useFactory: (r: SizeProfileRepository, c: ProfileCodec) => new ListSizeProfiles(r, c),
        },
        {
          provide: GET_SIZE_PROFILE,
          inject: [SIZE_PROFILE_REPOSITORY, CODEC],
          useFactory: (r: SizeProfileRepository, c: ProfileCodec) => new GetSizeProfile(r, c),
        },
        {
          provide: UPDATE_SIZE_PROFILE,
          inject: [SIZE_PROFILE_REPOSITORY, CODEC, MEASUREMENTS_CONSENT, SIZING_EVENTS, CLOCK],
          useFactory: (
            r: SizeProfileRepository,
            c: ProfileCodec,
            consent: MeasurementsConsentPort,
            ev: SizingEventPublisher,
            clock: Clock,
          ) => new UpdateSizeProfile(r, c, consent, ev, clock),
        },
        {
          provide: DELETE_SIZE_PROFILE,
          inject: [SIZE_PROFILE_REPOSITORY, FIT_FEEDBACK_REPOSITORY, SIZING_EVENTS],
          useFactory: (r: SizeProfileRepository, f: FeedbackRepository, ev: SizingEventPublisher) =>
            new DeleteSizeProfile(r, f, ev),
        },
        {
          provide: RECOMMEND_FIT,
          inject: [
            SIZE_PROFILE_REPOSITORY,
            CODEC,
            MEASUREMENTS_CONSENT,
            FIT_CATALOG,
            SIZE_CHART_REPOSITORY,
            FIT_FEEDBACK_REPOSITORY,
            SIZE_DEMAND_REPOSITORY,
            SIZING_EVENTS,
            CLOCK,
          ],
          useFactory: (
            p: SizeProfileRepository,
            codec: ProfileCodec,
            consent: MeasurementsConsentPort,
            cat: FitCatalogPort,
            charts: SizeChartRepository,
            fb: FeedbackRepository,
            demand: DemandRepository,
            ev: SizingEventPublisher,
            clock: Clock,
          ) => new RecommendFit(p, codec, consent, cat, charts, fb, demand, ev, clock),
        },
        {
          provide: SUBMIT_FIT_FEEDBACK,
          inject: [ORDER_LINE_FIT, FIT_FEEDBACK_REPOSITORY, SIZE_PROFILE_REPOSITORY, SIZING_EVENTS, CLOCK, ID_GENERATOR],
          useFactory: (
            lines: OrderLineFitPort,
            fb: FeedbackRepository,
            p: SizeProfileRepository,
            ev: SizingEventPublisher,
            clock: Clock,
            ids: IdGenerator,
          ) => new SubmitFitFeedback(lines, fb, p, ev, clock, ids),
        },
        {
          provide: CREATE_SIZE_CHART,
          inject: [SIZE_CHART_REPOSITORY, SIZING_EVENTS, CLOCK, ID_GENERATOR],
          useFactory: (r: SizeChartRepository, ev: SizingEventPublisher, clock: Clock, ids: IdGenerator) =>
            new CreateSizeChart(r, ev, clock, ids),
        },
        {
          provide: LIST_SIZE_CHARTS,
          inject: [SIZE_CHART_REPOSITORY],
          useFactory: (r: SizeChartRepository) => new ListSizeCharts(r),
        },
        {
          provide: GET_SIZE_DEMAND,
          inject: [SIZE_DEMAND_REPOSITORY],
          useFactory: (r: DemandRepository) => new GetSizeDemand(r),
        },
      ],
    };
  }
}
