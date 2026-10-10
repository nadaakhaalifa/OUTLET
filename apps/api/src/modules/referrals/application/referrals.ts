import type {
  AppAttestPort,
  Clock,
  IdPort,
  OrderClosedMessage,
  Referral,
  ReferralEvent,
  ReferralIdentityPort,
  ReferralStore,
  TokenEntropy,
} from "../domain/ports";
import {
  clusterSizeOf,
  decideSettlement,
  evaluateAttribution,
  normalizeReferralCode,
  referralCodeFromBytes,
  referralDeepLink,
  refereeDiscountFor,
  transitionReferral,
  type IdentityEntry,
  type PartyProfile,
  type ReferralConfig,
} from "../domain/rules";

export const ORDER_CLOSED_CONSUMER = "referrals.order_closed";
const CODE_RETRIES = 5;

export interface ReferralRuntimeOptions {
  readonly config: ReferralConfig;
  /** When true, POST /v1/referrals/attribute needs a verified App Attest assertion. */
  readonly requireAttest: boolean;
  readonly deepLinkBase: string;
}

const asParty = (p: Awaited<ReturnType<ReferralIdentityPort["profile"]>>): PartyProfile | null =>
  p === null
    ? null
    : {
        ageYears: p.ageYears,
        phoneIsNew: p.phoneIsNew,
        priorOrderCount: p.priorOrderCount,
        deviceHashes: p.deviceHashes,
        active: p.active,
      };

// ---- My referral --------------------------------------------------------------------------------

export interface MyReferralView {
  readonly code: string;
  readonly deepLink: string;
  readonly pending: number;
  readonly rewarded: number;
  readonly rewardedInWindow: number;
  readonly remainingInWindow: number;
  readonly milestone: { readonly every: number; readonly progress: number; readonly plusMonths: number };
  /** Present only when the caller was referred and has not completed the first order. */
  readonly offer: { readonly discount: bigint; readonly minOrder: bigint } | null;
}

export class GetMyReferral {
  constructor(
    private readonly store: ReferralStore,
    private readonly clock: Clock,
    private readonly ids: IdPort,
    private readonly entropy: TokenEntropy,
    private readonly opts: ReferralRuntimeOptions,
  ) {}

  async execute(userId: string): Promise<MyReferralView> {
    const nowMs = this.clock.nowMs();
    let record = null as Awaited<ReturnType<ReferralStore["findCode"]>>;
    for (let i = 0; i < CODE_RETRIES && record === null; i += 1) {
      const r = await this.store.ensureCode({
        id: this.ids.uuidV7(),
        ownerUserId: userId,
        code: referralCodeFromBytes(this.entropy.randomBytes(8)),
        nowMs,
      });
      if (r.kind !== "code_taken") record = r.record;
    }
    if (record === null) throw new Error("could not allocate a referral code");

    const mine = await this.store.listByReferrer(userId);
    const rewarded = mine.filter((r) => r.status === "rewarded").length;
    const pending = mine.filter((r) => r.status === "attributed").length;
    const inWindow = await this.store.countRewarded(userId, nowMs - this.opts.config.rewardWindowMs);
    const every = this.opts.config.milestoneEvery;
    const own = await this.store.getByReferee(userId);
    return {
      code: record.code,
      deepLink: referralDeepLink(this.opts.deepLinkBase, record.code),
      pending,
      rewarded,
      rewardedInWindow: inWindow,
      remainingInWindow: Math.max(0, this.opts.config.maxRewardedPerWindow - inWindow),
      milestone: { every, progress: rewarded % every, plusMonths: this.opts.config.milestonePlusMonths },
      offer:
        own !== null && own.status === "attributed"
          ? { discount: this.opts.config.refereeDiscount, minOrder: this.opts.config.refereeMinOrder }
          : null,
    };
  }
}

// ---- Attribution ----------------------------------------------------------------------------------

export type AttributeResult =
  | { readonly kind: "accepted" }
  | { readonly kind: "unknown_code" }
  | { readonly kind: "attestation_failed" };

export class AttributeReferral {
  constructor(
    private readonly store: ReferralStore,
    private readonly identity: ReferralIdentityPort,
    private readonly attest: AppAttestPort,
    private readonly clock: Clock,
    private readonly ids: IdPort,
    private readonly opts: ReferralRuntimeOptions,
  ) {}

  /**
   * Every business rejection (self referral, same device, not new, underage, suspended referrer)
   * is recorded and answered exactly like success, so the endpoint is not an eligibility oracle.
   */
  async execute(userId: string, rawCode: string, assertion: string | null): Promise<AttributeResult> {
    if (this.opts.requireAttest && !(await this.attest.verify({ userId, assertion }))) {
      return { kind: "attestation_failed" };
    }
    const code = normalizeReferralCode(rawCode);
    if (code === null) return { kind: "unknown_code" };
    const record = await this.store.findCode(code);
    if (record === null) return { kind: "unknown_code" };

    if ((await this.store.getByReferee(userId)) !== null) return { kind: "accepted" };

    const [referrerProfile, refereeProfile] = await Promise.all([
      this.identity.profile(record.ownerUserId),
      this.identity.profile(userId),
    ]);
    const decision = evaluateAttribution(this.opts.config, {
      referrerId: record.ownerUserId,
      refereeId: userId,
      referrer: asParty(referrerProfile),
      referee: asParty(refereeProfile),
    });
    const nowMs = this.clock.nowMs();
    const referral: Referral = {
      id: this.ids.uuidV7(),
      codeId: record.id,
      referrerId: record.ownerUserId,
      refereeId: userId,
      status: decision.ok ? "attributed" : "rejected",
      rejectReason: decision.ok ? null : decision.reason,
      refereeDeviceHashes: refereeProfile?.deviceHashes ?? [],
      orderId: null,
      paymentFingerprintHash: null,
      rewardAmount: null,
      attributedAtMs: nowMs,
      settledAtMs: decision.ok ? null : nowMs,
    };
    const event: ReferralEvent = decision.ok
      ? { type: "referral.attributed", referralId: referral.id, referrerId: referral.referrerId, refereeId: userId }
      : {
          type: "referral.attribution_rejected",
          referralId: referral.id,
          referrerId: referral.referrerId,
          refereeId: userId,
          reason: decision.reason,
        };
    await this.store.insertAttribution(referral, [event]);
    return { kind: "accepted" };
  }
}

// ---- Friend offer (called by checkout/promotions) --------------------------------------------------

export class QuoteRefereeOffer {
  constructor(
    private readonly store: ReferralStore,
    private readonly identity: ReferralIdentityPort,
    private readonly opts: ReferralRuntimeOptions,
  ) {}

  /** Discount in piastres for the user's first order, 0 when not eligible. Pure read. */
  async execute(userId: string, merchandiseSubtotal: bigint): Promise<bigint> {
    const r = await this.store.getByReferee(userId);
    if (r === null || r.status !== "attributed") return 0n;
    const p = await this.identity.profile(userId);
    if (p === null || p.priorOrderCount > 0) return 0n;
    return refereeDiscountFor(this.opts.config, merchandiseSubtotal);
  }
}

// ---- OrderClosed consumer ----------------------------------------------------------------------------

export type ClosedResult =
  | { readonly kind: "duplicate" }
  | { readonly kind: "ignored" }
  | { readonly kind: "rewarded"; readonly referralId: string; readonly plusMonths: number }
  | { readonly kind: "rejected"; readonly referralId: string };

export class HandleOrderClosed {
  constructor(
    private readonly store: ReferralStore,
    private readonly identity: ReferralIdentityPort,
    private readonly clock: Clock,
    private readonly opts: ReferralRuntimeOptions,
  ) {}

  async execute(msg: OrderClosedMessage): Promise<ClosedResult> {
    const referral = await this.store.getByReferee(msg.userId);
    if (referral === null || referral.status !== "attributed") {
      const r = await this.store.settle({ consumer: ORDER_CLOSED_CONSUMER, messageId: msg.messageId, change: null, events: [] });
      return r.kind === "duplicate" ? { kind: "duplicate" } : { kind: "ignored" };
    }

    const nowMs = this.clock.nowMs();
    const cfg = this.opts.config;
    const referrerProfile = await this.identity.profile(referral.referrerId);
    const siblings = await this.store.listByReferrer(referral.referrerId);
    const inWindow = await this.store.countRewarded(referral.referrerId, nowMs - cfg.rewardWindowMs);
    const total = await this.store.countRewarded(referral.referrerId, null);

    const referrerIds = [
      ...(referrerProfile?.deviceHashes ?? []).map((d) => `dev:${d}`),
      ...(referrerProfile?.paymentFingerprintHashes ?? []).map((f) => `fp:${f}`),
    ];
    const entries: IdentityEntry[] = [{ userId: referral.referrerId, identifiers: referrerIds }];
    for (const s of siblings) {
      const fp = s.id === referral.id ? msg.paymentFingerprintHash : s.paymentFingerprintHash;
      entries.push({
        userId: s.refereeId,
        identifiers: [...s.refereeDeviceHashes.map((d) => `dev:${d}`), ...(fp === null ? [] : [`fp:${fp}`])],
      });
    }

    const decision = decideSettlement({
      config: cfg,
      referralStatus: referral.status,
      closure: {
        isFirstOrder: msg.isFirstOrder,
        merchandiseSubtotal: msg.merchandiseSubtotal,
        refunded: msg.refunded,
        paymentMethod: msg.paymentMethod,
        deliveredAtMs: msg.deliveredAtMs,
        closedAtMs: msg.closedAtMs,
        paymentFingerprintHash: msg.paymentFingerprintHash,
      },
      referrer: {
        hasDeliveredOrder: (referrerProfile?.deliveredOrderCount ?? 0) >= 1,
        active: referrerProfile?.active ?? false,
        deviceHashes: referrerProfile?.deviceHashes ?? [],
        paymentFingerprintHashes: referrerProfile?.paymentFingerprintHashes ?? [],
        rewardedInWindow: inWindow,
        rewardedTotal: total,
      },
      clusterSize: clusterSizeOf(referral.refereeId, entries),
    });

    if (decision.kind === "ignore") {
      const r = await this.store.settle({ consumer: ORDER_CLOSED_CONSUMER, messageId: msg.messageId, change: null, events: [] });
      return r.kind === "duplicate" ? { kind: "duplicate" } : { kind: "ignored" };
    }

    if (decision.kind === "reject") {
      transitionReferral("attributed", "rejected");
      const r = await this.store.settle({
        consumer: ORDER_CLOSED_CONSUMER,
        messageId: msg.messageId,
        change: {
          referralId: referral.id,
          status: "rejected",
          rejectReason: decision.reason,
          orderId: msg.orderId,
          paymentFingerprintHash: msg.paymentFingerprintHash,
          rewardAmount: null,
          settledAtMs: nowMs,
        },
        events: [{ type: "referral.rejected", referralId: referral.id, referrerId: referral.referrerId, reason: decision.reason }],
      });
      return r.kind === "duplicate" ? { kind: "duplicate" } : { kind: "rejected", referralId: referral.id };
    }

    transitionReferral("attributed", "rewarded");
    const events: ReferralEvent[] = [
      {
        type: "referral.reward_earned",
        referralId: referral.id,
        beneficiaryUserId: referral.referrerId,
        amount: decision.amount,
        currency: "EGP",
        kind: "referral_credit",
        idempotencyKey: `referral:${referral.id}:reward`,
      },
    ];
    const r = await this.store.settle({
      consumer: ORDER_CLOSED_CONSUMER,
      messageId: msg.messageId,
      change: {
        referralId: referral.id,
        status: "rewarded",
        rejectReason: null,
        orderId: msg.orderId,
        paymentFingerprintHash: msg.paymentFingerprintHash,
        rewardAmount: decision.amount,
        settledAtMs: nowMs,
        guard: {
          referrerId: referral.referrerId,
          windowStartMs: nowMs - cfg.rewardWindowMs,
          maxInWindow: cfg.maxRewardedPerWindow,
          milestoneEvery: cfg.milestoneEvery,
          milestonePlusMonths: cfg.milestonePlusMonths,
        },
      },
      events,
    });
    if (r.kind === "duplicate") return { kind: "duplicate" };
    if (r.outcome === "capped") return { kind: "rejected", referralId: referral.id };
    if (r.outcome === "already_settled") return { kind: "ignored" };
    return { kind: "rewarded", referralId: referral.id, plusMonths: r.plusMonths };
  }
}
