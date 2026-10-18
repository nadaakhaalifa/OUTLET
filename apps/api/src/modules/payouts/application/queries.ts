import { buildStatement, nextCycleRun, PAYOUT_STATES, MS_PER_DAY, type CycleConfig, type Statement } from "../domain/bridge";
import { computeStoreBalance, type StoreBalance } from "../domain/balance";
import type { ListPage, PayoutLedgerPort, PayoutRecord, PayoutScope, PayoutSourcePort, PayoutStore, StatementSourcePort } from "../domain/ports";
import type { PayoutState } from "../domain/ports";

/** SETTLED and CANCELLED are counted over this many days only (B-1). */
export const PAYOUT_SUMMARY_WINDOW_DAYS = 30;

export interface PayoutStateSummary {
  readonly count: number;
  readonly amount: bigint;
  readonly oldestUpdatedAtMs: number | null;
  /** Present for ON_HOLD only; a payout with no recorded reason counts under "unspecified" so the buckets sum to `count`. */
  readonly byHoldReason?: Readonly<Record<string, number>>;
  /** Present for FAILED only; same rule with "unspecified". */
  readonly byFailureCode?: Readonly<Record<string, number>>;
}
export interface PayoutSummary {
  readonly asOfMs: number;
  readonly nextCycleAtMs: number;
  readonly byState: Readonly<Record<PayoutState, PayoutStateSummary>>;
  readonly settledWindowDays: number;
}

/** B-1: payout totals by state for the finance console. Read only; one aggregate query. */
export class PayoutSummaryQuery {
  constructor(
    private readonly store: PayoutStore,
    private readonly cycle: CycleConfig,
  ) {}

  async execute(a: { scope: PayoutScope; nowMs: number }): Promise<PayoutSummary> {
    const raw = await this.store.summaryByState(a.scope, a.nowMs - PAYOUT_SUMMARY_WINDOW_DAYS * MS_PER_DAY);
    const byState = {} as Record<PayoutState, PayoutStateSummary>;
    for (const st of PAYOUT_STATES) {
      const t = raw[st];
      if (t === undefined) {
        byState[st] = {
          count: 0,
          amount: 0n,
          oldestUpdatedAtMs: null,
          ...(st === "ON_HOLD" ? { byHoldReason: {} } : {}),
          ...(st === "FAILED" ? { byFailureCode: {} } : {}),
        };
        continue;
      }
      const bucket = (m: Readonly<Record<string, number>>): Record<string, number> => {
        const known = Object.values(m).reduce((x, y) => x + y, 0);
        return known === t.count ? { ...m } : { ...m, unspecified: t.count - known };
      };
      byState[st] = {
        count: t.count,
        amount: t.amount,
        oldestUpdatedAtMs: t.oldestUpdatedAtMs,
        ...(st === "ON_HOLD" ? { byHoldReason: bucket(t.byHoldReason) } : {}),
        ...(st === "FAILED" ? { byFailureCode: bucket(t.byFailureCode) } : {}),
      };
    }
    return { asOfMs: a.nowMs, nextCycleAtMs: nextCycleRun(a.nowMs, this.cycle), byState, settledWindowDays: PAYOUT_SUMMARY_WINDOW_DAYS };
  }
}

export class GetPayout {
  constructor(private readonly store: PayoutStore) {}
  /** Null for unknown and for a payout outside the scope alike (404, API1). */
  execute(a: { scope: PayoutScope; payoutId: string }): Promise<PayoutRecord | null> {
    return this.store.get(a.payoutId, a.scope);
  }
}

export class ListPayouts {
  constructor(private readonly store: PayoutStore) {}
  execute(a: {
    scope: PayoutScope;
    storeId?: string;
    status?: PayoutState;
    cycleKey?: string;
    after: { createdAtMs: number; id: string } | null;
    limit: number;
  }): Promise<ListPage> {
    return this.store.list({
      scope: a.scope,
      ...(a.storeId !== undefined ? { storeId: a.storeId } : {}),
      ...(a.status !== undefined ? { status: a.status } : {}),
      ...(a.cycleKey !== undefined ? { cycleKey: a.cycleKey } : {}),
      after: a.after,
      limit: a.limit,
    });
  }
}

export interface StatementView {
  readonly statement: Statement;
  /** Payouts of the period with their netting, so the seller sees what was set off. */
  readonly payouts: readonly {
    readonly id: string;
    readonly cycleKey: string;
    readonly status: PayoutState;
    readonly amount: bigint;
    readonly eligibleTotal: bigint;
    readonly nettedTotal: bigint;
    readonly carryForward: bigint;
  }[];
}

export class SellerStatements {
  constructor(
    private readonly store: PayoutStore,
    private readonly source: StatementSourcePort,
  ) {}

  async execute(a: { scope: PayoutScope; storeId: string; fromMs: number; toMs: number }): Promise<StatementView> {
    const facts = await this.source.facts(a.storeId, a.toMs);
    const movements = await this.store.movements(a.storeId);
    const payoutFacts = movements.map((m) => ({
      type: m.kind,
      id: m.id,
      storeId: a.storeId,
      atMs: m.atMs,
      amount: m.amount,
    }));
    const statement = buildStatement({
      storeId: a.storeId,
      fromMs: a.fromMs,
      toMs: a.toMs,
      facts: [...facts, ...payoutFacts],
    });
    const page = await this.store.list({ scope: a.scope, storeId: a.storeId, after: null, limit: 200 });
    const payouts = page.items
      .filter((p) => p.createdAtMs >= a.fromMs && p.createdAtMs < a.toMs && p.status !== "CANCELLED")
      .map((p) => ({
        id: p.id,
        cycleKey: p.cycleKey,
        status: p.status,
        amount: p.amount,
        eligibleTotal: p.eligibleTotal,
        nettedTotal: p.nettedTotal,
        carryForward: p.carryForward,
      }));
    return { statement, payouts };
  }
}

export interface StoreBalanceView extends StoreBalance {
  readonly asOfMs: number;
}

/**
 * Read-only seller balance (ADR-0050). Ledger `seller_payable` bounds `available`; no posting is written.
 * Payouts ON_HOLD and in transit are summed by one aggregate each, with no reason or date.
 */
export class GetStoreBalance {
  constructor(
    private readonly store: PayoutStore,
    private readonly source: PayoutSourcePort,
    private readonly ledger: PayoutLedgerPort,
    private readonly now: () => number,
  ) {}

  async execute(a: { storeId: string; scope: PayoutScope }): Promise<StoreBalanceView> {
    const nowMs = this.now();
    const [active, applied, rawItems, rawClawbacks, ledgerPayable] = await Promise.all([
      this.store.activeSellerOrderIds(a.storeId),
      this.store.appliedClawbacks(a.storeId),
      this.source.items(a.storeId, nowMs),
      this.source.clawbacks(a.storeId),
      this.ledger.payableBalance(a.storeId),
    ]);
    const totals = await this.store.balanceTotals(a.scope, a.storeId);
    const balance = computeStoreBalance({
      storeId: a.storeId,
      nowMs,
      items: rawItems.filter((i) => !active.has(i.sellerOrderId)),
      clawbacks: rawClawbacks
        .map((c) => ({ ...c, amount: c.amount - (applied.get(c.id) ?? 0n) }))
        .filter((c) => c.amount > 0n),
      heldPayoutTotal: totals.held,
      inTransitPayoutTotal: totals.inTransit,
      ledgerPayable,
    });
    return { ...balance, asOfMs: nowMs };
  }
}
