import { DEFAULT_REWARDS_CONFIG, type RewardsConfig } from "../domain/bridge";
import type {
  AttestationPort,
  Clock,
  ConfigApprovalPort,
  EntitlementPort,
  HashPort,
  IdPort,
  LedgerPort,
  RandomPort,
  RewardsStore,
  RewardsSwitchPort,
  StoreCreditPort,
  VoucherPort,
} from "../domain/ports";

export interface RewardsDeps {
  readonly store: RewardsStore;
  readonly ledger: LedgerPort;
  readonly credit: StoreCreditPort;
  readonly plus: EntitlementPort;
  readonly vouchers: VoucherPort;
  readonly switches: RewardsSwitchPort;
  readonly attest: AttestationPort;
  readonly approvals: ConfigApprovalPort;
  readonly hash: HashPort;
  readonly random: RandomPort;
  readonly clock: Clock;
  readonly ids: IdPort;
}

export async function currentConfig(store: RewardsStore): Promise<RewardsConfig> {
  return (await store.latestConfig()) ?? DEFAULT_REWARDS_CONFIG;
}

export const iso = (ms: number): string => new Date(ms).toISOString();
