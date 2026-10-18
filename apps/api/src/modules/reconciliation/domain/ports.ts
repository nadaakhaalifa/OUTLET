import type {
  EtaInternal,
  EtaReported,
  Finding,
  FindingKind,
  ParseResult,
  ProjectionRow,
  ReconLine,
  ReconSource,
  SettlementLine,
  Severity,
  StoredBalance,
  TicketSnapshot,
  TicketStatus,
} from "./bridge";

export type FileKind = "psp" | "cod" | "bnpl";
export const FILE_FORMATS = ["fixture_csv_v1"] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

export interface SettlementFileRecord {
  readonly id: string;
  readonly kind: FileKind;
  readonly provider: string;
  readonly settlementId: string | null;
  readonly checksum: string;
  readonly status: "parsed" | "rejected";
  readonly lineCount: number;
  readonly gross: bigint | null;
  readonly fee: bigint | null;
  readonly net: bigint | null;
  readonly errorCodes: readonly string[];
  readonly receivedAtMs: number;
}

export interface ParsedFileRecord extends SettlementFileRecord {
  readonly settlementId: string;
  readonly lines: readonly SettlementLine[];
}

export interface NewSettlementFile {
  readonly record: SettlementFileRecord;
  readonly lines: readonly SettlementLine[];
}

export type SaveFileResult =
  | { readonly kind: "stored"; readonly file: SettlementFileRecord }
  | { readonly kind: "duplicate"; readonly file: SettlementFileRecord };

export interface RunRecord {
  readonly id: string;
  readonly mode: "nightly" | "intraday";
  readonly nightlyKey: string | null;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly windowFromMs: number;
  readonly windowToMs: number;
  readonly findingCount: number;
  readonly opened: number;
  readonly escalated: number;
  readonly resolved: number;
  readonly ok: boolean;
}

export interface TicketRecord {
  readonly id: string;
  readonly dedupeKey: string;
  readonly source: ReconSource;
  readonly kind: FindingKind;
  readonly severity: Severity;
  readonly ref: string;
  readonly detail: string;
  readonly amountDelta: bigint;
  readonly itemAtMs: number;
  readonly status: TicketStatus;
  readonly firstSeenAtMs: number;
  readonly lastSeenAtMs: number;
  readonly escalatedAtMs: number | null;
  readonly resolvedAtMs: number | null;
  readonly lastRunId: string | null;
}

export interface LiveTicket extends TicketSnapshot {
  readonly id: string;
  readonly dedupeKey: string;
  readonly source: ReconSource;
  readonly itemAtMs: number;
}

export interface TicketUpsert {
  /** Used only when the ticket is new. */
  readonly id: string;
  readonly finding: Finding;
  readonly status: "open" | "escalated";
}

export interface OutboxEventDraft {
  readonly id: string;
  readonly type: string;
  readonly aggregateId: string;
  readonly occurredAtMs: number;
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
}

export interface CommitRun {
  readonly run: RunRecord;
  readonly upserts: readonly TicketUpsert[];
  readonly resolveKeys: readonly string[];
  readonly events: readonly OutboxEventDraft[];
}

export type CommitResult = { readonly kind: "committed" } | { readonly kind: "already_ran" };

export interface TicketQuery {
  readonly status?: TicketStatus;
  readonly source?: ReconSource;
  readonly severity?: Severity;
  readonly after: { readonly itemAtMs: number; readonly id: string } | null;
  readonly limit: number;
}

export interface TicketPage {
  readonly items: readonly TicketRecord[];
  readonly next: { readonly itemAtMs: number; readonly id: string } | null;
}

/** Live-ticket age buckets (B-2). Age = now - item_at. lt_1d: < 24 h. d1_3: 24 h to 72 h inclusive. gt_3d: strictly over 72 h (ESCALATE_AFTER_MS). */
export interface AgeBuckets {
  readonly lt1d: number;
  readonly d1to3: number;
  readonly gt3d: number;
}
export const MS_1D = 24 * 60 * 60 * 1000;

/** Settlement files received per kind (parsed or rejected). Absent kind = none received. */
export interface FileReceipt {
  readonly filesReceived: number;
  readonly lastFileAtMs: number;
}

export interface ReconSummary {
  /** Sparse: sources with no live ticket are absent (the read model fills zeros). */
  readonly aging?: Readonly<Partial<Record<ReconSource, AgeBuckets>>>;
  readonly fileReceipts?: Readonly<Partial<Record<FileKind, FileReceipt>>>;
  readonly open: number;
  readonly escalated: number;
  readonly bySeverity: Readonly<Record<Severity, number>>;
  readonly bySource: Readonly<Partial<Record<ReconSource, number>>>;
  /** Item time of the oldest live ticket. */
  readonly oldestItemAtMs: number | null;
  readonly rejectedFiles: number;
  readonly lastRun: RunRecord | null;
}

export interface ReconStore {
  /** Idempotent by checksum. A duplicate writes nothing. */
  saveFile(f: NewSettlementFile): Promise<SaveFileResult>;
  findParsedBySettlement(kind: FileKind, provider: string, settlementId: string): Promise<SettlementFileRecord | null>;
  /** Parsed files received at or after `sinceMs`, with their lines. */
  parsedFilesSince(sinceMs: number): Promise<readonly ParsedFileRecord[]>;
  rejectedFilesSince(sinceMs: number): Promise<readonly SettlementFileRecord[]>;
  listFiles(limit: number): Promise<readonly SettlementFileRecord[]>;
  liveTickets(): Promise<readonly LiveTicket[]>;
  /** One transaction: run row, ticket upserts, resolutions and outbox events. */
  commitRun(c: CommitRun): Promise<CommitResult>;
  lastNightlyKey(): Promise<string | null>;
  lastIntradayAtMs(): Promise<number | null>;
  listTickets(q: TicketQuery): Promise<TicketPage>;
  getTicket(id: string): Promise<TicketRecord | null>;
  listRuns(limit: number): Promise<readonly RunRecord[]>;
  /** `nowMs` anchors the age buckets. */
  summary(nowMs: number): Promise<ReconSummary>;
}

// ---------------------------------------------------------------- ports to other modules

/** Provider file parser (VERIFY: VR-F1-11). The fixture adapter wraps the pure domain parser. */
export interface SettlementFilePort {
  parse(raw: { readonly format: FileFormat; readonly provider: string; readonly content: string }): ParseResult;
}

/** Ledger movements on a clearing account and the settlement entry already posted for a file. */
export interface LedgerClearingPort {
  clearingLines(q: {
    readonly kind: FileKind;
    readonly party: string;
    readonly fromMs: number;
    readonly toMs: number;
  }): Promise<readonly ReconLine[]>;
  postedSettlement(q: {
    readonly kind: FileKind;
    readonly party: string;
    readonly settlementId: string;
  }): Promise<{ readonly gross: bigint; readonly fee: bigint } | null>;
}

export interface EtaSourcePort {
  internal(sinceMs: number): Promise<readonly EtaInternal[]>;
  reported(sinceMs: number): Promise<readonly EtaReported[]>;
}

export interface IntegrityPort {
  totals(): Promise<ReadonlyMap<string, bigint>>;
  projection(): Promise<readonly ProjectionRow[]>;
  balances(): Promise<readonly StoredBalance[]>;
}

export interface ReconAlert {
  readonly type: "ticket_opened" | "ticket_escalated";
  readonly ticketId: string;
  readonly source: ReconSource;
  readonly kind: FindingKind;
  readonly severity: Severity;
  readonly ref: string;
  readonly amountDelta: bigint;
}

export interface ReconAlertPort {
  notify(a: ReconAlert): Promise<void>;
}

export interface ReconFlagsPort {
  /** Mega-event mode: turns the intraday run on. */
  intradayEnabled(): Promise<boolean> | boolean;
}
