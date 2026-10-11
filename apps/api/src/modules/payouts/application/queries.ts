import { buildStatement, type Statement } from "../domain/bridge";
import type { ListPage, PayoutRecord, PayoutScope, PayoutStore, StatementSourcePort } from "../domain/ports";
import type { PayoutState } from "../domain/ports";

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
