import {
  breakdown,
  previousCycle,
  validateBudget,
  cycleTotals,
  type BudgetSettings,
  type CapMode,
  type Commitment,
  type Remaining,
} from "../domain/bridge";
import type { BudgetRecord } from "../domain/ports";
import { loadSnapshot, refreshCycle, remainingOf, type BudgetDeps, type Snapshot } from "./shared";

export interface CommitmentInput {
  readonly provider: string;
  readonly monthly: bigint;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
}

export type SetBudgetResult =
  | { readonly kind: "ok"; readonly created: boolean }
  | { readonly kind: "consent_required" }
  | { readonly kind: "disabled" }
  | { readonly kind: "invalid"; readonly errors: readonly { readonly field: string; readonly code: string }[] };

/**
 * PUT /v1/me/budget. Nothing is stored or computed before the budget_insights consent. A first
 * set (or a payday change) backfills the current cycle from the order source; backfill keys are
 * idempotent so repeating the call never double counts.
 */
export class SetBudget {
  constructor(private readonly d: BudgetDeps) {}

  async execute(input: {
    readonly userId: string;
    readonly amount: bigint;
    readonly perCategory: Readonly<Record<string, bigint>>;
    readonly payday: number;
    readonly capMode: CapMode;
    readonly installments: readonly CommitmentInput[];
  }): Promise<SetBudgetResult> {
    const d = this.d;
    if (!(await d.flags.suiteEnabled())) return { kind: "disabled" };
    if (!(await d.consent.isGranted(input.userId))) return { kind: "consent_required" };
    const v = validateBudget({ amount: input.amount, perCategory: input.perCategory, payday: input.payday, capMode: input.capMode });
    if (!v.ok) return { kind: "invalid", errors: v.errors };
    const bad: { field: string; code: string }[] = [];
    input.installments.forEach((c, i) => {
      if (c.monthly <= 0n) bad.push({ field: `installments.${i}.monthly`, code: "must_be_positive" });
      if (c.endsAtMs < c.startsAtMs) bad.push({ field: `installments.${i}.ends_at`, code: "before_start" });
    });
    if (bad.length > 0) return { kind: "invalid", errors: bad };

    const now = d.clock.nowMs();
    const settings: BudgetSettings = v.value;
    const userCommitments = await Promise.all(
      input.installments.map((c) =>
        d.codec.sealCommitment(input.userId, { provider: c.provider.trim(), monthly: c.monthly, startsAtMs: c.startsAtMs, endsAtMs: c.endsAtMs, source: "user" }),
      ),
    );
    return d.store.run(input.userId, async (tx) => {
      const existing = await tx.getBudget();
      const rec: BudgetRecord = await d.codec.sealBudget(
        input.userId,
        settings,
        // switching away from hard cap clears a pending unlock; otherwise keep the maturity
        settings.capMode === "hard" ? (existing?.holdUntilMs ?? null) : null,
        (existing?.version ?? 0) + 1,
        { created: existing?.createdAtMs ?? now, updated: now },
      );
      await tx.putBudget(rec);
      await tx.replaceCommitments("user", userCommitments);
      const cycle = (await refreshCycle(d, tx, input.userId, settings.payday, now, now)).cycle;
      // Backfill the current cycle (minimal window) so the first summary is not empty. Idempotent keys.
      for (const e of await d.spendSource.listSpend(input.userId, cycle.startMs, now)) {
        await tx.insertSpendEvent(await d.codec.sealEvent(input.userId, e));
      }
      await refreshCycle(d, tx, input.userId, settings.payday, now, now);
      await tx.emit([{ type: "budget.set", userId: input.userId, capMode: settings.capMode, hasCategories: Object.keys(settings.perCategory).length > 0 }]);
      return { kind: "ok", created: existing === null };
    });
  }
}

export interface SummaryView {
  readonly cycle: { readonly startDate: string; readonly endDate: string; readonly startMs: number; readonly endMs: number };
  readonly settings: BudgetSettings;
  readonly remaining: Remaining;
  readonly includeBag: boolean;
  readonly installments: readonly { readonly provider: string; readonly monthly: bigint; readonly source: Commitment["source"]; readonly label: "estimate" }[];
  readonly byCategory: readonly { readonly id: string; readonly amount: bigint; readonly limit: bigint | null }[];
  readonly topStores: readonly { readonly id: string; readonly amount: bigint }[];
  readonly netSpent: bigint;
  readonly previousNetSpent: bigint;
  readonly verifiedSavings: bigint;
  readonly plusSavings: bigint;
  readonly hardCapUnlockAtMs: number | null;
}

export type SummaryResult =
  | { readonly kind: "ok"; readonly view: SummaryView }
  | { readonly kind: "empty" }
  | { readonly kind: "consent_required" }
  | { readonly kind: "disabled" };

export class GetSummary {
  constructor(private readonly d: BudgetDeps) {}

  async execute(userId: string, includeBag: boolean): Promise<SummaryResult> {
    const d = this.d;
    if (!(await d.flags.suiteEnabled())) return { kind: "disabled" };
    if (!(await d.consent.isGranted(userId))) return { kind: "consent_required" };
    const now = d.clock.nowMs();
    const snap = await d.store.read(userId, (tx) => loadSnapshot(d, tx, now));
    if (snap === null) return { kind: "empty" };
    const bag = includeBag ? await d.bag.bagTotal(userId) : 0n;
    return { kind: "ok", view: viewOf(snap, bag, includeBag, now) };
  }
}

function viewOf(s: Snapshot, bag: bigint, includeBag: boolean, now: number): SummaryView {
  const b = breakdown(s.events, s.cycle);
  const prev = previousCycle(s.settings.payday, s.cycle);
  const prevTotals = cycleTotals(s.events, prev);
  const unlockAt = s.holdUntilMs !== null && s.holdUntilMs > now ? s.holdUntilMs : null;
  const categoryIds = new Set([...b.byCategory.map((r) => r.id), ...Object.keys(s.settings.perCategory)]);
  return {
    cycle: { startDate: s.cycle.startDate, endDate: s.cycle.endDate, startMs: s.cycle.startMs, endMs: s.cycle.endMs },
    settings: s.settings,
    remaining: remainingOf(s, bag, includeBag),
    includeBag,
    installments: s.commitments
      .filter((c) => c.startsAtMs < s.cycle.endMs && c.endsAtMs >= s.cycle.startMs)
      .map((c) => ({ provider: c.provider, monthly: c.monthly, source: c.source, label: "estimate" as const })),
    byCategory: [...categoryIds].sort().map((id) => ({
      id,
      amount: b.byCategory.find((r) => r.id === id)?.amount ?? 0n,
      limit: s.settings.perCategory[id] ?? null,
    })),
    topStores: b.topStores,
    netSpent: s.totals.netSpentReport,
    previousNetSpent: prevTotals.netSpentReport,
    verifiedSavings: s.totals.verifiedSavings,
    plusSavings: s.totals.plusSavings,
    hardCapUnlockAtMs: unlockAt,
  };
}

/** DELETE /v1/me/budget: erases every row, nothing is retained (spec edge cases). */
export class DeleteBudget {
  constructor(private readonly d: BudgetDeps) {}
  async execute(userId: string): Promise<{ readonly deleted: boolean }> {
    return this.d.store.run(userId, async (tx) => {
      const n = await tx.deleteAll();
      if (n > 0) await tx.emit([{ type: "budget.data_purged", userId, reason: "user_request" }]);
      return { deleted: n > 0 };
    });
  }
}
