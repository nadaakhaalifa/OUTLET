import { sql, type Kysely, type RawBuilder } from "kysely";
import { z } from "zod";
import { ESCALATE_AFTER_MS, RECON_SOURCES, SEVERITIES, FINDING_KINDS, SETTLEMENT_LINE_KINDS, type SettlementLine } from "../domain/bridge";
import type {
  CommitResult,
  CommitRun,
  FileKind,
  LiveTicket,
  NewSettlementFile,
  OutboxEventDraft,
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
import { MS_1D } from "../domain/ports";

export type ReconDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const Amount = Int.transform((s) => BigInt(s));
const MAX_DATE_MS = 253_402_300_799_999;
const iso = (ms: number): string => new Date(Math.min(Math.max(ms, 0), MAX_DATE_MS)).toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ms = (col: string): string => `floor(extract(epoch from ${col}) * 1000)::text`;

const FileRow = z.object({
  id: z.string(),
  kind: z.enum(["psp", "cod", "bnpl"]),
  provider: z.string(),
  settlement_id: z.string().nullable(),
  checksum: z.string(),
  status: z.enum(["parsed", "rejected"]),
  line_count: z.number().int(),
  gross: Amount.nullable(),
  fee: Amount.nullable(),
  net: Amount.nullable(),
  error_codes: z.array(z.string()),
  received_ms: Ms,
});
const FILE_COLS = sql.raw(`
  id::text as id, kind, provider, settlement_id, checksum, status, line_count, gross_total::text as gross,
  fee_total::text as fee, net_total::text as net, error_codes, ${ms("received_at")} as received_ms`);
const LineRow = z.object({
  file_id: z.string(),
  line_no: z.number().int(),
  kind: z.enum(SETTLEMENT_LINE_KINDS),
  provider_ref: z.string(),
  gross: Amount,
  fee: Amount,
  net: Amount,
  occurred_ms: Ms,
});
const TicketRow = z.object({
  id: z.string(),
  dedupe_key: z.string(),
  source: z.enum(RECON_SOURCES),
  kind: z.enum(FINDING_KINDS),
  severity: z.enum(SEVERITIES),
  ref: z.string(),
  detail: z.string(),
  amount_delta: Amount,
  item_ms: Ms,
  status: z.enum(["open", "escalated", "resolved"]),
  first_ms: Ms,
  last_ms: Ms,
  escalated_ms: Ms.nullable(),
  resolved_ms: Ms.nullable(),
  last_run_id: z.string().nullable(),
});
const TICKET_COLS = sql.raw(`
  id::text as id, dedupe_key, source, kind, severity, ref, detail, amount_delta::text as amount_delta,
  ${ms("item_at")} as item_ms, status, ${ms("first_seen_at")} as first_ms, ${ms("last_seen_at")} as last_ms,
  ${ms("escalated_at")} as escalated_ms, ${ms("resolved_at")} as resolved_ms, last_run_id::text as last_run_id`);
const RunRow = z.object({
  id: z.string(),
  mode: z.enum(["nightly", "intraday"]),
  nightly_key: z.string().nullable(),
  started_ms: Ms,
  finished_ms: Ms,
  from_ms: Ms,
  to_ms: Ms,
  finding_count: z.number().int(),
  opened: z.number().int(),
  escalated: z.number().int(),
  resolved: z.number().int(),
  ok: z.boolean(),
});
const RUN_COLS = sql.raw(`
  id::text as id, mode, nightly_key, ${ms("started_at")} as started_ms, ${ms("finished_at")} as finished_ms,
  ${ms("window_from")} as from_ms, ${ms("window_to")} as to_ms, finding_count, opened, escalated, resolved, ok`);

const fileOf = (r: z.output<typeof FileRow>): SettlementFileRecord => ({
  id: r.id,
  kind: r.kind,
  provider: r.provider,
  settlementId: r.settlement_id,
  checksum: r.checksum,
  status: r.status,
  lineCount: r.line_count,
  gross: r.gross,
  fee: r.fee,
  net: r.net,
  errorCodes: r.error_codes,
  receivedAtMs: r.received_ms,
});
const ticketOf = (r: z.output<typeof TicketRow>): TicketRecord => ({
  id: r.id,
  dedupeKey: r.dedupe_key,
  source: r.source,
  kind: r.kind,
  severity: r.severity,
  ref: r.ref,
  detail: r.detail,
  amountDelta: r.amount_delta,
  itemAtMs: r.item_ms,
  status: r.status,
  firstSeenAtMs: r.first_ms,
  lastSeenAtMs: r.last_ms,
  escalatedAtMs: r.escalated_ms,
  resolvedAtMs: r.resolved_ms,
  lastRunId: r.last_run_id,
});
const runOf = (r: z.output<typeof RunRow>): RunRecord => ({
  id: r.id,
  mode: r.mode,
  nightlyKey: r.nightly_key,
  startedAtMs: r.started_ms,
  finishedAtMs: r.finished_ms,
  windowFromMs: r.from_ms,
  windowToMs: r.to_ms,
  findingCount: r.finding_count,
  opened: r.opened,
  escalated: r.escalated,
  resolved: r.resolved,
  ok: r.ok,
});

/**
 * Postgres adapter. Every call is one transaction as the `system` role (reads for Finance are
 * authorised by the controller through the central policy; RLS still restricts the table to
 * finance, ops, super_admin and system). Run, tickets and outbox events commit together.
 */
export class KyselyReconStore implements ReconStore {
  constructor(
    private readonly db: ReconDb,
    private readonly applicationRole: string | null = "app_user",
    private readonly role: "system" | "finance" = "system",
  ) {}

  private async tx<T>(run: (trx: ReconDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      const t = trx as unknown as ReconDb;
      if (this.applicationRole !== null) {
        if (!/^[a-z_][a-z0-9_]*$/.test(this.applicationRole)) throw new RangeError("invalid role name");
        await sql`SET LOCAL ROLE ${sql.id(this.applicationRole)}`.execute(t);
      }
      await sql`select set_config('app.role', ${this.role}, true), set_config('app.user_id', '', true),
                       set_config('app.store_ids', '', true)`.execute(t);
      return run(t);
    });
  }

  async saveFile(f: NewSettlementFile): Promise<SaveFileResult> {
    const r = f.record;
    return this.tx(async (trx) => {
      const ins = await sql<{ id: string }>`
        insert into settlement_files (id, kind, provider, settlement_id, checksum, status, line_count, gross_total,
                                      fee_total, net_total, error_codes, received_at)
        values (${r.id}::uuid, ${r.kind}, ${r.provider}, ${r.settlementId}, ${r.checksum}, ${r.status}, ${r.lineCount},
                ${r.gross === null ? null : r.gross.toString()}::bigint, ${r.fee === null ? null : r.fee.toString()}::bigint,
                ${r.net === null ? null : r.net.toString()}::bigint, ${[...r.errorCodes]}::text[],
                ${iso(r.receivedAtMs)}::timestamptz)
        on conflict (checksum) do nothing
        returning id::text as id`.execute(trx);
      if (ins.rows.length === 0) {
        const ex = await sql<unknown>`select ${FILE_COLS} from settlement_files where checksum = ${r.checksum}`.execute(trx);
        const row = ex.rows[0];
        if (row === undefined) throw new Error("settlement file vanished after conflict");
        return { kind: "duplicate" as const, file: fileOf(FileRow.parse(row)) };
      }
      for (const l of f.lines) {
        await sql`
          insert into settlement_file_lines (file_id, line_no, kind, provider_ref, gross, fee, net, occurred_at)
          values (${r.id}::uuid, ${l.lineNo}, ${l.kind}, ${l.providerRef}, ${l.gross.toString()}::bigint,
                  ${l.fee.toString()}::bigint, ${l.net.toString()}::bigint, ${iso(l.occurredAtMs)}::timestamptz)`.execute(trx);
      }
      return { kind: "stored" as const, file: r };
    });
  }

  async findParsedBySettlement(kind: FileKind, provider: string, settlementId: string): Promise<SettlementFileRecord | null> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${FILE_COLS} from settlement_files
         where kind = ${kind} and provider = ${provider} and settlement_id = ${settlementId} and status = 'parsed'`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : fileOf(FileRow.parse(row));
    });
  }

  async parsedFilesSince(sinceMs: number): Promise<readonly ParsedFileRecord[]> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${FILE_COLS} from settlement_files
         where status = 'parsed' and received_at >= ${iso(sinceMs)}::timestamptz order by received_at, id`.execute(trx);
      const files = r.rows.map((x) => fileOf(FileRow.parse(x)));
      if (files.length === 0) return [];
      const ids = files.map((x) => x.id);
      const ls = await sql<unknown>`
        select file_id::text as file_id, line_no, kind, provider_ref, gross::text as gross, fee::text as fee, net::text as net,
               ${sql.raw(ms("occurred_at"))} as occurred_ms
          from settlement_file_lines where file_id::text = any (${ids}::text[]) order by file_id, line_no`.execute(trx);
      const byFile = new Map<string, SettlementLine[]>();
      for (const raw of ls.rows) {
        const l = LineRow.parse(raw);
        byFile.set(l.file_id, [
          ...(byFile.get(l.file_id) ?? []),
          { lineNo: l.line_no, kind: l.kind, providerRef: l.provider_ref, gross: l.gross, fee: l.fee, net: l.net, occurredAtMs: l.occurred_ms },
        ]);
      }
      return files.map((f) => ({ ...f, settlementId: f.settlementId ?? "", lines: byFile.get(f.id) ?? [] }));
    });
  }

  async rejectedFilesSince(sinceMs: number): Promise<readonly SettlementFileRecord[]> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${FILE_COLS} from settlement_files
         where status = 'rejected' and received_at >= ${iso(sinceMs)}::timestamptz order by received_at, id`.execute(trx);
      return r.rows.map((x) => fileOf(FileRow.parse(x)));
    });
  }

  async listFiles(limit: number): Promise<readonly SettlementFileRecord[]> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${FILE_COLS} from settlement_files order by received_at desc, id desc limit ${limit}`.execute(trx);
      return r.rows.map((x) => fileOf(FileRow.parse(x)));
    });
  }

  async liveTickets(): Promise<readonly LiveTicket[]> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${TICKET_COLS} from recon_tickets where status <> 'resolved' order by item_at, id`.execute(trx);
      return r.rows.map((x) => {
        const t = ticketOf(TicketRow.parse(x));
        return {
          id: t.id,
          dedupeKey: t.dedupeKey,
          source: t.source,
          itemAtMs: t.itemAtMs,
          status: t.status,
          firstSeenAtMs: t.firstSeenAtMs,
          escalatedAtMs: t.escalatedAtMs,
        };
      });
    });
  }

  private static async insertEvent(trx: ReconDb, e: OutboxEventDraft): Promise<void> {
    await sql`
      insert into outbox_events (id, occurred_at, aggregate_type, aggregate_id, event_type, ordering_key, payload)
      values (${e.id}::uuid, ${iso(e.occurredAtMs)}::timestamptz, 'reconciliation', ${e.aggregateId}::uuid, ${e.type},
              ${`reconciliation:${e.aggregateId}`}, ${JSON.stringify(e.payload)}::jsonb)`.execute(trx);
  }

  async commitRun(c: CommitRun): Promise<CommitResult> {
    const run = c.run;
    return this.tx(async (trx) => {
      const ins = await sql<{ id: string }>`
        insert into recon_runs (id, mode, nightly_key, started_at, finished_at, window_from, window_to, finding_count,
                                opened, escalated, resolved, ok)
        values (${run.id}::uuid, ${run.mode}, ${run.nightlyKey}, ${iso(run.startedAtMs)}::timestamptz,
                ${iso(run.finishedAtMs)}::timestamptz, ${iso(run.windowFromMs)}::timestamptz,
                ${iso(run.windowToMs)}::timestamptz, ${run.findingCount}, ${run.opened}, ${run.escalated},
                ${run.resolved}, ${run.ok})
        on conflict (nightly_key) where mode = 'nightly' do nothing
        returning id::text as id`.execute(trx);
      if (ins.rows.length === 0) return { kind: "already_ran" as const };
      const now = iso(run.finishedAtMs);
      for (const u of c.upserts) {
        const f = u.finding;
        await sql`
          insert into recon_tickets (id, dedupe_key, source, kind, severity, ref, detail, amount_delta, item_at, status,
                                     first_seen_at, last_seen_at, escalated_at, last_run_id)
          values (${u.id}::uuid, ${f.dedupeKey}, ${f.source}, ${f.kind}, ${f.severity}, ${f.ref.slice(0, 160)},
                  ${f.detail.slice(0, 200)}, ${f.delta.toString()}::bigint, ${iso(f.atMs)}::timestamptz, ${u.status},
                  ${now}::timestamptz, ${now}::timestamptz,
                  ${u.status === "escalated" ? now : null}::timestamptz, ${run.id}::uuid)
          on conflict (dedupe_key) do update set
            severity = excluded.severity,
            detail = excluded.detail,
            amount_delta = excluded.amount_delta,
            item_at = excluded.item_at,
            last_seen_at = excluded.last_seen_at,
            last_run_id = excluded.last_run_id,
            first_seen_at = case when recon_tickets.status = 'resolved' then excluded.first_seen_at
                                 else recon_tickets.first_seen_at end,
            escalated_at = case when recon_tickets.status = 'resolved' then excluded.escalated_at
                                else coalesce(recon_tickets.escalated_at, excluded.escalated_at) end,
            resolved_at = null,
            status = excluded.status`.execute(trx);
      }
      if (c.resolveKeys.length > 0) {
        await sql`
          update recon_tickets set status = 'resolved', resolved_at = ${now}::timestamptz, last_run_id = ${run.id}::uuid
           where dedupe_key = any (${[...c.resolveKeys]}::text[]) and status <> 'resolved'`.execute(trx);
      }
      for (const e of c.events) await KyselyReconStore.insertEvent(trx, e);
      return { kind: "committed" as const };
    });
  }

  async lastNightlyKey(): Promise<string | null> {
    return this.tx(async (trx) => {
      const r = await sql<{ nightly_key: string }>`
        select nightly_key from recon_runs where mode = 'nightly' order by started_at desc, id desc limit 1`.execute(trx);
      return r.rows[0]?.nightly_key ?? null;
    });
  }

  async lastIntradayAtMs(): Promise<number | null> {
    return this.tx(async (trx) => {
      const r = await sql<{ at_ms: string }>`
        select ${sql.raw(ms("started_at"))} as at_ms from recon_runs where mode = 'intraday'
         order by started_at desc, id desc limit 1`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : Number(row.at_ms);
    });
  }

  async listTickets(q: TicketQuery): Promise<TicketPage> {
    return this.tx(async (trx) => {
      const parts: RawBuilder<unknown>[] = [sql`true`];
      if (q.status !== undefined) parts.push(sql`status = ${q.status}`);
      if (q.source !== undefined) parts.push(sql`source = ${q.source}`);
      if (q.severity !== undefined) parts.push(sql`severity = ${q.severity}`);
      if (q.after !== null) parts.push(sql`(item_at, id) > (${iso(q.after.itemAtMs)}::timestamptz, ${q.after.id}::uuid)`);
      const r = await sql<unknown>`
        select ${TICKET_COLS} from recon_tickets where ${sql.join(parts, sql` and `)}
         order by item_at, id limit ${q.limit + 1}`.execute(trx);
      const rows = r.rows.map((x) => ticketOf(TicketRow.parse(x)));
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return { items: page, next: rows.length > q.limit && last !== undefined ? { itemAtMs: last.itemAtMs, id: last.id } : null };
    });
  }

  async getTicket(id: string): Promise<TicketRecord | null> {
    if (!UUID.test(id)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${TICKET_COLS} from recon_tickets where id = ${id}::uuid`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : ticketOf(TicketRow.parse(row));
    });
  }

  async listRuns(limit: number): Promise<readonly RunRecord[]> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${RUN_COLS} from recon_runs order by started_at desc, id desc limit ${limit}`.execute(trx);
      return r.rows.map((x) => runOf(RunRow.parse(x)));
    });
  }

  async summary(nowMs: number): Promise<ReconSummary> {
    return this.tx(async (trx) => {
      const live = await sql<{ status: string; severity: string; source: string; n: string; oldest: string | null }>`
        select status, severity, source, count(*)::text as n, ${sql.raw(ms("min(item_at)"))} as oldest
          from recon_tickets where status <> 'resolved' group by status, severity, source`.execute(trx);
      const bySeverity = { critical: 0, high: 0, medium: 0 };
      const bySource: Partial<Record<TicketRecord["source"], number>> = {};
      let open = 0;
      let escalated = 0;
      let oldest: number | null = null;
      for (const r of live.rows) {
        const n = Number(r.n);
        if (r.status === "open") open += n;
        else escalated += n;
        if (r.severity === "critical" || r.severity === "high" || r.severity === "medium") bySeverity[r.severity] += n;
        const s = z.enum(RECON_SOURCES).parse(r.source);
        bySource[s] = (bySource[s] ?? 0) + n;
        if (r.oldest !== null) oldest = oldest === null ? Number(r.oldest) : Math.min(oldest, Number(r.oldest));
      }
      const cut1 = new Date(nowMs - MS_1D).toISOString();
      const cut3 = new Date(nowMs - ESCALATE_AFTER_MS).toISOString();
      const ag = await sql<{ source: string; lt1d: string; d1to3: string; gt3d: string }>`
        select source,
               count(*) filter (where item_at > ${cut1}::timestamptz)::text as lt1d,
               count(*) filter (where item_at <= ${cut1}::timestamptz and item_at >= ${cut3}::timestamptz)::text as d1to3,
               count(*) filter (where item_at < ${cut3}::timestamptz)::text as gt3d
          from recon_tickets where status <> 'resolved' group by source`.execute(trx);
      const aging: Partial<Record<TicketRecord["source"], { lt1d: number; d1to3: number; gt3d: number }>> = {};
      for (const r of ag.rows) aging[z.enum(RECON_SOURCES).parse(r.source)] = { lt1d: Number(r.lt1d), d1to3: Number(r.d1to3), gt3d: Number(r.gt3d) };
      const fr = await sql<{ kind: string; n: string; last: string }>`
        select kind, count(*)::text as n, ${sql.raw(ms("max(received_at)"))} as last from settlement_files group by kind`.execute(trx);
      const fileReceipts: Partial<Record<FileKind, { filesReceived: number; lastFileAtMs: number }>> = {};
      for (const r of fr.rows) fileReceipts[z.enum(["psp", "cod", "bnpl"]).parse(r.kind)] = { filesReceived: Number(r.n), lastFileAtMs: Number(r.last) };
      const rej = await sql<{ n: string }>`select count(*)::text as n from settlement_files where status = 'rejected'`.execute(trx);
      const lr = await sql<unknown>`select ${RUN_COLS} from recon_runs order by started_at desc, id desc limit 1`.execute(trx);
      const lastRaw = lr.rows[0];
      return {
        aging,
        fileReceipts,
        open,
        escalated,
        bySeverity,
        bySource,
        oldestItemAtMs: oldest,
        rejectedFiles: Number(rej.rows[0]?.n ?? 0),
        lastRun: lastRaw === undefined ? null : runOf(RunRow.parse(lastRaw)),
      };
    });
  }
}
