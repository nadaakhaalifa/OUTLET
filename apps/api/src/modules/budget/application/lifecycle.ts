import { cycleFor } from "../domain/bridge";
import type { BudgetStore } from "../domain/ports";
import { refreshCycle, type BudgetDeps } from "./shared";

/** Consent withdrawn (consent.changed) or account deleted: every budget row goes, nothing retained. */
export class PurgeUserBudget {
  constructor(private readonly d: BudgetDeps) {}
  async execute(userId: string, reason: "consent_withdrawn" | "account_deleted"): Promise<boolean> {
    return this.d.store.run(userId, async (tx) => {
      const n = await tx.deleteAll();
      if (n > 0) await tx.emit([{ type: "budget.data_purged", userId, reason }]);
      return n > 0;
    });
  }
}

/**
 * Daily job, idempotent per (user, cycle): creates the cycle row once (emitting
 * `budget.cycle_rolled`) and doubles as the 24 h backstop for consent withdrawal: a user whose
 * consent is no longer granted is purged instead of rolled.
 */
export class RollCycles {
  constructor(
    private readonly d: BudgetDeps,
    private readonly store: BudgetStore,
  ) {}

  async execute(pageSize = 200): Promise<{ readonly rolled: number; readonly purged: number; readonly skipped: number }> {
    const d = this.d;
    let rolled = 0;
    let purged = 0;
    let skipped = 0;
    let after: string | null = null;
    for (;;) {
      const users = await this.store.usersWithBudget(after, pageSize);
      if (users.length === 0) break;
      for (const userId of users) {
        const now = d.clock.nowMs();
        const granted = await d.consent.isGranted(userId);
        const r = await d.store.run(userId, async (tx) => {
          const b = await tx.getBudget();
          if (b === null) return "skipped" as const;
          if (!granted) {
            await tx.deleteAll();
            await tx.emit([{ type: "budget.data_purged", userId, reason: "consent_withdrawn" }]);
            return "purged" as const;
          }
          const cycle = cycleFor(b.payday, now);
          if ((await tx.getCycle(cycle.startMs)) !== null) return "skipped" as const;
          await refreshCycle(d, tx, userId, b.payday, now, now);
          await tx.emit([{ type: "budget.cycle_rolled", userId, cycleStartMs: cycle.startMs }]);
          return "rolled" as const;
        });
        if (r === "rolled") rolled += 1;
        else if (r === "purged") purged += 1;
        else skipped += 1;
      }
      after = users[users.length - 1] ?? null;
      if (users.length < pageSize) break;
    }
    return { rolled, purged, skipped };
  }
}

export interface BudgetExport {
  readonly budget: { readonly amount: string; readonly perCategory: Record<string, string>; readonly payday: number; readonly capMode: string } | null;
  readonly cycles: readonly { readonly start: string; readonly end: string; readonly spent: string; readonly refunded: string }[];
  readonly commitments: readonly { readonly provider: string; readonly monthly: string; readonly source: string; readonly start: string; readonly end: string }[];
}

/** DSAR export (spec Security and abuse): every budget field of the user, decrypted for the owner. */
export class ExportBudgetData {
  constructor(private readonly d: BudgetDeps) {}
  async execute(userId: string): Promise<BudgetExport> {
    const d = this.d;
    return d.store.read(userId, async (tx) => {
      const rec = await tx.getBudget();
      const settings = rec === null ? null : await d.codec.openBudget(rec);
      const cycles = await Promise.all(
        (await tx.listCycles(120)).map(async (c) => {
          const v = await d.codec.openCycle(c);
          return { start: new Date(c.startMs).toISOString(), end: new Date(c.endMs).toISOString(), spent: v.spent.toString(), refunded: v.refunded.toString() };
        }),
      );
      const commitments = await Promise.all(
        (await tx.listCommitments()).map(async (c) => ({
          provider: c.provider,
          monthly: (await d.codec.openCommitment(c)).monthly.toString(),
          source: c.source,
          start: new Date(c.startsAtMs).toISOString(),
          end: new Date(c.endsAtMs).toISOString(),
        })),
      );
      return {
        budget:
          settings === null
            ? null
            : {
                amount: settings.amount.toString(),
                perCategory: Object.fromEntries(Object.entries(settings.perCategory).map(([k, v]) => [k, v.toString()])),
                payday: settings.payday,
                capMode: settings.capMode,
              },
        cycles,
        commitments,
      };
    });
  }
}
