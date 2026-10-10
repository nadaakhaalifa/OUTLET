/** Public surface of the sizing module. Other code imports only this file (A2.3). */
export { SizingModule, type SizingModuleOptions } from "./sizing.module";
export {
  FIELD_CIPHER,
  FIT_CATALOG,
  FIT_FEEDBACK_REPOSITORY,
  MEASUREMENTS_CONSENT,
  ORDER_LINE_FIT,
  SIZE_CHART_REPOSITORY,
  SIZE_DEMAND_REPOSITORY,
  SIZE_PROFILE_REPOSITORY,
  SIZING_EVENTS,
} from "./adapters/tokens";
export {
  DevAesGcmFieldCipher,
  InMemoryFitCatalog,
  InMemoryMeasurementsConsent,
  InMemoryOrderLines,
  InMemorySizingEventLog,
} from "./adapters/in-memory";
export type {
  DeliveredLine,
  DeliveredLineFacts,
  FieldCipherPort,
  FitCatalogPort,
  MeasurementsConsentPort,
  OrderLineFitPort,
  ProductFitFacts,
  SizingEvent,
  SizingEventPublisher,
} from "./domain/ports";
export {
  KyselyDemandRepository,
  KyselyFeedbackRepository,
  KyselySizeChartRepository,
  KyselySizeProfileRepository,
  type SizingDb,
} from "./adapters/kysely-store";
