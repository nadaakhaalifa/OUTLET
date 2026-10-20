import { cycleFor, type Commitment, type SpendEvent } from "../domain/bridge";
import { refreshCycle, type BudgetDeps } from "./shared";

export type RecordSpendResult = "recorded" | "duplicate" | "ignored_no_budget" | "ignored_no_consent";

/**
 * Handler for order and refund events (inbox consumer). Collects nothing for a user without a
 * budget, and purges on a withdrawn consent. Keys are idempotent: a replayed event is a no-op.
 */
export class RecordSpend {
  constructor(private readonly d: BudgetDeps) {}

  async execute(userId: string, event: SpendEvent): Promise<RecordSpendResult> {
    const d = this.d;
    if (event.amount <= 0n) return "ignored_no_budget";
    const sealed = await d.codec.sealEvent(userId, event);
    const now = d.clock.nowMs();
    return d.store.run(userId, async (tx) => {
      const b = await tx.getBudget();
      if (b === null) return "ignored_no_budget";
      if (!(await d.consent.isGranted(userId))) {
        await tx.deleteAll();
        await tx.emit([{ type: "budget.data_purged", userId, reason: "consent_withdrawn" }]);
        return "ignored_no_consent";
      }
      if ((await tx.insertSpendEvent(sealed)) === "exists") return "duplicate";
      const touched = new Set<number>([event.orderPlacedAtMs, event.occurredAtMs].map((t) => cycleFor(b.payday, t).startMs));
      for (const startMs of touched) {
        const r = await refreshCycle(d, tx, userId, b.payday, startMs, now);
        if (r.inserted) await tx.emit([{ type: "budget.cycle_rolled", userId, cycleStartMs: r.cycle.startMs }]);
      }
      return "recorded";
    });
  }
}

/** Nightly: compare the event log with the orders source for the current cycle and repair drift. */
export class ReconcileSpend {
  constructor(private readonly d: BudgetDeps) {}

  async execute(userId: string): Promise<{ readonly inserted: number; readonly mismatched: number }> {
    const d = this.d;
    const now = d.clock.nowMs();
    return d.store.run(userId, async (tx) => {
      const b = await tx.getBudget();
      if (b === null || !(await d.consent.isGranted(userId))) return { inserted: 0, mismatched: 0 };
      const cycle = cycleFor(b.payday, now);
      const known = new Map((await tx.listSpendEvents(cycle.startMs)).map((r) => [r.key, r]));
      let inserted = 0;
      let mismatched = 0;
      for (const e of await d.spendSource.listSpend(userId, cycle.startMs, now)) {
        const have = known.get(e.key);
        if (have === undefined) {
          await tx.insertSpendEvent(await d.codec.sealEvent(userId, e));
          inserted += 1;
        } else if ((await d.codec.openEvent(have)).amount !== e.amount) {
          mismatched += 1;
        }
      }
      if (inserted > 0) await refreshCycle(d, tx, userId, b.payday, now, now);
      return { inserted, mismatched };
    });
  }
}

/** Provider data (BNPL schedules) replaces earlier provider rows; user entries are untouched. */
export class IngestProviderCommitments {
  constructor(private readonly d: BudgetDeps) {}

  async execute(userId: string, items: readonly Omit<Commitment, "source">[]): Promise<"ok" | "ignored"> {
    const d = this.d;
    const sealed = await Promise.all(items.map((c) => d.codec.sealCommitment(userId, { ...c, source: "provider" })));
    return d.store.run(userId, async (tx) => {
      if ((await tx.getBudget()) === null || !(await d.consent.isGranted(userId))) return "ignored";
      await tx.replaceCommitments("provider", sealed);
      return "ok";
    });
  }
}
