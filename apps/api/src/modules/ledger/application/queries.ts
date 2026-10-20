import type { BalanceQuery, BalanceRow, LedgerReadModel, ReadScope, StoredEntry } from "../domain/ports";

export class ListBalances {
  constructor(private readonly reads: LedgerReadModel) {}
  execute(scope: ReadScope, query: BalanceQuery): Promise<readonly BalanceRow[]> {
    return this.reads.balances(scope, query);
  }
}

export class GetEntry {
  constructor(private readonly reads: LedgerReadModel) {}
  execute(scope: ReadScope, id: string): Promise<StoredEntry | null> {
    return this.reads.entry(scope, id);
  }
}
