import { Controller, Get, Inject, Param, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { AuthenticatedSelf, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import { RECON_SOURCES, SEVERITIES } from "../domain/bridge";
import type { FinanceReconReadModel } from "../application/queries";
import type { RunRecord, SettlementFileRecord, TicketRecord } from "../domain/ports";
import { ReconAccess } from "./access";
import { FINANCE_RECON_READ } from "./tokens";

const IdParam = z.object({ id: z.uuid() }).strict();
const TicketQuery = z
  .object({
    status: z.enum(["open", "escalated", "resolved"]).optional(),
    source: z.enum(RECON_SOURCES).optional(),
    severity: z.enum(SEVERITIES).optional(),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const LimitQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();
const CursorBody = z.object({ t: z.number().int().nonnegative().max(8.64e15), i: z.uuid() }).strict();

const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms));
const money = (a: bigint) => ({ amount: a.toString(), currency: "EGP" as const });

const ticketWire = (t: TicketRecord) => ({
  id: t.id,
  source: t.source,
  kind: t.kind,
  severity: t.severity,
  status: t.status,
  ref: t.ref,
  detail: t.detail,
  amount_delta: money(t.amountDelta),
  item_at: iso(t.itemAtMs),
  first_seen_at: iso(t.firstSeenAtMs),
  last_seen_at: iso(t.lastSeenAtMs),
  escalated_at: isoOrNull(t.escalatedAtMs),
  resolved_at: isoOrNull(t.resolvedAtMs),
  last_run_id: t.lastRunId,
});
const runWire = (r: RunRecord) => ({
  id: r.id,
  mode: r.mode,
  started_at: iso(r.startedAtMs),
  finished_at: iso(r.finishedAtMs),
  window_from: iso(r.windowFromMs),
  window_to: iso(r.windowToMs),
  finding_count: r.findingCount,
  opened: r.opened,
  escalated: r.escalated,
  resolved: r.resolved,
  ok: r.ok,
});
const fileWire = (f: SettlementFileRecord) => ({
  id: f.id,
  kind: f.kind,
  provider: f.provider,
  settlement_id: f.settlementId,
  status: f.status,
  line_count: f.lineCount,
  gross_total: f.gross === null ? null : money(f.gross),
  fee_total: f.fee === null ? null : money(f.fee),
  net_total: f.net === null ? null : money(f.net),
  error_codes: f.errorCodes,
  received_at: iso(f.receivedAtMs),
});

function decodeCursor(raw: string | undefined): { itemAtMs: number; id: string } | null {
  if (raw === undefined) return null;
  try {
    const p = CursorBody.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return { itemAtMs: p.t, id: p.i };
  } catch {
    throw Problems.validation([{ pointer: "/query/cursor", code: "invalid_cursor" }]);
  }
}
const encodeCursor = (c: { itemAtMs: number; id: string }): string =>
  Buffer.from(JSON.stringify({ t: c.itemAtMs, i: c.id })).toString("base64url");

function actorOf(req: ApiRequest) {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p.actor;
}

/** Finance console read model (read-only, no idempotency keys needed). */
@Controller("admin/finance/reconciliation")
export class ReconciliationController {
  constructor(
    @Inject(ReconAccess) private readonly access: ReconAccess,
    @Inject(FINANCE_RECON_READ) private readonly read: FinanceReconReadModel,
  ) {}

  @Get("summary")
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async summary(@Req() req: ApiRequest) {
    await this.access.require(actorOf(req));
    const s = await this.read.summary();
    return {
      open: s.open,
      escalated: s.escalated,
      by_severity: s.bySeverity,
      by_source: s.bySource,
      oldest_item_at: isoOrNull(s.oldestItemAtMs),
      rejected_files: s.rejectedFiles,
      last_run: s.lastRun === null ? null : runWire(s.lastRun),
    };
  }

  @Get("tickets")
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async tickets(@Req() req: ApiRequest, @Query(new ZodPipe(TicketQuery, "/query")) q: z.output<typeof TicketQuery>) {
    await this.access.require(actorOf(req));
    const page = await this.read.tickets({
      ...(q.status !== undefined ? { status: q.status } : {}),
      ...(q.source !== undefined ? { source: q.source } : {}),
      ...(q.severity !== undefined ? { severity: q.severity } : {}),
      after: decodeCursor(q.cursor),
      limit: q.limit,
    });
    return {
      items: page.items.map(ticketWire),
      page: { next_cursor: page.next === null ? null : encodeCursor(page.next), has_more: page.next !== null },
    };
  }

  @Get("tickets/:id")
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async ticket(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>) {
    await this.access.require(actorOf(req));
    const t = await this.read.ticket(params.id);
    if (t === null) throw Problems.notFound();
    return ticketWire(t);
  }

  @Get("runs")
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async runs(@Req() req: ApiRequest, @Query(new ZodPipe(LimitQuery, "/query")) q: z.output<typeof LimitQuery>) {
    await this.access.require(actorOf(req));
    return { items: (await this.read.runs(q.limit)).map(runWire) };
  }

  @Get("files")
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async files(@Req() req: ApiRequest, @Query(new ZodPipe(LimitQuery, "/query")) q: z.output<typeof LimitQuery>) {
    await this.access.require(actorOf(req));
    return { items: (await this.read.files(q.limit)).map(fileWire) };
  }
}
