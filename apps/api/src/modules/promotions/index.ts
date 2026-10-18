/**
 * Public surface of the promotions module (A2.3). Other code imports only this file.
 * Never import budget data into this module (spec 12).
 */
export { PromotionsModule, MissingPromotionsPortsError, type PromotionsModuleOverrides } from "./promotions.module";
export {
  EVALUATE_PROMOTIONS,
  PROMOTION_EVENTS,
  PROMOTION_REPOSITORY,
  PROMOTION_SERVICE_AUTH,
  RECORD_REDEMPTIONS,
  REINSTATE_REDEMPTIONS,
} from "./adapters/tokens";
export {
  DenyAllServiceAuthenticator,
  InMemoryPromotionEventPublisher,
  InMemoryPromotionRepository,
  StaticServiceTokenAuthenticator,
} from "./adapters/in-memory";
export { KyselyPromotionRepository, type PromotionDb } from "./adapters/kysely-store";
export { promotionRules } from "./adapters/authorizer";
export type {
  EvaluateInput,
  EvaluatePromotions,
  RecordRedemptions,
  ReinstateRedemptions,
} from "./application/promotions";
export type {
  PromotionEvent,
  PromotionEventPublisher,
  PromotionPatch,
  PromotionRecord,
  PromotionRepository,
  RedemptionInput,
  RedemptionOutcome,
  ServiceAuthenticator,
} from "./domain/ports";
export { PromotionsUnavailableError } from "./domain/ports";
export { KyselyCalendarStore } from "./adapters/calendar-kysely";
export { InMemoryCalendarStore } from "./adapters/calendar-in-memory";
export type { CalendarStore, CalendarEvent } from "./domain/calendar";
