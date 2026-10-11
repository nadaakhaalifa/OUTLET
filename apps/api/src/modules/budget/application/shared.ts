import {
  computeRemaining,
  cycleFor,
  cycleTotals,
  installmentsDue,
  previousCycle,
  type BudgetSettings,
  type Commitment,
  type Cycle,
  type CycleTotals,
  type Remaining,
  type SpendEvent,
} from "../domain/bridge";
import type {
  BagTotalPort,
  BudgetConsentPort,
  BudgetFlagsPort,
  BudgetStore,
  BudgetTx,
  Clock,
  IdPort,
  OrderSpendSourcePort,
} from "../domain/ports";
import type { BudgetCodec } from "./codec";

export interface BudgetDeps {
  readonly store: BudgetStore;
  readonly clock: Clock;
  readonly ids: IdPort;
  readonly consent: BudgetConsentPort;
  readonly codec: BudgetCodec;
  readonly flags: BudgetFlagsPort;
  readonly spendSource: OrderSpendSourcePort;
  readonly bag: BagTotalPort;
}

export interface Snapshot {
  readonly settings: BudgetSettings;
  readonly holdUntilMs: number | null;
  readonly cycle: Cycle;
  readonly events: readonly SpendEvent[];
  readonly commitments: readonly Commitment[];
  readonly totals: CycleTotals;
  readonly installments: bigint;
}

/** Decrypts one user's state inside a transaction. Null when the user has no budget. */
export async function loadSnapshot(d: BudgetDeps, tx: BudgetTx, nowMs: number): Promise<Snapshot | null> {
  const rec = await tx.getBudget();
  if (rec === null) return null;
  const settings = await d.codec.openBudget(rec);
  const cycle = cycleFor(settings.payday, nowMs);
  const since = previousCycle(settings.payday, cycle).startMs;
  const events = await Promise.all((await tx.listSpendEvents(since)).map((r) => d.codec.openEvent(r)));
  const commitments = await Promise.all((await tx.listCommitments()).map((r) => d.codec.openCommitment(r)));
  return {
    settings,
    holdUntilMs: rec.holdUntilMs,
    cycle,
    events,
    commitments,
    totals: cycleTotals(events, cycle),
    installments: installmentsDue(commitments, cycle),
  };
}

export function remainingOf(s: Snapshot, bagTotal: bigint, includeBag: boolean): Remaining {
  return computeRemaining({
    budget: s.settings.amount,
    spent: s.totals.spentNow,
    bagTotal,
    includeBag,
    installmentsDue: s.installments,
  });
}

/** Recomputes and stores the cached totals of one cycle from the event log. Returns whether the row is new. */
export async function refreshCycle(
  d: BudgetDeps,
  tx: BudgetTx,
  userId: string,
  payday: number,
  at: number,
  nowMs: number,
): Promise<{ cycle: Cycle; inserted: boolean }> {
  const cycle = cycleFor(payday, at);
  const events = await Promise.all((await tx.listSpendEvents(cycle.startMs)).map((r) => d.codec.openEvent(r)));
  const t = cycleTotals(events, cycle);
  const existing = await tx.getCycle(cycle.startMs);
  const rec = await d.codec.sealCycle(
    userId,
    { startMs: cycle.startMs, endMs: cycle.endMs, spent: t.placed, refunded: t.refundedToOrigin, refundReceived: t.refundsReceived },
    existing?.rolledAtMs ?? nowMs,
    nowMs,
  );
  const r = await tx.putCycle(rec);
  return { cycle, inserted: r === "inserted" };
}

export const iso = (ms: number): string => new Date(ms).toISOString();
