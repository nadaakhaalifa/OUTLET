/** Public surface of the rewards module. Other code imports only this file (A2.3). */
export { RewardsModule, MissingRewardsPortsError, type RewardsModuleOptions } from "./rewards.module";
export * from "./adapters/tokens";
export {
  FakeApprovals,
  FakeAttestation,
  FakeLedger,
  FakePlusEntitlements,
  FakeStoreCredit,
  FakeVouchers,
  FlagRewardsSwitch,
  NodeHash,
  NodeRandom,
  SequenceRandom,
  StaticRewardsSwitch,
  type RewardsFlagClient,
} from "./adapters/fakes";
export { InMemoryRewardsStore } from "./adapters/in-memory";
export { KyselyRewardsStore, type RewardsDb } from "./adapters/kysely-store";
export { parseTrigger, TriggerEnvelope, type ParsedTrigger } from "./adapters/triggers";
export type { RewardTrigger, TriggerOutcome, IngestRewardTrigger } from "./application/triggers";
export type { SweepRewards } from "./application/view";
export type { TierService } from "./application/tiers";
export type {
  AttestationPort,
  CoinEventRow,
  ConfigApprovalPort,
  EntitlementPort,
  HashPort,
  LedgerPort,
  RandomPort,
  RewardEvent,
  RewardsStore,
  RewardsSwitchPort,
  StoreCreditPort,
  VoucherPort,
} from "./domain/ports";
