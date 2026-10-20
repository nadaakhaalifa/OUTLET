import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { AdminCalendarController } from "./adapters/calendar.controller";
import { InMemoryCalendarStore } from "./adapters/calendar-in-memory";
import { ListCalendarEvents, SaveCalendarEvent } from "./application/calendar";
import type { CalendarStore } from "./domain/calendar";
import { PromotionAuthorizer } from "./adapters/authorizer";
import {
  DenyAllServiceAuthenticator,
  InMemoryPromotionEventPublisher,
  InMemoryPromotionRepository,
} from "./adapters/in-memory";
import {
  AdminPromotionsController,
  InternalPromotionsController,
  SellerPromotionsController,
} from "./adapters/promotions.controllers";
import {
  CALENDAR_STORE,
  LIST_CALENDAR,
  SAVE_CALENDAR,
  CREATE_PROMOTION,
  EVALUATE_PROMOTIONS,
  GET_PROMOTION,
  LIST_PROMOTIONS,
  PROMOTION_AUTHORIZER,
  PROMOTION_EVENTS,
  PROMOTION_REPOSITORY,
  PROMOTION_SERVICE_AUTH,
  RECORD_REDEMPTIONS,
  REINSTATE_REDEMPTIONS,
  UPDATE_PROMOTION,
} from "./adapters/tokens";
import {
  CreatePromotion,
  EvaluatePromotions,
  GetPromotion,
  ListPromotions,
  RecordRedemptions,
  ReinstateRedemptions,
  UpdatePromotion,
  type Clock,
  type IdGenerator,
  type PromotionDeps,
} from "./application/promotions";
import type { PromotionEventPublisher, PromotionRepository, ServiceAuthenticator } from "./domain/ports";

export interface PromotionsModuleOverrides {
  readonly repository?: PromotionRepository;
  /** Admin calendar persistence (KyselyCalendarStore in production). */
  readonly calendar?: CalendarStore;
  readonly events?: PromotionEventPublisher;
  /** Verifies the internal caller of `POST /v1/promotions/evaluate`. */
  readonly serviceAuth?: ServiceAuthenticator;
}

/** Thrown at boot when an auth or persistence port is not supplied outside test mode. */
export class MissingPromotionsPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      `PromotionsModule requires real ${missing.join(", ")} outside test mode: ` +
        "supply them through PromotionsModule.forRoot(config, overrides)",
    );
    this.name = "MissingPromotionsPortsError";
  }
}

@Module({})
export class PromotionsModule {
  static forRoot(config: AppConfig, overrides: PromotionsModuleOverrides = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && overrides.repository === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing: string[] = [];
      if (overrides.serviceAuth === undefined) missing.push("serviceAuth (PROMOTION_SERVICE_AUTH: internal caller identity)");
      if (missing.length > 0) throw new MissingPromotionsPortsError(missing);
    }
    const repo = overrides.repository ?? new InMemoryPromotionRepository();
    const inject = [PROMOTION_REPOSITORY, PROMOTION_EVENTS, CLOCK, ID_GENERATOR];
    const useCase = <T>(token: symbol, make: (d: PromotionDeps) => T) => ({
      provide: token,
      inject,
      useFactory: (r: PromotionRepository, events: PromotionEventPublisher, clock: Clock, ids: IdGenerator): T =>
        make({ repo: r, events, clock, ids }),
    });
    return {
      module: PromotionsModule,
      controllers: [AdminCalendarController, AdminPromotionsController, SellerPromotionsController, InternalPromotionsController],
      providers: [
        { provide: PROMOTION_REPOSITORY, useValue: repo },
        { provide: PROMOTION_EVENTS, useValue: overrides.events ?? new InMemoryPromotionEventPublisher() },
        // Test mode only (forRoot throws otherwise): nobody is a service until a real authenticator is wired.
        { provide: PROMOTION_SERVICE_AUTH, useValue: overrides.serviceAuth ?? new DenyAllServiceAuthenticator() },
        { provide: CALENDAR_STORE, useValue: overrides.calendar ?? new InMemoryCalendarStore() },
        {
          provide: LIST_CALENDAR,
          inject: [CALENDAR_STORE],
          useFactory: (c: CalendarStore) => new ListCalendarEvents(c),
        },
        {
          provide: SAVE_CALENDAR,
          inject: [CALENDAR_STORE, CLOCK, ID_GENERATOR],
          useFactory: (c: CalendarStore, clock: Clock, ids: IdGenerator) => new SaveCalendarEvent(c, clock, ids),
        },
        PromotionAuthorizer,
        { provide: PROMOTION_AUTHORIZER, useExisting: PromotionAuthorizer },
        useCase(EVALUATE_PROMOTIONS, (d) => new EvaluatePromotions(d)),
        useCase(CREATE_PROMOTION, (d) => new CreatePromotion(d)),
        useCase(GET_PROMOTION, (d) => new GetPromotion(d)),
        useCase(LIST_PROMOTIONS, (d) => new ListPromotions(d)),
        useCase(UPDATE_PROMOTION, (d) => new UpdatePromotion(d)),
        useCase(RECORD_REDEMPTIONS, (d) => new RecordRedemptions(d)),
        useCase(REINSTATE_REDEMPTIONS, (d) => new ReinstateRedemptions(d)),
      ],
      exports: [EVALUATE_PROMOTIONS, RECORD_REDEMPTIONS, REINSTATE_REDEMPTIONS, PROMOTION_REPOSITORY],
    };
  }
}
