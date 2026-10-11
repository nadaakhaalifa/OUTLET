import type { ReconStore, ReconSummary, RunRecord, SettlementFileRecord, TicketPage, TicketQuery, TicketRecord } from "../domain/ports";

/** Finance read model: tickets, runs, files and the aging summary. Read only. */
export class FinanceReconReadModel {
  constructor(private readonly store: ReconStore) {}
  summary(): Promise<ReconSummary> {
    return this.store.summary();
  }
  tickets(q: TicketQuery): Promise<TicketPage> {
    return this.store.listTickets(q);
  }
  ticket(id: string): Promise<TicketRecord | null> {
    return this.store.getTicket(id);
  }
  runs(limit: number): Promise<readonly RunRecord[]> {
    return this.store.listRuns(limit);
  }
  files(limit: number): Promise<readonly SettlementFileRecord[]> {
    return this.store.listFiles(limit);
  }
}
