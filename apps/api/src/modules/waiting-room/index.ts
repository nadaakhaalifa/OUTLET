/** Public surface of the waiting-room module. Other code imports only this file (A2.3). */
export { WaitingRoomModule, MissingWaitingRoomPortsError, type WaitingRoomModuleOptions } from "./waiting-room.module";
export * from "./adapters/tokens";
export {
  FakeAttestation,
  FakeBotScore,
  FakeDropGate,
  FakeEntitlements,
  FakeSecrets,
  FakeSwitches,
  InMemoryAdmissionStore,
  InMemoryQueue,
} from "./adapters/in-memory";
export { KyselyAdmissionStore, type WaitingRoomDb } from "./adapters/kysely-admission-store";
export { AdmissionVerifier, type VerifyInput } from "./application/admission";
export { AdmitFromQueue, type AdmitReport } from "./application/admit";
export { JoinQueue, type JoinInput, type JoinOutcome } from "./application/join";
export { QueueStatus, type StatusOutcome } from "./application/status";
export { DEFAULT_WAITING_ROOM_CONFIG, deviceHash, type WaitingRoomConfig, type WaitingRoomDeps } from "./application/shared";
export { QueueUnavailableError } from "./domain/ports";
export type {
  AdmissionRecord,
  AdmissionStore,
  AttestationPort,
  BotScorePort,
  DropGatePort,
  EndedTicket,
  EntitlementPort,
  GateDrop,
  QueuePort,
  SecretPort,
  SigningKey,
  SwitchKey,
  SwitchPort,
  VerifyResult,
  WaitingRoomEvent,
} from "./domain/ports";
export { jwtAdmissionCodec } from "./adapters/jwt";
export type { AdmissionCodec } from "./domain/ports";
export { CheckoutDropAdmission } from "./adapters/checkout-admission";
export { WaitingRoomOpsCounters } from "./adapters/ops-counters";
