import {
  balancesOf,
  expiringSoon,
  type ExpiringSoon,
  type SubBalanceView,
} from "../domain/bridge";
import type { ClockPort, CreditTxn, StoreCreditStore } from "../domain/ports";

export const EXPIRING_WINDOW_MS = 30 * 86_400_000;

export interface WalletView {
  readonly balances: readonly SubBalanceView[];
  readonly expiringSoon: readonly ExpiringSoon[];
  readonly totalAvailable: bigint;
  readonly totalHeld: bigint;
  readonly asOfMs: number;
}

/** Keyed by the token subject only: there is no object id to enumerate. */
export class GetWallet {
  constructor(
    private readonly store: StoreCreditStore,
    private readonly clock: ClockPort,
  ) {}
  async execute(userId: string): Promise<WalletView> {
    const now = this.clock.nowMs();
    const lots = await this.store.listLots(userId);
    const balances = balancesOf(lots, now);
    return {
      balances,
      expiringSoon: expiringSoon(lots, now, EXPIRING_WINDOW_MS),
      totalAvailable: balances.reduce((a, b) => a + b.available, 0n),
      totalHeld: balances.reduce((a, b) => a + b.held, 0n),
      asOfMs: now,
    };
  }
}

export class ListWalletTransactions {
  constructor(private readonly store: StoreCreditStore) {}
  async execute(
    userId: string,
    after: { createdAtMs: number; id: string } | null,
    limit: number,
  ): Promise<{ items: readonly CreditTxn[]; hasMore: boolean }> {
    const rows = await this.store.listTransactions(userId, { after, limit: limit + 1 });
    return { items: rows.slice(0, limit), hasMore: rows.length > limit };
  }
}
