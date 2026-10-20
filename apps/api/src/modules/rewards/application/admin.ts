import { validateRewardsConfig, type RewardsConfig } from "../domain/bridge";
import type { ChallengeRow, ChallengeRule } from "../domain/ports";
import { currentConfig, type RewardsDeps } from "./shared";

export type ConfigResult =
  | { readonly kind: "ok"; readonly config: RewardsConfig }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "not_approved" }
  | { readonly kind: "conflict" };

export class GetRewardsConfig {
  constructor(private readonly d: RewardsDeps) {}
  execute(): Promise<RewardsConfig> {
    return currentConfig(this.d.store);
  }
}

/** Replaces the configuration with the next version: validated, dual approved, audited via an event. */
export class UpdateRewardsConfig {
  constructor(private readonly d: RewardsDeps) {}
  async execute(input: { readonly actorId: string; readonly approvalId: string; readonly next: Omit<RewardsConfig, "version"> }): Promise<ConfigResult> {
    const cur = await currentConfig(this.d.store);
    let cfg: RewardsConfig;
    try {
      cfg = validateRewardsConfig({ ...input.next, version: cur.version + 1 });
    } catch (e) {
      return { kind: "invalid", reason: e instanceof Error ? e.message : "invalid" };
    }
    if (!(await this.d.approvals.isApproved({ approvalId: input.approvalId, kind: "rewards_config", requesterId: input.actorId }))) {
      return { kind: "not_approved" };
    }
    const r = await this.d.store.putConfig(cfg, { approvalId: input.approvalId, actorId: input.actorId, atMs: this.d.clock.nowMs() }, [
      { type: "rewards.config_changed", version: cfg.version, actorId: input.actorId, approvalId: input.approvalId },
    ]);
    return r === "ok" ? { kind: "ok", config: cfg } : { kind: "conflict" };
  }
}

export class ManageChallenges {
  constructor(private readonly d: RewardsDeps) {}
  async create(input: {
    readonly code: string;
    readonly rule: ChallengeRule;
    readonly windowStartMs: number;
    readonly windowEndMs: number;
    readonly rewardCoins: bigint;
  }): Promise<{ readonly kind: "created"; readonly challenge: ChallengeRow } | { readonly kind: "invalid" } | { readonly kind: "duplicate_code" }> {
    const cfg = await currentConfig(this.d.store);
    if (input.windowEndMs <= input.windowStartMs || input.rewardCoins <= 0n || input.rewardCoins > cfg.maxCoinsPerEvent || input.rule.count < 1) {
      return { kind: "invalid" };
    }
    const row: ChallengeRow = { id: this.d.ids.uuidV7(), ...input, active: true, createdAtMs: this.d.clock.nowMs() };
    const r = await this.d.store.insertChallenge(row);
    return r === "inserted" ? { kind: "created", challenge: row } : { kind: "duplicate_code" };
  }
  list(): Promise<readonly ChallengeRow[]> {
    return this.d.store.listChallenges({ activeAtMs: null });
  }
  deactivate(id: string): Promise<boolean> {
    return this.d.store.deactivateChallenge(id);
  }
}
