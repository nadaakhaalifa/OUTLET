import { parseSettlementCsv, type EtaInternal, type EtaReported, type ParseResult, type ProjectionRow, type ReconLine, type StoredBalance } from "../domain/bridge";
import type {
  EtaSourcePort,
  FileFormat,
  FileKind,
  IntegrityPort,
  LedgerClearingPort,
  ReconAlert,
  ReconAlertPort,
  ReconFlagsPort,
  SettlementFilePort,
} from "../domain/ports";

/** FIXTURE format only (VERIFY: VR-F1-11). A real provider format is a new adapter, not a change here. */
export class FixtureSettlementFilePort implements SettlementFilePort {
  parse(raw: { format: FileFormat; provider: string; content: string }): ParseResult {
    return parseSettlementCsv(raw.content, { provider: raw.provider });
  }
}

const k = (kind: FileKind, party: string): string => `${kind}:${party}`;

/** Ledger clearing movements and posted settlements held in memory. */
export class FakeLedgerClearing implements LedgerClearingPort {
  readonly lines = new Map<string, ReconLine[]>();
  readonly posted = new Map<string, { gross: bigint; fee: bigint }>();

  addLine(kind: FileKind, party: string, line: ReconLine): void {
    this.lines.set(k(kind, party), [...(this.lines.get(k(kind, party)) ?? []), line]);
  }
  post(kind: FileKind, party: string, settlementId: string, gross: bigint, fee: bigint): void {
    this.posted.set(`${k(kind, party)}:${settlementId}`, { gross, fee });
  }
  async clearingLines(q: { kind: FileKind; party: string; fromMs: number; toMs: number }): Promise<readonly ReconLine[]> {
    return (this.lines.get(k(q.kind, q.party)) ?? []).filter((l) => l.atMs >= q.fromMs && l.atMs <= q.toMs);
  }
  async postedSettlement(q: { kind: FileKind; party: string; settlementId: string }) {
    return this.posted.get(`${k(q.kind, q.party)}:${q.settlementId}`) ?? null;
  }
}

export class FakeEtaSource implements EtaSourcePort {
  readonly internalDocs: EtaInternal[] = [];
  readonly reportedDocs: EtaReported[] = [];
  async internal(): Promise<readonly EtaInternal[]> {
    return this.internalDocs;
  }
  async reported(): Promise<readonly EtaReported[]> {
    return this.reportedDocs;
  }
}

export class FakeIntegrity implements IntegrityPort {
  totalsByCurrency = new Map<string, bigint>([["EGP", 0n]]);
  projectionRows: ProjectionRow[] = [];
  balanceRows: StoredBalance[] = [];
  failTotals = false;
  async totals(): Promise<ReadonlyMap<string, bigint>> {
    if (this.failTotals) throw new Error("integrity source unavailable");
    return this.totalsByCurrency;
  }
  async projection(): Promise<readonly ProjectionRow[]> {
    return this.projectionRows;
  }
  async balances(): Promise<readonly StoredBalance[]> {
    return this.balanceRows;
  }
}

export class FakeReconAlerts implements ReconAlertPort {
  readonly sent: ReconAlert[] = [];
  fail = false;
  async notify(a: ReconAlert): Promise<void> {
    if (this.fail) throw new Error("alert channel down");
    this.sent.push(a);
  }
}

export class FakeReconFlags implements ReconFlagsPort {
  intraday = false;
  intradayEnabled(): boolean {
    return this.intraday;
  }
}
