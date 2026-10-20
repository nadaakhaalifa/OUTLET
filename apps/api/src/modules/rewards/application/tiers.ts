import { evaluateTier, netSpend12m, tierFor, type TierChange, type TierState } from "../domain/bridge";
import type { RewardEvent, TierRow } from "../domain/ports";
import { currentConfig, type RewardsDeps } from "./shared";

const YEAR = 366 * 86_400_000;

export class TierService {
  constructor(private readonly d: RewardsDeps) {}

  /**
   * Re-evaluates one user. `applyDrops: false` is the per order path: only upgrades persist, a
   * lower tier waits for the monthly evaluation (and its 30 day notice).
   */
  async evaluate(userId: string, applyDrops: boolean): Promise<TierChange> {
    const cfg = await currentConfig(this.d.store);
    const now = this.d.clock.nowMs();
    const points = (await this.d.store.spendSince(userId, now - YEAR)).map((s) => ({ amount: s.amount, atMs: s.occurredAtMs }));
    const spend = netSpend12m(points, now);
    const row = await this.d.store.getTier(userId);
    const state: TierState = row === null ? { tier: tierFor(cfg, 0n), pendingTier: null, pendingEffectiveAtMs: null } : { tier: row.tier, pendingTier: row.pendingTier, pendingEffectiveAtMs: row.pendingEffectiveAtMs };
    const r = evaluateTier(cfg, state, spend, now);
    if (!applyDrops && r.change.kind !== "upgraded" && r.change.kind !== "none") {
      return { kind: "none" };
    }
    const events: RewardEvent[] = [];
    const c = r.change;
    if (c.kind === "upgraded" || c.kind === "downgraded") {
      events.push({ type: "tier.changed", userId, from: c.from, to: c.to, change: c.kind, effectiveAtMs: null });
    } else if (c.kind === "downgrade_announced") {
      events.push({ type: "tier.changed", userId, from: c.from, to: c.to, change: "downgrade_announced", effectiveAtMs: c.effectiveAtMs });
    }
    const next: TierRow = {
      userId,
      tier: r.state.tier,
      netSpend12m: spend,
      evaluatedAtMs: applyDrops || row === null || c.kind === "upgraded" ? now : row.evaluatedAtMs,
      pendingTier: r.state.pendingTier,
      pendingEffectiveAtMs: r.state.pendingEffectiveAtMs,
    };
    await this.d.store.saveTier(next, events);
    return c;
  }

  /** Monthly job: every user not evaluated since `evaluatedBeforeMs`. */
  async evaluateBatch(evaluatedBeforeMs: number, limit: number): Promise<number> {
    const users = await this.d.store.usersForTierEvaluation(evaluatedBeforeMs, limit);
    for (const u of users) await this.evaluate(u, true);
    return users.length;
  }
}
