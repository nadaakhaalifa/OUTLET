import { cairoMonthKey, milestoneAt, purchaseCoins, reviewCoins, streakState } from "../domain/bridge";
import { CoinService, type AwardResult } from "./coins";
import { currentConfig, type RewardsDeps } from "./shared";
import { TierService } from "./tiers";

/** Inbound intents, already validated by the Zod boundary in adapters/triggers.ts. */
export type RewardTrigger =
  | { readonly type: "order.closed"; readonly userId: string; readonly orderRef: string; readonly netMerchandise: bigint; readonly deliveredAtMs: number }
  | {
      readonly type: "order.refunded";
      readonly userId: string;
      readonly orderRef: string;
      readonly refundRef: string;
      readonly orderNetMerchandise: bigint;
      readonly refundedNetMerchandise: bigint;
      readonly cumulativeRefunded: bigint;
    }
  | { readonly type: "review.reward_intent"; readonly userId: string; readonly reviewId: string; readonly hasPhoto: boolean; readonly hasFitInfo: boolean }
  | { readonly type: "profile.completed"; readonly userId: string; readonly profileId: string }
  | { readonly type: "fit.feedback_submitted"; readonly userId: string; readonly orderLineId: string }
  | { readonly type: "referral.reward_earned"; readonly userId: string; readonly referralId: string; readonly amountPiastres: bigint; readonly idempotencyKey: string };

export type TriggerOutcome =
  | { readonly kind: "applied"; readonly coins: bigint }
  | { readonly kind: "duplicate" }
  | { readonly kind: "disabled" }
  | { readonly kind: "ignored" };

const MONTH_LOOKBACK_MS = 14 * 31 * 86_400_000;

/** Consumes reward intents from other modules (outbox consumers call this; at least once, idempotent). */
export class IngestRewardTrigger {
  private readonly coins: CoinService;
  private readonly tiers: TierService;
  constructor(private readonly d: RewardsDeps) {
    this.coins = new CoinService(d);
    this.tiers = new TierService(d);
  }

  async execute(t: RewardTrigger): Promise<TriggerOutcome> {
    if (!(await this.d.switches.coinsEnabled())) return { kind: "disabled" };
    const cfg = await currentConfig(this.d.store);
    switch (t.type) {
      case "order.closed":
        return this.orderClosed(t);
      case "order.refunded":
        return this.orderRefunded(t);
      case "review.reward_intent":
        // The rating is not part of the trigger: 1 and 5 stars cannot differ (spec 27).
        return this.outcome(
          await this.coins.award({
            userId: t.userId,
            kind: "photo_review",
            coins: reviewCoins(cfg, { hasPhoto: t.hasPhoto, hasFitInfo: t.hasFitInfo }),
            sourceRef: t.reviewId,
          }),
        );
      case "profile.completed":
        return this.outcome(
          await this.coins.award({ userId: t.userId, kind: "profile_completion", coins: cfg.profileCompletionCoins, sourceRef: `profile:${t.userId}` }),
        );
      case "fit.feedback_submitted":
        return this.outcome(
          await this.coins.award({ userId: t.userId, kind: "fit_feedback", coins: cfg.fitFeedbackCoins, sourceRef: t.orderLineId }),
        );
      case "referral.reward_earned":
        // The referral module decided the amount. It is credit in the referral_credit sub-balance
        // (6 months), recorded as coin event kind "referral" so history and clawback stay in one place.
        return this.outcome(
          await this.coins.award({
            userId: t.userId,
            kind: "referral",
            coins: piastresToCoins(t.amountPiastres, cfg.piastresPerCoin),
            sourceRef: t.idempotencyKey,
            sub: { kind: "referral_credit" },
          }),
        );
    }
  }

  private outcome(r: AwardResult): TriggerOutcome {
    if (r.kind === "awarded") return { kind: "applied", coins: r.event.amount };
    if (r.kind === "duplicate") return { kind: "duplicate" };
    return { kind: "ignored" };
  }

  private async orderClosed(t: Extract<RewardTrigger, { type: "order.closed" }>): Promise<TriggerOutcome> {
    const now = this.d.clock.nowMs();
    const cfg = await currentConfig(this.d.store);
    const spend = await this.d.store.addSpend({
      id: this.d.ids.uuidV7(),
      userId: t.userId,
      sourceRef: `order:${t.orderRef}`,
      amount: t.netMerchandise,
      occurredAtMs: now,
    });
    const plus = await this.d.plus.hasPlusCoinsBonus(t.userId, t.deliveredAtMs);
    const earned = await this.coins.award({
      userId: t.userId,
      kind: "purchase",
      coins: purchaseCoins(cfg, t.netMerchandise, plus),
      sourceRef: t.orderRef,
    });
    if (spend === "inserted") {
      await this.d.store.addEntitlement(t.userId, `order:${t.orderRef}`, now);
      await this.tiers.evaluate(t.userId, false);
      await this.streakAndChallenges(t.userId);
    }
    return this.outcome(earned);
  }

  private async orderRefunded(t: Extract<RewardTrigger, { type: "order.refunded" }>): Promise<TriggerOutcome> {
    await this.d.store.addSpend({
      id: this.d.ids.uuidV7(),
      userId: t.userId,
      sourceRef: `refund:${t.refundRef}`,
      amount: -t.refundedNetMerchandise,
      occurredAtMs: this.d.clock.nowMs(),
    });
    const r = await this.coins.clawback({
      userId: t.userId,
      orderRef: t.orderRef,
      refundRef: t.refundRef,
      orderNetMerchandise: t.orderNetMerchandise,
      refundedNetMerchandise: t.refundedNetMerchandise,
      cumulativeRefunded: t.cumulativeRefunded,
    });
    return r === null ? { kind: "ignored" } : { kind: "applied", coins: -r.coins };
  }

  /** Streak milestones and order-count challenges, each paid once per run / challenge. */
  private async streakAndChallenges(userId: string): Promise<void> {
    const now = this.d.clock.nowMs();
    const cfg = await currentConfig(this.d.store);
    const rows = await this.d.store.spendSince(userId, now - MONTH_LOOKBACK_MS);
    const orders = rows.filter((r) => r.amount > 0n && r.sourceRef.startsWith("order:"));
    const s = streakState(new Set(orders.map((r) => cairoMonthKey(r.occurredAtMs))), now);
    const m = milestoneAt(cfg, s.length);
    if (m !== null && s.startMonthKey !== null) {
      await this.coins.award({ userId, kind: "streak", coins: m.coins, sourceRef: `streak:${userId}:${s.startMonthKey}:${m.months}` });
    }
    for (const c of await this.d.store.listChallenges({ activeAtMs: now })) {
      const count = orders.filter((r) => r.occurredAtMs >= c.windowStartMs && r.occurredAtMs < c.windowEndMs).length;
      if (count >= c.rule.count) {
        await this.coins.award({ userId, kind: "challenge", coins: c.rewardCoins, sourceRef: `challenge:${c.id}:${userId}` });
      }
    }
  }
}

/**
 * The single rounding point of referral credit (B-6): whole coins, rounded DOWN. The referral
 * module decided `amountPiastres`; we never grant more than that, and the sub-coin remainder
 * (< piastresPerCoin) is not granted. At the default 1 piastre per coin it is exact.
 */
export function piastresToCoins(amountPiastres: bigint, piastresPerCoin: bigint): bigint {
  if (piastresPerCoin <= 0n) throw new Error("piastresPerCoin must be positive");
  if (amountPiastres <= 0n) return 0n;
  return amountPiastres / piastresPerCoin;
}
