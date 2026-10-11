import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import {
  FakeApprovals,
  FakeAttestation,
  FakeLedger,
  FakePlusEntitlements,
  FakeStoreCredit,
  FakeVouchers,
  NodeHash,
  NodeRandom,
  StaticRewardsSwitch,
} from "./adapters/fakes";
import { InMemoryRewardsStore } from "./adapters/in-memory";
import { RewardsAdminResolver } from "./adapters/resolvers";
import { RewardsController } from "./adapters/rewards.controller";
import * as T from "./adapters/tokens";
import { GetRewardsConfig, ManageChallenges, UpdateRewardsConfig } from "./application/admin";
import { GetOdds, PlayGame, PublishOdds } from "./application/games";
import type { RewardsDeps } from "./application/shared";
import { TierService } from "./application/tiers";
import { IngestRewardTrigger } from "./application/triggers";
import { ConvertCoins, GetRewards, SweepRewards } from "./application/view";
import type {
  AttestationPort,
  ConfigApprovalPort,
  EntitlementPort,
  HashPort,
  LedgerPort,
  RandomPort,
  RewardsStore,
  RewardsSwitchPort,
  StoreCreditPort,
  VoucherPort,
} from "./domain/ports";

export interface RewardsModuleOptions {
  /** Replaces the in-memory store (KyselyRewardsStore) once persistence is wired. */
  readonly store?: RewardsStore;
  readonly ledger?: LedgerPort;
  readonly credit?: StoreCreditPort;
  readonly plus?: EntitlementPort;
  readonly vouchers?: VoucherPort;
  /** Backed by packages/feature-flags (`kill.games` and the coins switch). Fails closed. */
  readonly switches?: RewardsSwitchPort;
  readonly attest?: AttestationPort;
  readonly approvals?: ConfigApprovalPort;
  readonly hash?: HashPort;
  readonly random?: RandomPort;
}

/**
 * Thrown outside test mode when a port owned by another module is missing: rewards must never
 * post to a ledger fake, accept an unverified attestation or approve its own configuration.
 */
export class MissingRewardsPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`RewardsModule requires real ${missing.join(", ")} outside test mode`);
    this.name = "MissingRewardsPortsError";
  }
}

@Module({})
export class RewardsModule {
  static forRoot(config: AppConfig, o: RewardsModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && o.store === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing: string[] = [];
      if (o.ledger === undefined) missing.push("ledger (journal posting)");
      if (o.credit === undefined) missing.push("credit (store-credit balance and expiry)");
      if (o.plus === undefined) missing.push("plus (coins_plus_5pct entitlement)");
      if (o.vouchers === undefined) missing.push("vouchers (promotions)");
      if (o.switches === undefined) missing.push("switches (feature flags)");
      if (o.attest === undefined) missing.push("attest (App Attest / Play Integrity)");
      if (o.approvals === undefined) missing.push("approvals (admin dual approval)");
      if (missing.length > 0) throw new MissingRewardsPortsError(missing);
    }
    const store = o.store ?? new InMemoryRewardsStore();
    const fakeLedger = new FakeLedger();
    const ledger = o.ledger ?? fakeLedger;
    const credit = o.credit ?? new FakeStoreCredit(fakeLedger);
    const plus = o.plus ?? new FakePlusEntitlements();
    const vouchers = o.vouchers ?? new FakeVouchers();
    const switches = o.switches ?? new StaticRewardsSwitch(false, true);
    const attest = o.attest ?? new FakeAttestation();
    const approvals = o.approvals ?? new FakeApprovals();
    const hash = o.hash ?? new NodeHash();
    const random = o.random ?? new NodeRandom();

    const RUNTIME = Symbol("rewards.Runtime");
    const runtime = (clock: Clock, ids: IdGenerator) => {
      const d: RewardsDeps = { store, ledger, credit, plus, vouchers, switches, attest, approvals, hash, random, clock, ids };
      return {
        rewards: new GetRewards(d),
        convert: new ConvertCoins(d),
        play: new PlayGame(d),
        odds: new GetOdds(d),
        publish: new PublishOdds(d),
        getConfig: new GetRewardsConfig(d),
        updateConfig: new UpdateRewardsConfig(d),
        challenges: new ManageChallenges(d),
        ingest: new IngestRewardTrigger(d),
        sweep: new SweepRewards(d),
        tiers: new TierService(d),
      };
    };
    type Runtime = ReturnType<typeof runtime>;
    const from = (token: symbol, pick: (r: Runtime) => unknown) => ({
      provide: token,
      inject: [RUNTIME],
      useFactory: (r: Runtime) => pick(r),
    });

    return {
      module: RewardsModule,
      controllers: [RewardsController],
      providers: [
        { provide: T.REWARDS_STORE, useValue: store },
        { provide: T.REWARDS_LEDGER, useValue: ledger },
        { provide: T.REWARDS_CREDIT, useValue: credit },
        { provide: T.REWARDS_PLUS, useValue: plus },
        { provide: T.REWARDS_VOUCHERS, useValue: vouchers },
        { provide: T.REWARDS_SWITCHES, useValue: switches },
        { provide: T.REWARDS_ATTEST, useValue: attest },
        { provide: T.REWARDS_APPROVALS, useValue: approvals },
        { provide: T.REWARDS_ADMIN_RESOLVER, useValue: new RewardsAdminResolver() },
        { provide: RUNTIME, inject: [CLOCK, ID_GENERATOR], useFactory: (c: Clock, ids: IdGenerator) => runtime(c, ids) },
        from(T.GET_REWARDS, (r) => r.rewards),
        from(T.CONVERT_COINS, (r) => r.convert),
        from(T.PLAY_GAME, (r) => r.play),
        from(T.GET_ODDS, (r) => r.odds),
        from(T.PUBLISH_ODDS, (r) => r.publish),
        from(T.GET_REWARDS_CONFIG, (r) => r.getConfig),
        from(T.UPDATE_REWARDS_CONFIG, (r) => r.updateConfig),
        from(T.MANAGE_CHALLENGES, (r) => r.challenges),
        from(T.INGEST_REWARD_TRIGGER, (r) => r.ingest),
        from(T.SWEEP_REWARDS, (r) => r.sweep),
        from(T.TIER_SERVICE, (r) => r.tiers),
      ],
    };
  }
}
