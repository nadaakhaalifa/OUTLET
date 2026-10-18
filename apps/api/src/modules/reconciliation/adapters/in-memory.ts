import type {
  CommitResult,
  CommitRun,
  LiveTicket,
  NewSettlementFile,
  ParsedFileRecord,
  ReconStore,
  ReconSummary,
  RunRecord,
  SaveFileResult,
  SettlementFileRecord,
  TicketPage,
  TicketQuery,
  TicketRecord,
} from "../domain/ports";
import { MS_1D, type FileKind } from "../domain/ports";
import { ESCALATE_AFTER_MS, type SettlementLine } from "../domain/bridge";

type MutableTicket = { -readonly [K in keyof TicketRecord]: TicketRecord[K] };

/** In-memory ReconStore with the same observable behaviour as the Postgres adapter (shared suite). */
export class InMemoryReconStore implements ReconStore {
  private readonly files = new Map<string, { record: SettlementFileRecord; lines: readonly SettlementLine[] }>();
  private readonly runs: RunRecord[] = [];
  private readonly tickets = new Map<string, MutableTicket>();
  readonly outbox: { id: string; type: string; aggregateId: string; payload: Readonly<Record<string, unknown>> }[] = [];

  async saveFile(f: NewSettlementFile): Promise<SaveFileResult> {
    for (const e of this.files.values()) {
      if (e.record.checksum === f.record.checksum) return { kind: "duplicate", file: e.record };
    }
    if (
      f.record.status === "parsed" &&
      [...this.files.values()].some(
        (e) =>
          e.record.status === "parsed" &&
          e.record.kind === f.record.kind &&
          e.record.provider === f.record.provider &&
          e.record.settlementId === f.record.settlementId,
      )
    ) {
      throw new Error("settlement id already parsed for this provider");
    }
    this.files.set(f.record.id, { record: f.record, lines: f.lines });
    return { kind: "stored", file: f.record };
  }

  async findParsedBySettlement(kind: FileKind, provider: string, settlementId: string): Promise<SettlementFileRecord | null> {
    for (const e of this.files.values()) {
      const r = e.record;
      if (r.status === "parsed" && r.kind === kind && r.provider === provider && r.settlementId === settlementId) return r;
    }
    return null;
  }

  async parsedFilesSince(sinceMs: number): Promise<readonly ParsedFileRecord[]> {
    return [...this.files.values()]
      .filter((e) => e.record.status === "parsed" && e.record.receivedAtMs >= sinceMs)
      .sort((a, b) => a.record.receivedAtMs - b.record.receivedAtMs || (a.record.id < b.record.id ? -1 : 1))
      .map((e) => ({ ...e.record, settlementId: e.record.settlementId ?? "", lines: e.lines }));
  }

  async rejectedFilesSince(sinceMs: number): Promise<readonly SettlementFileRecord[]> {
    return [...this.files.values()]
      .map((e) => e.record)
      .filter((r) => r.status === "rejected" && r.receivedAtMs >= sinceMs)
      .sort((a, b) => a.receivedAtMs - b.receivedAtMs || (a.id < b.id ? -1 : 1));
  }

  async listFiles(limit: number): Promise<readonly SettlementFileRecord[]> {
    return [...this.files.values()]
      .map((e) => e.record)
      .sort((a, b) => b.receivedAtMs - a.receivedAtMs || (a.id < b.id ? 1 : -1))
      .slice(0, limit);
  }

  async liveTickets(): Promise<readonly LiveTicket[]> {
    return [...this.tickets.values()]
      .filter((t) => t.status !== "resolved")
      .map((t) => ({
        id: t.id,
        dedupeKey: t.dedupeKey,
        source: t.source,
        itemAtMs: t.itemAtMs,
        status: t.status,
        firstSeenAtMs: t.firstSeenAtMs,
        escalatedAtMs: t.escalatedAtMs,
      }));
  }

  async commitRun(c: CommitRun): Promise<CommitResult> {
    if (c.run.nightlyKey !== null && this.runs.some((r) => r.mode === "nightly" && r.nightlyKey === c.run.nightlyKey)) {
      return { kind: "already_ran" };
    }
    const now = c.run.finishedAtMs;
    this.runs.push(c.run);
    for (const u of c.upserts) {
      const f = u.finding;
      const prev = this.tickets.get(f.dedupeKey);
      if (prev === undefined) {
        this.tickets.set(f.dedupeKey, {
          id: u.id,
          dedupeKey: f.dedupeKey,
          source: f.source,
          kind: f.kind,
          severity: f.severity,
          ref: f.ref,
          detail: f.detail,
          amountDelta: f.delta,
          itemAtMs: f.atMs,
          status: u.status,
          firstSeenAtMs: now,
          lastSeenAtMs: now,
          escalatedAtMs: u.status === "escalated" ? now : null,
          resolvedAtMs: null,
          lastRunId: c.run.id,
        });
        continue;
      }
      const reopened = prev.status === "resolved";
      prev.severity = f.severity;
      prev.detail = f.detail;
      prev.amountDelta = f.delta;
      prev.itemAtMs = f.atMs;
      prev.lastSeenAtMs = now;
      prev.lastRunId = c.run.id;
      if (reopened) {
        prev.firstSeenAtMs = now;
        prev.escalatedAtMs = null;
        prev.resolvedAtMs = null;
      }
      prev.status = u.status;
      if (u.status === "escalated" && prev.escalatedAtMs === null) prev.escalatedAtMs = now;
    }
    for (const key of c.resolveKeys) {
      const t = this.tickets.get(key);
      if (t !== undefined && t.status !== "resolved") {
        t.status = "resolved";
        t.resolvedAtMs = now;
        t.lastRunId = c.run.id;
      }
    }
    for (const e of c.events) this.outbox.push({ id: e.id, type: e.type, aggregateId: e.aggregateId, payload: e.payload });
    return { kind: "committed" };
  }

  async lastNightlyKey(): Promise<string | null> {
    const n = this.runs.filter((r) => r.mode === "nightly").sort((a, b) => b.startedAtMs - a.startedAtMs)[0];
    return n?.nightlyKey ?? null;
  }

  async lastIntradayAtMs(): Promise<number | null> {
    const n = this.runs.filter((r) => r.mode === "intraday").sort((a, b) => b.startedAtMs - a.startedAtMs)[0];
    return n?.startedAtMs ?? null;
  }

  async listTickets(q: TicketQuery): Promise<TicketPage> {
    const rows = [...this.tickets.values()]
      .filter((t) => q.status === undefined || t.status === q.status)
      .filter((t) => q.source === undefined || t.source === q.source)
      .filter((t) => q.severity === undefined || t.severity === q.severity)
      .sort((a, b) => a.itemAtMs - b.itemAtMs || (a.id < b.id ? -1 : 1))
      .filter((t) => q.after === null || t.itemAtMs > q.after.itemAtMs || (t.itemAtMs === q.after.itemAtMs && t.id > q.after.id));
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((t) => ({ ...t })),
      next: rows.length > q.limit && last !== undefined ? { itemAtMs: last.itemAtMs, id: last.id } : null,
    };
  }

  async getTicket(id: string): Promise<TicketRecord | null> {
    for (const t of this.tickets.values()) if (t.id === id) return { ...t };
    return null;
  }

  async listRuns(limit: number): Promise<readonly RunRecord[]> {
    return [...this.runs].sort((a, b) => b.startedAtMs - a.startedAtMs).slice(0, limit);
  }

  async summary(nowMs: number): Promise<ReconSummary> {
    const live = [...this.tickets.values()].filter((t) => t.status !== "resolved");
    const bySeverity = { critical: 0, high: 0, medium: 0 };
    const bySource: Partial<Record<TicketRecord["source"], number>> = {};
    for (const t of live) {
      bySeverity[t.severity] += 1;
      bySource[t.source] = (bySource[t.source] ?? 0) + 1;
    }
    const oldest = live.reduce<number | null>((m, t) => (m === null || t.itemAtMs < m ? t.itemAtMs : m), null);
    const last = [...this.runs].sort((a, b) => b.startedAtMs - a.startedAtMs)[0] ?? null;
    const aging: Partial<Record<TicketRecord["source"], { lt1d: number; d1to3: number; gt3d: number }>> = {};
    for (const t of live) {
      const a = (aging[t.source] ??= { lt1d: 0, d1to3: 0, gt3d: 0 });
      const age = nowMs - t.itemAtMs;
      if (age < MS_1D) a.lt1d += 1;
      else if (age > ESCALATE_AFTER_MS) a.gt3d += 1;
      else a.d1to3 += 1;
    }
    const fileReceipts: Partial<Record<FileKind, { filesReceived: number; lastFileAtMs: number }>> = {};
    for (const e of this.files.values()) {
      const r = (fileReceipts[e.record.kind] ??= { filesReceived: 0, lastFileAtMs: e.record.receivedAtMs });
      r.filesReceived += 1;
      r.lastFileAtMs = Math.max(r.lastFileAtMs, e.record.receivedAtMs);
    }
    return {
      aging,
      fileReceipts,
      open: live.filter((t) => t.status === "open").length,
      escalated: live.filter((t) => t.status === "escalated").length,
      bySeverity,
      bySource,
      oldestItemAtMs: oldest,
      rejectedFiles: [...this.files.values()].filter((e) => e.record.status === "rejected").length,
      lastRun: last,
    };
  }
}
