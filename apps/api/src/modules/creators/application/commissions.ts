import {
  accrualGate,
  balanceView,
  cairoMonthKey,
  canEarn,
  chart,
  commissionOn,
  creatorCommissionAccrued,
  creatorCommissionClawedBack,
  eligibleBase,
  money,
  payoutEligible,
  refundedBaseOf,
  type BalanceViewT,
} from "../domain/bridge";
import type {
  Clock,
  Commission,
  CreatorAccount,
  CreatorIdentityPort,
  CreatorLedgerPort,
  CreatorStore,
  IdPort,
  PostingIntent,
} from "../domain/ports";
import { creatorFacts } from "./accounts";
import { HOUR_MS, DAY_MS, intentKey, type CreatorRuntimeOptions } from "./shared";

export const LINE_CLOSED_CONSUMER = "creators.order_line_closed";
export const LINE_REFUNDED_CONSUMER = "creators.order_line_refunded";

/** Orders module message: a line's return window closed (CLOSED). Delivered through the inbox. */
export interface LineClosedMessage {
  readonly messageId: string;
  readonly orderGroupId: string;
  readonly orderLineId: string;
  readonly categoryId: string | null;
  /** VAT-inclusive merchandise of the line after item discounts. */
  readonly merchandiseGross: bigint;
  readonly voucherAllocated: bigint;
  /** Cumulative gross already refunded at closure. */
  readonly refundedMerchandiseGross: bigint;
  readonly closedAtMs: number;
  /**
   * End of the line's own return window (seller policy may exceed the 33 day default), and the count
   * of returns not yet terminal. Null = the producer did not state it: the accrual fails closed (A-9).
   */
  readonly returnWindowEndsAtMs: number | null;
  readonly openReturns: number | null;
}

/** Refunds module message: cumulative refunded gross for a line changed. */
export interface LineRefundedMessage {
  readonly messageId: string;
  readonly orderLineId: string;
  readonly lineMerchandiseGross: bigint;
  readonly refundedMerchandiseGross: bigint;
}

// ---- ledger poster ------------------------------------------------------------------------------------

/**
 * Posts owed ledger entries. Idempotent on creator_commission:{id}:{seq}. Safe to run from the
 * accrual path, the repair sweep and replays: a posted entry replays as a no-op.
 */
export class PostCommissionIntents {
  constructor(
    private readonly store: CreatorStore,
    private readonly ledger: CreatorLedgerPort,
    private readonly clock: Clock,
    private readonly ids: IdPort,
  ) {}

  private async postOne(i: PostingIntent): Promise<void> {
    const meta = {
      id: this.ids.uuidV7(),
      idempotencyKey: intentKey(i.commissionId, i.seq),
      occurredAt: new Date(this.clock.nowMs()),
      ref: { type: "commission", id: i.commissionId },
    };
    const entry =
      i.kind === "accrual"
        ? creatorCommissionAccrued({ creatorId: i.creatorUserId, amount: money(i.amount) }, meta)
        : creatorCommissionClawedBack({ creatorId: i.creatorUserId, amount: money(i.amount) }, meta);
    await this.ledger.post(entry);
    const transitioned = await this.store.markPosted(i.commissionId, i.seq, this.clock.nowMs());
    // Once per posting transition: a concurrent or replayed poster that lost the race does not re-emit.
    if (transitioned && i.kind === "clawback") {
      // Never silent: a clawback of an already paid commission leaves an explicit negative payable.
      const natural = await this.ledger.payableBalance(i.creatorUserId);
      if (natural < 0n) {
        const creator = await this.store.getByUser(i.creatorUserId);
        if (creator !== null) {
          await this.store.emit([{ type: "creator.balance_negative", creatorId: creator.id, owes: -natural }]);
        }
      }
    }
  }

  /** Posts one commission's intents in seq order; stops at the first failure so order is kept. */
  async forCommission(commissionId: string): Promise<number> {
    let n = 0;
    for (const i of await this.store.intentsFor(commissionId)) {
      await this.postOne(i);
      n += 1;
    }
    return n;
  }

  /** Repair sweep. Returns how many entries were posted; a failure leaves the rest for the next run. */
  async sweep(limit = 200): Promise<{ readonly posted: number; readonly failed: number }> {
    let posted = 0;
    let failed = 0;
    for (const i of await this.store.listUnpostedIntents(limit)) {
      try {
        await this.postOne(i);
        posted += 1;
      } catch {
        failed += 1;
      }
    }
    return { posted, failed };
  }
}

// ---- accrual --------------------------------------------------------------------------------------------

export type AccrueResult =
  | { readonly kind: "duplicate" }
  | { readonly kind: "ignored"; readonly reason: "no_attribution" | "voided" | "zero" | "exists" }
  /**
   * The attribution is HELD (fraud gate could not run). Nothing accrues and the inbox is NOT
   * recorded, so the message is redelivered and accrues once the hold is resolved (A-3).
   */
  | { readonly kind: "deferred" }
  | { readonly kind: "accrued" | "held"; readonly commissionId: string; readonly amount: bigint };

export class AccrueClosedLine {
  constructor(
    private readonly store: CreatorStore,
    private readonly poster: PostCommissionIntents,
    private readonly ids: IdPort,
    private readonly opts: CreatorRuntimeOptions,
    private readonly clock: Clock,
  ) {}

  /**
   * Accrues only after the line is CLOSED (delivered and the return window over), on the part not
   * refunded by then. Claim first (atomic: inbox, unique row, monthly cap, posting intent), then
   * post the idempotent ledger entry; a failed post is repaired by the sweep, never lost.
   */
  async execute(msg: LineClosedMessage): Promise<AccrueResult> {
    const ignore = async (reason: "no_attribution" | "voided" | "zero" | "exists"): Promise<AccrueResult> => {
      const r = await this.store.recordInbox(LINE_CLOSED_CONSUMER, msg.messageId);
      return r === "duplicate" ? { kind: "duplicate" } : { kind: "ignored", reason };
    };
    const att = await this.store.getAttribution(msg.orderGroupId);
    if (att === null) return ignore("no_attribution");
    if (att.status === "HELD") return { kind: "deferred" };
    if (att.status !== "ACTIVE") return ignore("voided");

    // A-9: never accrue while a return is open or the line's own window is still running, nor on
    // unknown facts. Deferral keeps the message undelivered (inbox not recorded) so the relay retries.
    const gate = accrualGate({ nowMs: this.clock.nowMs(), returnWindowEndsAtMs: msg.returnWindowEndsAtMs, openReturns: msg.openReturns });
    if (gate !== "ok") return { kind: "deferred" };

    const cfg = this.opts.config;
    const base = eligibleBase({ merchandiseGross: msg.merchandiseGross, voucherAllocated: msg.voucherAllocated, vatBps: cfg.vatBps });
    const refundedBase = refundedBaseOf(base, msg.merchandiseGross, msg.refundedMerchandiseGross);
    const rate = BigInt(att.rateSnapshot.categoryBps[msg.categoryId ?? ""] ?? att.rateSnapshot.defaultBps);
    const amount = commissionOn(base - refundedBase, rate);
    if (amount === 0n) return ignore("zero");

    const creator = await this.store.getById(att.creatorId);
    if (creator === null) return ignore("no_attribution");
    const claim = await this.store.claimAccrual({
      consumer: LINE_CLOSED_CONSUMER,
      messageId: msg.messageId,
      commission: {
        id: this.ids.uuidV7(),
        creatorId: creator.id,
        orderGroupId: msg.orderGroupId,
        orderLineId: msg.orderLineId,
        base,
        rateBps: rate,
        amount,
        refundedBase,
        monthKey: cairoMonthKey(msg.closedAtMs),
        closedAtMs: msg.closedAtMs,
        creatorActive: creator.status === "ACTIVE",
        monthlyCap: cfg.monthlyAccrualCap,
      },
    });
    if (claim.kind === "duplicate") return { kind: "duplicate" };
    if (claim.kind === "attribution_inactive") return { kind: "deferred" };
    if (claim.kind === "exists") {
      await this.poster.forCommission(claim.commission.id);
      return { kind: "ignored", reason: "exists" };
    }
    const c = claim.commission;
    if (c.state === "ACCRUED") await this.poster.forCommission(c.id);
    return { kind: c.state === "ACCRUED" ? "accrued" : "held", commissionId: c.id, amount: c.amount };
  }
}

// ---- refunds and clawback ---------------------------------------------------------------------------------

export type RefundResult =
  | { readonly kind: "duplicate" }
  | { readonly kind: "no_commission" }
  | { readonly kind: "applied"; readonly clawedBack: bigint; readonly commissionId: string };

export class ApplyLineRefund {
  constructor(
    private readonly store: CreatorStore,
    private readonly poster: PostCommissionIntents,
  ) {}

  async execute(msg: LineRefundedMessage): Promise<RefundResult> {
    const r = await this.store.claimRefund({
      consumer: LINE_REFUNDED_CONSUMER,
      messageId: msg.messageId,
      orderLineId: msg.orderLineId,
      lineGross: msg.lineMerchandiseGross,
      refundedGross: msg.refundedMerchandiseGross,
    });
    if (r.kind === "duplicate") return { kind: "duplicate" };
    if (r.kind === "no_commission") return { kind: "no_commission" };
    if (r.plan.kind === "clawback") await this.poster.forCommission(r.commission.id);
    return {
      kind: "applied",
      clawedBack: r.plan.kind === "clawback" ? r.plan.delta : 0n,
      commissionId: r.commission.id,
    };
  }
}

// ---- held commissions ---------------------------------------------------------------------------------------

export class ReleaseHeldCommissions {
  constructor(
    private readonly store: CreatorStore,
    private readonly poster: PostCommissionIntents,
    private readonly clock: Clock,
    private readonly opts: CreatorRuntimeOptions,
  ) {}

  /** Held for the monthly cap or a suspended creator. Released when the current month has room. */
  async execute(limit = 200): Promise<{ readonly released: number; readonly stillHeld: number }> {
    const month = cairoMonthKey(this.clock.nowMs());
    let released = 0;
    let stillHeld = 0;
    for (const c of await this.store.listHeld(limit)) {
      const creator = await this.store.getById(c.creatorId);
      if (creator === null || creator.status !== "ACTIVE") {
        stillHeld += 1;
        continue;
      }
      // A-5: a single commission above the cap can never be released (all-or-nothing rule). Say so.
      if (c.amount > this.opts.config.monthlyAccrualCap) {
        await this.store.emit([{ type: "creator.commission_over_cap", creatorId: c.creatorId, commissionId: c.id, amount: c.amount }]);
        stillHeld += 1;
        continue;
      }
      // Atomic: the store applies the same conditional upsert as accrual, so a race with an
      // accrual or another replica cannot exceed the cap; null means "still held".
      const next = await this.store.releaseHeld(c.id, month, this.opts.config.monthlyAccrualCap);
      if (next === null) {
        stillHeld += 1;
        continue;
      }
      await this.poster.forCommission(next.id);
      released += 1;
    }
    return { released, stillHeld };
  }
}

// ---- read models ----------------------------------------------------------------------------------------------

export interface CreatorDashboard {
  readonly handle: string;
  readonly displayName: string;
  readonly status: CreatorAccount["status"];
  readonly kycState: CreatorAccount["kycState"];
  readonly payoutPref: CreatorAccount["payoutPref"];
  readonly earnIneligibleReason: string | null;
  readonly payoutIneligibleReason: string | null;
  readonly balance: BalanceViewT;
  readonly totals: Awaited<ReturnType<CreatorStore["commissionTotals"]>>;
  readonly clicks30d: { readonly total: number; readonly counted: number };
  readonly monthAccrued: bigint;
  readonly monthlyCap: bigint;
  readonly activeLinks: number;
  readonly payoutsEnabled: boolean;
}

export class GetCreatorDashboard {
  constructor(
    private readonly store: CreatorStore,
    private readonly identity: CreatorIdentityPort,
    private readonly ledger: CreatorLedgerPort,
    private readonly flags: { payoutsEnabled(): Promise<boolean> | boolean },
    private readonly clock: Clock,
    private readonly opts: CreatorRuntimeOptions,
  ) {}

  /** Aggregates only: no buyer identity, no per-buyer rows (spec: k >= 50 for any demographic cut). */
  async execute(userId: string): Promise<CreatorDashboard | null> {
    const a = await this.store.getByUser(userId);
    if (a === null) return null;
    const nowMs = this.clock.nowMs();
    const facts = await creatorFacts(this.identity, a);
    const natural = await this.ledger.payableBalance(a.userId);
    const links = await this.store.listLinks(a.id);
    return {
      handle: a.handle,
      displayName: a.displayName,
      status: a.status,
      kycState: a.kycState,
      payoutPref: a.payoutPref,
      earnIneligibleReason: canEarn(this.opts.config, facts),
      payoutIneligibleReason: payoutEligible(this.opts.config, facts),
      balance: balanceView(natural),
      totals: await this.store.commissionTotals(a.id),
      clicks30d: await this.store.clickStats(a.id, nowMs - 30 * DAY_MS),
      monthAccrued: await this.store.monthAccrued(a.id, cairoMonthKey(nowMs)),
      monthlyCap: this.opts.config.monthlyAccrualCap,
      activeLinks: links.filter((l) => l.status === "ACTIVE").length,
      payoutsEnabled: await this.flags.payoutsEnabled(),
    };
  }
}

export class ListMyCommissions {
  constructor(private readonly store: CreatorStore) {}
  async execute(userId: string, limit: number, beforeMs: number | null): Promise<readonly Commission[] | null> {
    const a = await this.store.getByUser(userId);
    return a === null ? null : this.store.listCommissions(a.id, limit, beforeMs);
  }
}

export { HOUR_MS, chart };
