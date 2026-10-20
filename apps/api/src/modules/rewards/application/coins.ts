import {
  clawbackCoins,
  coinClawbackEntry,
  coinExpiryMs,
  coinGrantEntry,
  netAgainstDebt,
  planCoinExpiry,
  type CoinLot,
  type CoinSub,
  type EarnReason,
} from "../domain/bridge";
import type { CoinEventKind, CoinEventRow, RewardsStore } from "../domain/ports";
import { currentConfig, type RewardsDeps } from "./shared";

const EXPIRY_KINDS: readonly CoinEventKind[] = ["expire"];
const subOf = (k: CoinEventRow["sub"]): CoinSub => (k === "referral_credit" ? { kind: "referral_credit" } : { kind: "cashback_coins" });
const isEarn = (e: CoinEventRow): boolean => e.kind !== "clawback" && !EXPIRY_KINDS.includes(e.kind);

/** Coins of an earn row that became credit (gross minus the part that paid down debt). */
export const postedOf = (e: CoinEventRow): bigint => e.amount + e.debtDelta;
/** Posted coins owed to the ledger but not yet posted (ledger was unavailable at award time). */
export const isPendingSettlement = (e: CoinEventRow): boolean => isEarn(e) && postedOf(e) > 0n && e.journalEntryId === null;

export interface LotView extends CoinLot {
  readonly event: CoinEventRow;
  readonly closed: boolean;
}

/** Builds lots from the event history of one user. Pure. */
export function lotsOf(events: readonly CoinEventRow[]): LotView[] {
  const clawedReversed = new Map<string, bigint>();
  const closed = new Set<string>();
  for (const e of events) {
    if (e.parentId === null) continue;
    if (e.kind === "clawback") clawedReversed.set(e.parentId, (clawedReversed.get(e.parentId) ?? 0n) + (-e.amount - e.debtDelta));
    if (e.kind === "expire") closed.add(e.parentId);
  }
  return events
    .filter((e) => isEarn(e) && e.expiresAtMs !== null && e.journalEntryId !== null)
    .map((e) => {
      const remaining = postedOf(e) - (clawedReversed.get(e.id) ?? 0n);
      const isClosed = closed.has(e.id);
      return { id: e.id, expiresAtMs: e.expiresAtMs as number, remaining: isClosed || remaining < 0n ? 0n : remaining, event: e, closed: isClosed };
    });
}

export type AwardResult =
  | { readonly kind: "awarded"; readonly event: CoinEventRow; readonly pending: boolean }
  | { readonly kind: "duplicate"; readonly event: CoinEventRow }
  | { readonly kind: "skipped" };

/** Coin earn, clawback, expiry and settlement. Ledger first, then the coin event, idempotent on every step. */
export class CoinService {
  constructor(private readonly d: RewardsDeps) {}

  async award(input: {
    readonly userId: string;
    readonly kind: EarnReason;
    readonly coins: bigint;
    readonly sourceRef: string;
    readonly sub?: CoinSub;
  }): Promise<AwardResult> {
    if (input.coins <= 0n) return { kind: "skipped" };
    const existing = await this.d.store.coinEventBySource(input.kind, input.sourceRef);
    if (existing !== null) return { kind: "duplicate", event: existing };
    const cfg = await currentConfig(this.d.store);
    const now = this.d.clock.nowMs();
    const sub = input.sub ?? { kind: "cashback_coins" };
    const debt = await this.d.store.debtOf(input.userId);
    const netting = netAgainstDebt(debt, input.coins);
    let journalEntryId: string | null = null;
    let pending = false;
    if (netting.postable > 0n) {
      try {
        const r = await this.d.ledger.post(
          coinGrantEntry(
            { userId: input.userId, sub: sub as CoinSub & { kind: "cashback_coins" | "referral_credit" }, piastres: netting.postable * cfg.piastresPerCoin },
            {
              id: this.d.ids.uuidV7(),
              idempotencyKey: `rewards:earn:${input.kind}:${input.sourceRef}`,
              occurredAt: new Date(now),
              ref: { type: "rewards", id: input.sourceRef },
            },
          ),
        );
        journalEntryId = r.entryId;
      } catch {
        pending = true; // ledger unavailable: record the award, settle later (never lose or double it)
      }
    }
    const expiresAtMs = coinExpiryMs(cfg, now);
    const row: CoinEventRow = {
      id: this.d.ids.uuidV7(),
      userId: input.userId,
      kind: input.kind,
      sub: sub.kind === "referral_credit" ? "referral_credit" : "cashback_coins",
      amount: input.coins,
      debtDelta: -netting.netted,
      parentId: null,
      sourceRef: input.sourceRef,
      journalEntryId,
      expiresAtMs,
      piastresPerCoin: cfg.piastresPerCoin,
      configVersion: cfg.version,
      createdAtMs: now,
    };
    const res = await this.d.store.appendCoinEvent(row, [
      { type: "coins.earned", userId: input.userId, kind: input.kind, coins: input.coins, sourceRef: input.sourceRef, expiresAtMs },
    ]);
    if (res === "duplicate") {
      const e = await this.d.store.coinEventBySource(input.kind, input.sourceRef);
      return e === null ? { kind: "skipped" } : { kind: "duplicate", event: e };
    }
    return { kind: "awarded", event: row, pending };
  }

  /** Posts the ledger entries of awards recorded while the ledger was unavailable. Idempotent. */
  async settlePending(userId: string | null, limit = 100): Promise<number> {
    let settled = 0;
    for (const e of await this.d.store.pendingSettlements(userId, limit)) {
      settled += (await this.settleOne(e)) ? 1 : 0;
    }
    return settled;
  }

  private async settleOne(e: CoinEventRow): Promise<boolean> {
    try {
      const r = await this.d.ledger.post(
        coinGrantEntry(
          { userId: e.userId, sub: subOf(e.sub) as CoinSub & { kind: "cashback_coins" | "referral_credit" }, piastres: postedOf(e) * e.piastresPerCoin },
          {
            id: this.d.ids.uuidV7(),
            idempotencyKey: `rewards:earn:${e.kind}:${e.sourceRef}`,
            occurredAt: new Date(e.createdAtMs),
            ref: { type: "rewards", id: e.sourceRef },
          },
        ),
      );
      await this.d.store.setJournalEntry(e.id, r.entryId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Proportional clawback for a refund. The reversing entry covers the coins still backed by
   * unspent credit; coins already spent become debt netted from future earnings, never charged.
   */
  async clawback(input: {
    readonly userId: string;
    readonly orderRef: string;
    readonly refundRef: string;
    readonly orderNetMerchandise: bigint;
    readonly refundedNetMerchandise: bigint;
    readonly cumulativeRefunded: bigint;
  }): Promise<{ readonly coins: bigint; readonly debtAdded: bigint } | null> {
    const dup = await this.d.store.coinEventBySource("clawback", input.refundRef);
    if (dup !== null) return this.healClawback(dup);
    let earn = await this.d.store.coinEventBySource("purchase", input.orderRef);
    if (earn === null || earn.userId !== input.userId) return null;
    if (isPendingSettlement(earn)) {
      if (!(await this.settleOne(earn))) return null; // ledger still down: retried by the caller
      earn = await this.d.store.coinEventBySource("purchase", input.orderRef);
      if (earn === null) return null;
    }
    const cfg = await currentConfig(this.d.store);
    // Read of the live balance happens before the lock; the decision under the lock also subtracts
    // coins reserved by sibling clawbacks not yet posted, so it can only under-reverse (more debt),
    // never take the cashback balance negative.
    const liveCoinsRead = (await this.d.credit.cashbackBalance(input.userId)) / earn.piastresPerCoin;
    const now = this.d.clock.nowMs();
    const res = await this.d.store.reserveClawback({
      userId: input.userId,
      orderRef: input.orderRef,
      refundRef: input.refundRef,
      decide: ({ earn: locked, userEvents, pendingReversible }) => {
        const children = userEvents.filter((e) => e.parentId === locked.id);
        const alreadyClawed = children.filter((e) => e.kind === "clawback").reduce((a, e) => a + -e.amount, 0n);
        const expired = children.filter((e) => e.kind === "expire").reduce((a, e) => a + -e.amount, 0n);
        const wanted = clawbackCoins({
          earned: locked.amount,
          alreadyClawed,
          orderNetMerchandise: input.orderNetMerchandise,
          refundedNetMerchandise: input.refundedNetMerchandise,
          cumulativeRefunded: input.cumulativeRefunded,
        });
        const room = locked.amount - alreadyClawed - expired;
        const effective = wanted < room ? wanted : room;
        if (effective <= 0n) return null;
        const lot = lotsOf(userEvents).find((l) => l.id === locked.id);
        const lotRemaining = lot?.remaining ?? 0n;
        const live = liveCoinsRead - pendingReversible;
        let reversible = effective;
        if (lotRemaining < reversible) reversible = lotRemaining;
        if (live < reversible) reversible = live;
        if (reversible < 0n) reversible = 0n;
        const debtAdded = effective - reversible;
        return {
          row: {
            id: this.d.ids.uuidV7(),
            userId: input.userId,
            kind: "clawback" as const,
            sub: locked.sub,
            amount: -effective,
            debtDelta: debtAdded,
            parentId: locked.id,
            sourceRef: input.refundRef,
            journalEntryId: null,
            expiresAtMs: null,
            piastresPerCoin: locked.piastresPerCoin,
            configVersion: cfg.version,
            createdAtMs: now,
          },
          events: [{ type: "coins.clawed_back" as const, userId: input.userId, coins: effective, debtAdded, sourceRef: input.refundRef }],
        };
      },
    });
    if (res.kind === "no_earn") return null;
    if (res.kind === "none") return { coins: 0n, debtAdded: 0n };
    return this.healClawback(res.row);
  }

  /** Posts the reversing entry of a reserved clawback (idempotent on its key) and records it. */
  private async healClawback(row: CoinEventRow): Promise<{ readonly coins: bigint; readonly debtAdded: bigint }> {
    const reversible = -row.amount - row.debtDelta;
    if (reversible > 0n && row.journalEntryId === null) {
      const r = await this.d.ledger.post(
        coinClawbackEntry(
          { userId: row.userId, sub: subOf(row.sub) as CoinSub & { kind: "cashback_coins" | "referral_credit" }, piastres: reversible * row.piastresPerCoin },
          {
            id: this.d.ids.uuidV7(),
            idempotencyKey: `rewards:clawback:${row.sourceRef}`,
            occurredAt: new Date(row.createdAtMs),
            ref: { type: "rewards", id: row.sourceRef },
          },
        ),
      );
      await this.d.store.setJournalEntry(row.id, r.entryId);
    }
    return { coins: -row.amount, debtAdded: row.debtDelta };
  }

  /** Expires due lots for one user: only the unspent part is written off, and each lot closes once. */
  async expireDue(userId: string): Promise<bigint> {
    await this.settlePending(userId);
    const now = this.d.clock.nowMs();
    const cfg = await currentConfig(this.d.store);
    const events = await this.d.store.coinEventsOf(userId);
    const lots = lotsOf(events).filter((l) => !l.closed);
    const balance = await this.d.credit.cashbackBalance(userId);
    const cashbackLots = lots.filter((l) => l.event.sub === "cashback_coins");
    const steps = planCoinExpiry(cashbackLots, balance, cfg.piastresPerCoin, now);
    const stepByLot = new Map(steps.map((s) => [s.lotId, s.coins]));
    let total = 0n;
    for (const lot of lots) {
      if (lot.expiresAtMs > now) continue;
      const coins = lot.event.sub === "cashback_coins" ? (stepByLot.get(lot.id) ?? 0n) : 0n;
      let journalEntryId: string | null = null;
      if (coins > 0n) {
        const r = await this.d.credit.expireCoins({
          userId,
          piastres: coins * lot.event.piastresPerCoin,
          idempotencyKey: `rewards:expire:${lot.id}`,
        });
        journalEntryId = r.entryId;
      }
      await this.d.store.appendCoinEvent(
        {
          id: this.d.ids.uuidV7(),
          userId,
          kind: "expire",
          sub: lot.event.sub,
          amount: -coins,
          debtDelta: 0n,
          parentId: lot.id,
          sourceRef: `expire:${lot.id}`,
          journalEntryId,
          expiresAtMs: null,
          piastresPerCoin: lot.event.piastresPerCoin,
          configVersion: cfg.version,
          createdAtMs: now,
        },
        coins > 0n ? [{ type: "coins.expired", userId, coins, lotId: lot.id }] : [],
      );
      total += coins;
    }
    return total;
  }
}

export type { RewardsStore };
