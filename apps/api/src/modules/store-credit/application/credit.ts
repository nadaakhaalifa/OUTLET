import {
  chart,
  expiryFor,
  addMonthsUtc,
  giftCardRedeemed,
  money,
  planExpirySweep,
  reconcileProjection,
  storeCreditExpired,
  storeCreditGranted,
  subBalanceKey,
  type CreditLot,
  type EntryMeta,
  type Money,
  type ProjectionDrift,
  type StoreCreditSub,
} from "../domain/bridge";
import type {
  ClockPort,
  CreditLedgerPort,
  CreditReason,
  HoldRecord,
  IdPort,
  PlaceHoldResult,
  StoreCreditStore,
} from "../domain/ports";

export const HOLD_TTL_MS = 10 * 60_000;
/** Default gift card term (spec 15.1: 3 years). VERIFY VR-RF-07 for Egyptian limits. */
export const DEFAULT_GIFT_CARD_MONTHS = 36;

type PromoSub = Extract<StoreCreditSub, { kind: "cashback_coins" | "referral_credit" | "goodwill" }>;

const REASON_BY_KIND: Record<StoreCreditSub["kind"], CreditReason> = {
  refund_credit: "refund",
  gift_card: "gift_card",
  cashback_coins: "cashback",
  referral_credit: "referral",
  goodwill: "goodwill",
};

class Meta {
  constructor(
    private readonly ids: IdPort,
    private readonly clock: ClockPort,
  ) {}
  make(key: string, refType: string, refId: string): EntryMeta {
    return { id: this.ids.uuidV7(), idempotencyKey: key, occurredAt: new Date(this.clock.nowMs()), ref: { type: refType, id: refId } };
  }
}

/** Platform-funded grants (coins converted, referral reward, goodwill) and gift-card redemption. */
export class GrantCredit {
  private readonly meta: Meta;
  constructor(
    private readonly store: StoreCreditStore,
    private readonly ledger: CreditLedgerPort,
    private readonly ids: IdPort,
    private readonly clock: ClockPort,
  ) {
    this.meta = new Meta(ids, clock);
  }

  /** Ledger first (idempotent on `key`), then the lot (idempotent on `key`). Safe to repeat. */
  async promo(input: { userId: string; sub: PromoSub; amount: Money; key: string }): Promise<"granted" | "exists"> {
    const now = this.clock.nowMs();
    await this.ledger.post(
      storeCreditGranted({ userId: input.userId, sub: input.sub, amount: input.amount }, this.meta.make(input.key, "store_credit_grant", input.key)),
    );
    return this.addLot(input.userId, input.sub, input.amount, input.key, now, null, REASON_BY_KIND[input.sub.kind]);
  }

  /** Redemption of an issued gift card into the gift_card sub-balance. Sales are a different gate. */
  async giftCardRedeemed(input: { userId: string; cardId: string; amount: Money; expiresAtMs: number; key: string }): Promise<"granted" | "exists"> {
    const now = this.clock.nowMs();
    await this.ledger.post(
      giftCardRedeemed({ userId: input.userId, cardId: input.cardId, amount: input.amount }, this.meta.make(input.key, "gift_card_redemption", input.cardId)),
    );
    return this.addLot(input.userId, { kind: "gift_card", cardId: input.cardId }, input.amount, input.key, now, input.expiresAtMs, "gift_card");
  }

  private async addLot(
    userId: string,
    sub: StoreCreditSub,
    amount: Money,
    key: string,
    nowMs: number,
    cardExpiresAtMs: number | null,
    reason: CreditReason,
  ): Promise<"granted" | "exists"> {
    const lotId = this.ids.uuidV7();
    const r = await this.store.addLot({
      lot: {
        id: lotId,
        userId,
        sub,
        granted: amount.amount,
        remaining: amount.amount,
        held: 0n,
        expiresAtMs: expiryFor(sub, nowMs, cardExpiresAtMs),
        createdAtMs: nowMs,
        sourceKey: key,
      },
      txn: {
        id: this.ids.uuidV7(),
        userId,
        kind: "credit_added",
        reason,
        sub,
        amount: amount.amount,
        ref: key,
        dedupeKey: `added:${key}`,
        createdAtMs: nowMs,
      },
    });
    return r === "added" ? "granted" : "exists";
  }
}

/**
 * The credit side of a refund leg. The refund's own journal entry has already moved the value
 * onto store_credit:{user}:{sub}; this only records the lot, idempotent on the leg id.
 */
export class RestoreRefundCredit {
  constructor(
    private readonly store: StoreCreditStore,
    private readonly ids: IdPort,
    private readonly clock: ClockPort,
    private readonly giftCardMonths: number = DEFAULT_GIFT_CARD_MONTHS,
  ) {}

  async restore(input: { userId: string; sub: StoreCreditSub; amount: Money; refundId: string; legId: string }): Promise<void> {
    const now = this.clock.nowMs();
    const expires =
      input.sub.kind === "gift_card" ? addMonthsUtc(now, this.giftCardMonths) : expiryFor(input.sub, now, null);
    await this.store.addLot({
      lot: {
        id: this.ids.uuidV7(),
        userId: input.userId,
        sub: input.sub,
        granted: input.amount.amount,
        remaining: input.amount.amount,
        held: 0n,
        expiresAtMs: expires,
        createdAtMs: now,
        sourceKey: `refund-leg:${input.legId}`,
      },
      txn: {
        id: this.ids.uuidV7(),
        userId: input.userId,
        kind: "credit_added",
        reason: "refund",
        sub: input.sub,
        amount: input.amount.amount,
        ref: input.refundId,
        dedupeKey: `added:refund-leg:${input.legId}`,
        createdAtMs: now,
      },
    });
  }
}

export interface HoldView {
  readonly hold: HoldRecord;
  readonly replay: boolean;
}

/** Checkout split tender (spec 7 step 3): hold, then capture on payment or release on failure. */
export class CreditHolds {
  constructor(
    private readonly store: StoreCreditStore,
    private readonly ids: IdPort,
    private readonly clock: ClockPort,
    private readonly ttlMs: number = HOLD_TTL_MS,
    /**
     * Sweeper guard: true while the business process that owns the hold (a checkout saga) is not
     * terminal. A live hold is never released by the sweeper, whatever its TTL says (ADV-W4-1).
     */
    private readonly isLive: ((ref: string) => Promise<boolean>) | null = null,
  ) {}

  /** The clock this service decides expiry with (callers planning spend must use the same instant). */
  now(): number {
    return this.clock.nowMs();
  }

  /** `ttlMs` follows the payment window of the method (checkout passes it); default is the 10 min card window. */
  async hold(input: { userId: string; ref: string; amount: Money; ttlMs?: number }): Promise<PlaceHoldResult> {
    const now = this.clock.nowMs();
    return this.store.placeHold({
      id: this.ids.uuidV7(),
      userId: input.userId,
      ref: input.ref,
      amount: input.amount,
      nowMs: now,
      expiresAtMs: now + (input.ttlMs ?? this.ttlMs),
    });
  }

  release(userId: string, ref: string): ReturnType<StoreCreditStore["releaseHold"]> {
    return this.store.releaseHold(userId, ref, this.clock.nowMs());
  }

  /**
   * Consumes the hold. Returns the tenders for `orderRecognised` (the order saga posts the ledger
   * entry under `orderEntryKey`; the nightly reconciliation tolerates the gap until it does).
   */
  async capture(input: { userId: string; ref: string; orderEntryKey: string }) {
    const r = await this.store.captureHold({ ...input, nowMs: this.clock.nowMs() });
    if (r.kind !== "captured") return r;
    const bySub = new Map<string, { sub: StoreCreditSub; amount: bigint }>();
    for (const l of r.hold.lines) {
      const k = subBalanceKey(l.sub);
      const cur = bySub.get(k);
      bySub.set(k, { sub: l.sub, amount: (cur?.amount ?? 0n) + l.amount });
    }
    return {
      kind: "captured" as const,
      tenders: [...bySub.values()].map((v) => ({
        kind: "store_credit" as const,
        userId: input.userId,
        sub: v.sub,
        amount: money(v.amount),
      })),
    };
  }

  /** Releases holds whose TTL elapsed (abandoned checkouts). Idempotent. */
  async sweepExpired(limit = 100): Promise<{ released: number }> {
    const now = this.clock.nowMs();
    const holds = await this.store.listExpiredHolds(now, limit);
    let released = 0;
    for (const h of holds) {
      if (this.isLive !== null && (await this.isLive(h.ref))) continue;
      if ((await this.store.releaseHold(h.userId, h.ref, now)) === "released") released += 1;
    }
    return { released };
  }
}

/** Nightly expiry write-off of platform-funded credit. Ledger first, keyed per lot. */
export class SweepExpiredCredit {
  private readonly meta: Meta;
  constructor(
    private readonly store: StoreCreditStore,
    private readonly ledger: CreditLedgerPort,
    private readonly ids: IdPort,
    private readonly clock: ClockPort,
  ) {
    this.meta = new Meta(ids, clock);
  }

  async execute(limit = 200): Promise<{ expired: number; amount: bigint }> {
    const now = this.clock.nowMs();
    const candidates = planExpirySweep(await this.store.listSweepable(now, limit), now);
    let expired = 0;
    let amount = 0n;
    for (const lot of candidates) {
      const sub = lot.sub;
      if (sub.kind !== "cashback_coins" && sub.kind !== "referral_credit" && sub.kind !== "goodwill") continue;
      const key = `credit-expiry:${lot.id}`;
      await this.ledger.post(
        storeCreditExpired({ userId: lot.userId, sub, amount: money(lot.remaining) }, this.meta.make(key, "store_credit_lot", lot.id)),
      );
      const r = await this.store.expireLot({
        lotId: lot.id,
        txn: {
          id: this.ids.uuidV7(),
          userId: lot.userId,
          kind: "credit_expired",
          reason: "expiry",
          sub,
          amount: lot.remaining,
          ref: lot.id,
          dedupeKey: key,
          createdAtMs: now,
        },
      });
      if (r === "expired") {
        expired += 1;
        amount += lot.remaining;
      }
    }
    return { expired, amount };
  }
}

export interface WalletDrift {
  readonly userId: string;
  readonly drifts: readonly ProjectionDrift[];
}

/** Nightly reconciliation: projection (lots) against ledger postings. Reports, never "fixes". */
export class ReconcileWallets {
  constructor(
    private readonly store: StoreCreditStore,
    private readonly ledger: CreditLedgerPort,
  ) {}

  async execute(batch = 200): Promise<{ users: number; drift: WalletDrift[] }> {
    const drift: WalletDrift[] = [];
    let users = 0;
    let after: string | null = null;
    for (;;) {
      const ids: readonly string[] = await this.store.listUserIds(after, batch);
      if (ids.length === 0) break;
      for (const userId of ids) {
        users += 1;
        const lots: readonly CreditLot[] = await this.store.listLots(userId);
        const ledgerBySub = await this.ledger.balances(userId);
        const unposted = new Map<string, bigint>();
        for (const c of await this.store.listCaptured(userId)) {
          if (!(await this.ledger.hasEntry(c.orderEntryKey))) unposted.set(c.subKey, (unposted.get(c.subKey) ?? 0n) + c.amount);
        }
        const d = reconcileProjection({ lots, ledgerBySub, capturedUnposted: unposted });
        if (d.length > 0) drift.push({ userId, drifts: d });
      }
      after = ids[ids.length - 1] ?? null;
      if (ids.length < batch) break;
    }
    return { users, drift };
  }
}

export { chart };
