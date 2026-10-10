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

@Module({})
export class SizingModule {
  static forRoot(config: AppConfig): DynamicModule {
    if (config.adapters !== "in-memory-dev") throw new NoProductionAdaptersError();
    return {
      module: SizingModule,
      controllers: [SizingController],
      providers: [
        { provide: SIZE_PROFILE_REPOSITORY, useValue: new InMemorySizeProfileRepository() },
        { provide: SIZE_CHART_REPOSITORY, useValue: new InMemorySizeChartRepository() },
        { provide: FIT_FEEDBACK_REPOSITORY, useValue: new InMemoryFeedbackRepository() },
        { provide: SIZE_DEMAND_REPOSITORY, useValue: new InMemoryDemandRepository() },
        { provide: FIELD_CIPHER, useValue: new DevAesGcmFieldCipher() },
        { provide: MEASUREMENTS_CONSENT, useValue: new InMemoryMeasurementsConsent() },
        { provide: FIT_CATALOG, useValue: new InMemoryFitCatalog() },
        { provide: ORDER_LINE_FIT, useValue: new InMemoryOrderLines() },
        { provide: SIZING_EVENTS, useValue: new InMemorySizingEventLog() },
        { provide: SIZING_STORE_RESOLVER, useValue: new SizingStoreResolver() },
        { provide: CODEC, inject: [FIELD_CIPHER], useFactory: (c: DevAesGcmFieldCipher) => new ProfileCodec(c) },
        {
          provide: CREATE_SIZE_PROFILE,
          inject: [SIZE_PROFILE_REPOSITORY, CODEC, MEASUREMENTS_CONSENT, SIZING_EVENTS, CLOCK, ID_GENERATOR],
          useFactory: (
            r: InMemorySizeProfileRepository,
            c: ProfileCodec,
            consent: InMemoryMeasurementsConsent,
            ev: InMemorySizingEventLog,
            clock: Clock,
            ids: IdGenerator,
          ) => new CreateSizeProfile(r, c, consent, ev, clock, ids),
        },
        {
          provide: LIST_SIZE_PROFILES,
          inject: [SIZE_PROFILE_REPOSITORY, CODEC],
          useFactory: (r: InMemorySizeProfileRepository, c: ProfileCodec) => new ListSizeProfiles(r, c),
        },
        {
          provide: GET_SIZE_PROFILE,
          inject: [SIZE_PROFILE_REPOSITORY, CODEC],
          useFactory: (r: InMemorySizeProfileRepository, c: ProfileCodec) => new GetSizeProfile(r, c),
        },
        {
          provide: UPDATE_SIZE_PROFILE,
          inject: [SIZE_PROFILE_REPOSITORY, CODEC, MEASUREMENTS_CONSENT, SIZING_EVENTS, CLOCK],
          useFactory: (
            r: InMemorySizeProfileRepository,
            c: ProfileCodec,
            consent: InMemoryMeasurementsConsent,
            ev: InMemorySizingEventLog,
            clock: Clock,
          ) => new UpdateSizeProfile(r, c, consent, ev, clock),
        },
        {
          provide: DELETE_SIZE_PROFILE,
          inject: [SIZE_PROFILE_REPOSITORY, FIT_FEEDBACK_REPOSITORY, SIZING_EVENTS],
          useFactory: (r: InMemorySizeProfileRepository, f: InMemoryFeedbackRepository, ev: InMemorySizingEventLog) =>
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
            p: InMemorySizeProfileRepository,
            codec: ProfileCodec,
            consent: InMemoryMeasurementsConsent,
            cat: InMemoryFitCatalog,
            charts: InMemorySizeChartRepository,
            fb: InMemoryFeedbackRepository,
            demand: InMemoryDemandRepository,
            ev: InMemorySizingEventLog,
            clock: Clock,
          ) => new RecommendFit(p, codec, consent, cat, charts, fb, demand, ev, clock),
        },
        {
          provide: SUBMIT_FIT_FEEDBACK,
          inject: [ORDER_LINE_FIT, FIT_FEEDBACK_REPOSITORY, SIZE_PROFILE_REPOSITORY, SIZING_EVENTS, CLOCK, ID_GENERATOR],
          useFactory: (
            lines: InMemoryOrderLines,
            fb: InMemoryFeedbackRepository,
            p: InMemorySizeProfileRepository,
            ev: InMemorySizingEventLog,
            clock: Clock,
            ids: IdGenerator,
          ) => new SubmitFitFeedback(lines, fb, p, ev, clock, ids),
        },
        {
          provide: CREATE_SIZE_CHART,
          inject: [SIZE_CHART_REPOSITORY, SIZING_EVENTS, CLOCK, ID_GENERATOR],
          useFactory: (r: InMemorySizeChartRepository, ev: InMemorySizingEventLog, clock: Clock, ids: IdGenerator) =>
            new CreateSizeChart(r, ev, clock, ids),
        },
        {
          provide: LIST_SIZE_CHARTS,
          inject: [SIZE_CHART_REPOSITORY],
          useFactory: (r: InMemorySizeChartRepository) => new ListSizeCharts(r),
        },
        {
          provide: GET_SIZE_DEMAND,
          inject: [SIZE_DEMAND_REPOSITORY],
          useFactory: (r: InMemoryDemandRepository) => new GetSizeDemand(r),
        },
      ],
    };
  }
}
