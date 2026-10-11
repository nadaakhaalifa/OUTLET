/** Public surface of the courier-aramex module (A2.3). Other code imports only this file. */
export {
  ARAMEX_COURIER,
  ARAMEX_HUB_OUTBOUND,
  CourierAramexModule,
  MissingAramexPortsError,
  type CourierAramexOptions,
} from "./courier-aramex.module";
export { AramexCourier, ARAMEX_STATUS_MAP_VERSION, PATHS as ARAMEX_PATHS, gramsToKg, mapAramexUpdateCode, piastresToEgp } from "./adapters/aramex-courier";
export { FakeAramexTransport, StaticAramexCredentials, type FakeAramexMode } from "./adapters/fake-aramex";
export { AramexHubOutbound } from "./adapters/hub-outbound";
export type { AramexCredentials, AramexCredentialsPort, AramexResponse, AramexTransport } from "./domain/ports";
