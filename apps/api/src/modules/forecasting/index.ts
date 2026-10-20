/** Public surface of the forecasting module (A2.3). Other code imports only this file. */
export {
  ForecastingModule,
  MissingForecastingPortsError,
  type ForecastingModuleOptions,
} from "./forecasting.module";
export * from "./adapters/tokens";
export { InMemoryForecastStore, StaticForecastFlags } from "./adapters/in-memory";
export { KyselyForecastStore, type ForecastingDb } from "./adapters/kysely-store";
export { IngestDemandSeries, RunForecastBatch, SellerForecastQueries } from "./application/forecasting";
export type { BatchResult, IngestResult, SellerForecastView } from "./application/forecasting";
export { SeriesRowSchema } from "./domain/ports";
export type { ForecastFlags, ForecastRecord, ForecastStore, SeriesRow } from "./domain/ports";
