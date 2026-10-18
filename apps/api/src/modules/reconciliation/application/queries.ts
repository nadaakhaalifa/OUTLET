import { RECON_SOURCES, type ReconSource } from "../domain/bridge";
import type {
  AgeBuckets,
  FileKind,
  ReconStore,
  ReconSummary,
  RunRecord,
  SettlementFileRecord,
  TicketPage,
  TicketQuery,
  TicketRecord,
} from "../domain/ports";

export type RailInput = "configured" | "unconfigured";
/** Sources fed by an external settlement or submission input (B-2 `rails`). */
export const RAIL_SOURCES = ["psp_settlement", "cod_remittance", "bnpl_settlement", "eta_submission"] as const;
export type RailSource = (typeof RAIL_SOURCES)[number];
const FILE_KIND_OF: Readonly<Record<RailSource, FileKind | null>> = {
  psp_settlement: "psp",
  cod_remittance: "cod",
  bnpl_settlement: "bnpl",
  eta_submission: null,
};
/** Provider-readiness lookup per rail. Absent or throwing means "unconfigured" (never a guess in the other direction). */
export type RailInputs = () => Partial<Record<RailSource, RailInput>>;

export interface RailStatus {
  readonly source: RailSource;
  readonly lastFileAtMs: number | null;
  /** null: this rail has no settlement files (ETA submissions are API based), so "no files" must not be inferred. */
  readonly filesReceived: number | null;
  readonly input: RailInput;
}
export interface ReconSummaryView extends ReconSummary {
  readonly aging: Readonly<Record<ReconSource, AgeBuckets>>;
  readonly unmatchedOver3d: number;
  readonly rails: readonly RailStatus[];
}

/** Finance read model: tickets, runs, files and the aging summary. Read only. */
export class FinanceReconReadModel {
  constructor(
    private readonly store: ReconStore,
    private readonly now: () => number = () => Date.now(),
    private readonly railInputs: RailInputs = () => ({}),
  ) {}
  async summary(): Promise<ReconSummaryView> {
    const s = await this.store.summary(this.now());
    const aging = Object.fromEntries(
      RECON_SOURCES.map((src) => [src, s.aging?.[src] ?? { lt1d: 0, d1to3: 0, gt3d: 0 }]),
    ) as Record<ReconSource, AgeBuckets>;
    let inputs: Partial<Record<RailSource, RailInput>> = {};
    try {
      inputs = this.railInputs();
    } catch {
      inputs = {};
    }
    const rails = RAIL_SOURCES.map((source): RailStatus => {
      const kind = FILE_KIND_OF[source];
      const receipt = kind === null ? undefined : s.fileReceipts?.[kind];
      return {
        source,
        lastFileAtMs: receipt?.lastFileAtMs ?? null,
        filesReceived: kind === null ? null : (receipt?.filesReceived ?? 0),
        input: inputs[source] ?? "unconfigured",
      };
    });
    // Rail sources only: store_credit, trial_balance and run are NOT counted here.
    const unmatchedOver3d = RAIL_SOURCES.reduce((n, src) => n + aging[src].gt3d, 0);
    return { ...s, aging, unmatchedOver3d, rails };
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
