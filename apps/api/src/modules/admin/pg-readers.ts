import { z } from "zod";
import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import { authorize } from "@outlet/policy";
import type { Principal } from "@outlet/policy";
import { REQUIRED_DOCUMENTS, SellerAccountsError } from "@outlet/seller-accounts";
import type { SellerOnboardingService } from "@outlet/seller-accounts";
import { decodeCursor, encodeCursor } from "../../platform/cursor.js";
import { Problems } from "../../platform/problem.js";
import type {
  AdminKycCase, ApprovalRequestDto, ApprovalRequestPage, ApprovalsQuery, ItemsQuery, KycCaseSummaryPage, KycCasesQuery, KycDecisionInput, KycDecisionResult, ReconciliationItemDto, ReconciliationItemPage,
  ReconciliationRunDto, ReconciliationRunPage, RunsQuery,
} from "./dto.js";
import type { ApprovalCount, ApprovalReaderPort, KycAdminPort, KycCount, ReconciliationReaderPort } from "./services.js";

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();
const isoOrNull = (v: Date | string | null): string | null => (v === null ? null : iso(v));
const DAY_MS = 86_400_000;

/** Approval requests of the staff's market (policy approval_requests_user_isolation: market only). */
export class PgApprovalReader implements ApprovalReaderPort {
  constructor(private readonly db: RoleSqlClient<"outlet_app">, private readonly now: () => Date = () => new Date()) {}

  /**
   * Dashboard tile: PENDING, unexpired requests the caller may still decide: not their own, not already voted by them, and of an action their roles can
   * decide (the same rule AdminAccess applies when a vote is cast; elevation.approve is decided by role.grant holders). One grouped statement, counted per action in code.
   */
  async countPending(p: Principal): Promise<ApprovalCount> {
    if (p.userId === undefined) return { forMe: 0, soonestExpiresAt: null };
    const at = this.now().toISOString();
    const rows = await withDbContext(this.db, { kind: "user", marketId: p.marketId, userId: p.userId }, (tx) =>
      tx.query<{ action: string; n: number; soonest: Date | string }>(
        `SELECT r.action, count(*)::int AS n, min(r.expires_at) AS soonest FROM approval_requests r
          WHERE r.market_id = $1 AND r.status = 'PENDING' AND r.expires_at > $2::timestamptz AND r.requested_by <> $3::uuid
            AND NOT EXISTS (SELECT 1 FROM approval_decisions d WHERE d.approval_request_id = r.id AND d.approver_id = $3::uuid)
          GROUP BY r.action`,
        [p.marketId, at, p.userId],
      ),
    );
    let forMe = 0;
    let soonest: string | null = null;
    for (const r of rows.rows) {
      if (authorize(p, r.action === "elevation.approve" ? "role.grant" : r.action, { type: "admin_access", marketId: p.marketId }).effect !== "allow") continue;
      forMe += r.n;
      const e = iso(r.soonest);
      if (soonest === null || e < soonest) soonest = e;
    }
    return { forMe, soonestExpiresAt: soonest };
  }

  private static map(r: Row): ApprovalRequestDto {
    const executed = r.status === "APPROVED" && r.executed_at !== null;
    return {
      id: r.id, action: r.action, target_type: r.target_type, target_id: r.target_id, requested_by: r.requested_by, status: executed ? "EXECUTED" : r.status,
      created_at: iso(r.created_at), expires_at: iso(r.expires_at), decided_by: r.decided_by, decided_at: isoOrNull(r.decided_at), reason: r.reason === null ? null : r.reason.slice(0, 500),
    };
  }

  async list(p: Principal, q: ApprovalsQuery): Promise<ApprovalRequestPage> {
    const params: unknown[] = [p.marketId];
    const where: string[] = ["market_id = $1"];
    if (q.status !== undefined) {
      if (q.status === "EXECUTED") where.push("status = 'APPROVED' AND executed_at IS NOT NULL");
      else if (q.status === "APPROVED") where.push("status = 'APPROVED' AND executed_at IS NULL");
      else where.push(`status = $${String(params.push(q.status))}`);
    }
    if (q.action !== undefined) where.push(`action = $${String(params.push(q.action))}`);
    if (q.cursor !== undefined) {
      const [at, id] = decodeCursor(q.cursor, 2);
      if (at === undefined || id === undefined || Number.isNaN(Date.parse(at))) throw Problems.badRequest("cursor-invalid");
      where.push(`(created_at, id) < ($${String(params.push(at))}::timestamptz, $${String(params.push(id))}::uuid)`);
    }
    const rows = await withDbContext(this.db, { kind: "user", marketId: p.marketId, ...(p.userId === undefined ? {} : { userId: p.userId }) }, (tx) =>
      tx.query<Row>(`SELECT ${COLS} FROM approval_requests WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ${String(q.limit + 1)}`, params),
    );
    const page = rows.rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { items: page.map((r) => PgApprovalReader.map(r)), next_cursor: rows.rows.length > q.limit && last !== undefined ? encodeCursor(iso(last.created_at), last.id) : null };
  }

  async get(p: Principal, id: string): Promise<ApprovalRequestDto> {
    const r = await withDbContext(this.db, { kind: "user", marketId: p.marketId, ...(p.userId === undefined ? {} : { userId: p.userId }) }, (tx) =>
      tx.query<Row>(`SELECT ${COLS} FROM approval_requests WHERE id = $1 AND market_id = $2`, [id, p.marketId]),
    );
    const row = r.rows[0];
    if (row === undefined) throw Problems.notFound();
    return PgApprovalReader.map(row);
  }
}

interface Row {
  id: string; action: string; target_type: string; target_id: string; requested_by: string; status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
  created_at: Date | string; expires_at: Date | string; decided_by: string | null; decided_at: Date | string | null; reason: string | null; executed_at: Date | string | null;
}
const COLS = "id, action, target_type, target_id, requested_by, status, created_at, expires_at, decided_by, decided_at, reason, executed_at";

interface DetailRow {
  id: string; seller_id: string; kind: string; state: AdminKycCase["case"]["status"]; submitted_at: Date | string | null; decided_at: Date | string | null; reason_note: string | null; version: number;
  provider: string | null; check_results: unknown; legal_name_ar: string | null; legal_name_en: string | null; commercial_register_no: string | null; tax_card_no: string | null; governorate_name_ar: string | null;
}
interface DocRow { id: string; kind: AdminKycCase["case"]["documents"][number]["doc_type"]; media_asset_id: string; status: string; expires_on: Date | string | null; created_at: Date | string }
const CheckStored = z.array(z.object({ type: z.string(), result: z.string(), scoreBp: z.number().int().min(0).max(10000).optional(), checkedAt: z.string() }));
const dateOnly = (v: Date | string | null): string | null => (v === null ? null : (v instanceof Date ? v.toISOString() : v).slice(0, 10));

const kycProblem = (e: unknown): unknown => {
  if (!(e instanceof SellerAccountsError)) return e;
  switch (e.code) {
    case "not_found": return Problems.notFound();
    case "forbidden": return Problems.forbidden();
    case "conflict":
    case "invalid_transition": return Problems.conflict("invalid-transition");
    default: return Problems.unprocessable(e.code.replaceAll("_", "-"), e.details.map((d) => ({ path: "/body", code: d })));
  }
};

interface CaseListRow { id: string; seller_id: string; legal_name_ar: string | null; state: KycCaseSummaryPage["items"][number]["status"]; submitted_at: Date | string | null }

/**
 * KYC queue and decisions. Reads run as the `seller.kyc` worker job (ADR-0011: the staff principal is proven by the guard, the service
 * re-checks `seller_kyc.review` before every write). The decision itself is SellerOnboardingService.decide.
 */
export class PgKycAdmin implements KycAdminPort {
  constructor(
    private readonly worker: RoleSqlClient<"outlet_worker">,
    private readonly onboarding: Pick<SellerOnboardingService, "decide">,
  ) {}

  async list(marketId: string, q: KycCasesQuery): Promise<KycCaseSummaryPage> {
    const params: unknown[] = [marketId];
    const where = ["c.market_id = $1", "c.kind = 'onboarding'", "c.submitted_at IS NOT NULL"];
    if (q.status !== undefined) where.push(`c.state = $${String(params.push(q.status))}`);
    if (q.cursor !== undefined) {
      const [at, id] = decodeCursor(q.cursor, 2);
      if (at === undefined || id === undefined || Number.isNaN(Date.parse(at))) throw Problems.badRequest("cursor-invalid");
      where.push(`(c.submitted_at, c.id) < ($${String(params.push(at))}::timestamptz, $${String(params.push(id))}::uuid)`);
    }
    const r = await withDbContext(this.worker, { kind: "worker", marketId, job: "seller.kyc" }, (tx: Queryable) =>
      tx.query<CaseListRow>(
        `SELECT c.id, c.seller_id, s.legal_name_ar, c.state, c.submitted_at FROM kyc_cases c JOIN sellers s ON s.id = c.seller_id
          WHERE ${where.join(" AND ")} ORDER BY c.submitted_at DESC, c.id DESC LIMIT ${String(q.limit + 1)}`,
        params,
      ),
    );
    const page = r.rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((c) => ({ id: c.id, seller_id: c.seller_id, legal_name_ar: c.legal_name_ar ?? "", status: c.state, submitted_at: isoOrNull(c.submitted_at) })),
      next_cursor: r.rows.length > q.limit && last?.submitted_at != null ? encodeCursor(iso(last.submitted_at), last.id) : null,
    };
  }

  /** Dashboard tile: cases waiting for staff (SUBMITTED / AUTO_CHECKS) and waiting for the applicant (NEEDS_INFO), one statement on the queue index. */
  async count(marketId: string): Promise<KycCount> {
    const r = await withDbContext(this.worker, { kind: "worker", marketId, job: "seller.kyc" }, (tx: Queryable) =>
      tx.query<{ submitted: number; needs_info: number; oldest: Date | string | null }>(
        `SELECT count(*) FILTER (WHERE state IN ('SUBMITTED', 'AUTO_CHECKS'))::int AS submitted, count(*) FILTER (WHERE state = 'NEEDS_INFO')::int AS needs_info, min(submitted_at) AS oldest
           FROM kyc_cases WHERE market_id = $1 AND kind = 'onboarding' AND submitted_at IS NOT NULL AND state IN ('SUBMITTED', 'AUTO_CHECKS', 'NEEDS_INFO')`,
        [marketId],
      ),
    );
    const row = r.rows[0];
    return { submitted: row?.submitted ?? 0, needsInfo: row?.needs_info ?? 0, oldestAt: row?.oldest == null ? null : iso(row.oldest) };
  }

  async detail(marketId: string, caseId: string): Promise<AdminKycCase | null> {
    return withDbContext(this.worker, { kind: "worker", marketId, job: "seller.kyc" }, async (tx: Queryable) => {
      const c = (await tx.query<DetailRow>(
        `SELECT c.id, c.seller_id, c.kind, c.state, c.submitted_at, c.decided_at, c.reason_note, c.version, c.provider, c.check_results,
                s.legal_name_ar, s.legal_name_en, s.commercial_register_no, s.tax_card_no, s.governorate_name_ar
           FROM kyc_cases c JOIN sellers s ON s.id = c.seller_id WHERE c.id = $1 AND c.market_id = $2`,
        [caseId, marketId],
      )).rows[0];
      if (c === undefined) return null;
      const docs = await tx.query<DocRow>(
        "SELECT id, kind, media_asset_id, status, expires_on, created_at FROM kyc_documents WHERE case_id = $1 AND market_id = $2 AND status <> 'superseded' ORDER BY created_at, id LIMIT 50", [c.id, marketId]);
      const stored = CheckStored.safeParse(c.check_results);
      const checks = (stored.success ? stored.data : []).slice(0, 50).map((k) => ({ check_type: k.type, result: k.result, score_bp: k.scoreBp ?? null, provider: c.provider, checked_at: iso(k.checkedAt) }));
      return {
        case: {
          id: c.id, seller_id: c.seller_id, kind: c.kind, status: c.state, submitted_at: isoOrNull(c.submitted_at), decided_at: isoOrNull(c.decided_at), decision_reason: c.reason_note === null ? null : c.reason_note.slice(0, 500),
          version: c.version, required_documents: [...REQUIRED_DOCUMENTS], signatory: null,
          documents: docs.rows.map((d) => ({ id: d.id, doc_type: d.kind, media_id: d.media_asset_id, verified: d.status === "verified", expires_on: dateOnly(d.expires_on), created_at: iso(d.created_at) })),
        },
        seller_legal: {
          legal_name_ar: c.legal_name_ar ?? "", legal_name_en: c.legal_name_en, commercial_register_no: c.commercial_register_no ?? "", tax_card_no: c.tax_card_no ?? "", governorate_name_ar: c.governorate_name_ar ?? "",
        },
        checks,
      };
    });
  }

  async decide(p: Principal, caseId: string, input: KycDecisionInput): Promise<KycDecisionResult> {
    const note = [input.decision_reason, ...(input.requested_documents === undefined || input.requested_documents.length === 0 ? [] : [`requested: ${input.requested_documents.join(",")}`])].join(" | ").slice(0, 2000);
    const decision = input.decision === "APPROVED" ? "approve" : input.decision === "REJECTED" ? "reject" : "request_info";
    try {
      const v = await this.onboarding.decide(p, caseId, { decision, ...(decision === "approve" ? {} : { reasonCode: decision === "reject" ? "rejected_by_admin" : "needs_info" }), note });
      return { id: v.caseId, seller_id: v.sellerId, status: v.state as KycDecisionResult["status"], submitted_at: v.submittedAt, decided_at: v.decidedAt, decision_reason: note.slice(0, 500), version: v.version };
    } catch (e) {
      throw kycProblem(e);
    }
  }
}

const SOURCE_OUT: Readonly<Record<string, string>> = { eta_submission: "eta", store_credit_projection: "store_credit" };
interface RunRow { id: string; source: string; counterparty: string; business_date: string; mode: "nightly" | "intraday"; status: "running" | "completed" | "failed"; matched_count: number | null; unmatched_count: number | null; started_at: Date | string; finished_at: Date | string | null }
interface ItemRow {
  id: string; run_id: string; ref_type: string; ref_id: string; entry_id: string | null; expected_minor: string | null; actual_minor: string | null; currency: string; status: "OPEN" | "ESCALATED" | "RESOLVED";
  ticket_ref: string | null; first_seen_at: Date | string; resolved_at: Date | string | null;
}

/** Reconciliation runs and their open items (worker job `finance.reconcile`, market pinned; the route proves finance + reason code first). */
export class PgReconciliationReader implements ReconciliationReaderPort {
  constructor(private readonly worker: RoleSqlClient<"outlet_worker">) {}

  private inJob<T>(marketId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.worker, { kind: "worker", marketId, job: "finance.reconcile" }, fn);
  }

  async listRuns(marketId: string, q: RunsQuery): Promise<ReconciliationRunPage> {
    const params: unknown[] = [marketId];
    const where = ["market_id = $1"];
    if (q.source !== undefined) {
      const db = Object.entries(SOURCE_OUT).find(([, out]) => out === q.source)?.[0] ?? q.source;
      where.push(`source = $${String(params.push(db))}`);
    }
    if (q.business_date !== undefined) where.push(`business_date = $${String(params.push(q.business_date))}::date`);
    if (q.cursor !== undefined) {
      const [at, id] = decodeCursor(q.cursor, 2);
      if (at === undefined || id === undefined || Number.isNaN(Date.parse(at))) throw Problems.badRequest("cursor-invalid");
      where.push(`(started_at, id) < ($${String(params.push(at))}::timestamptz, $${String(params.push(id))}::uuid)`);
    }
    const r = await this.inJob(marketId, (tx) =>
      tx.query<RunRow>(
        `SELECT id, source, counterparty, business_date::text AS business_date, mode, status, matched_count, unmatched_count, started_at, finished_at
           FROM reconciliation_runs WHERE ${where.join(" AND ")} ORDER BY started_at DESC, id DESC LIMIT ${String(q.limit + 1)}`,
        params,
      ),
    );
    const page = r.rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const items: ReconciliationRunDto[] = page.map((x) => ({
      id: x.id, source: SOURCE_OUT[x.source] ?? x.source, counterparty: x.counterparty, business_date: x.business_date, mode: x.mode,
      status: x.status === "running" ? "RUNNING" : x.status === "completed" ? "COMPLETED" : "FAILED", matched_count: x.matched_count ?? 0, unmatched_count: x.unmatched_count ?? 0,
      started_at: iso(x.started_at), finished_at: isoOrNull(x.finished_at),
    }));
    return { items, next_cursor: r.rows.length > q.limit && last !== undefined ? encodeCursor(iso(last.started_at), last.id) : null };
  }

  async listItems(marketId: string, runId: string, q: ItemsQuery, now: Date): Promise<ReconciliationItemPage | null> {
    return this.inJob(marketId, async (tx) => {
      const run = await tx.query("SELECT 1 FROM reconciliation_runs WHERE id = $1 AND market_id = $2", [runId, marketId]);
      if (run.rows.length === 0) return null;
      const params: unknown[] = [runId, marketId];
      let cursor = "";
      if (q.cursor !== undefined) {
        const [at, id] = decodeCursor(q.cursor, 2);
        if (at === undefined || id === undefined || Number.isNaN(Date.parse(at))) throw Problems.badRequest("cursor-invalid");
        cursor = `AND (first_seen_at, id) < ($${String(params.push(at))}::timestamptz, $${String(params.push(id))}::uuid)`;
      }
      const r = await tx.query<ItemRow>(
        `SELECT id, run_id, ref_type, ref_id, entry_id, expected_minor::text AS expected_minor, actual_minor::text AS actual_minor, currency, status, ticket_ref, first_seen_at, resolved_at
           FROM reconciliation_exceptions WHERE run_id = $1 AND market_id = $2 ${cursor} ORDER BY first_seen_at DESC, id DESC LIMIT ${String(q.limit + 1)}`,
        params,
      );
      const page = r.rows.slice(0, q.limit);
      const last = page[page.length - 1];
      const items: ReconciliationItemDto[] = page.map((x) => ({
        id: x.id, run_id: x.run_id, source_ref_type: x.ref_type, source_ref_id: x.ref_id, entry_id: x.entry_id,
        expected: x.expected_minor === null ? null : { amount_minor: x.expected_minor, currency: x.currency.trim() },
        actual: x.actual_minor === null ? null : { amount_minor: x.actual_minor, currency: x.currency.trim() },
        // Contract statuses derived from what the job stored: both amounts and different = mismatch; only the expected side = missing in the source; only the actual side = missing in the ledger.
        status: x.status === "RESOLVED" ? "RESOLVED" : x.expected_minor !== null && x.actual_minor !== null ? "AMOUNT_MISMATCH" : x.expected_minor !== null ? "MISSING_SOURCE" : x.actual_minor !== null ? "MISSING_LEDGER" : "UNMATCHED",
        ticket_ref: x.ticket_ref, first_seen_at: iso(x.first_seen_at), resolved_at: isoOrNull(x.resolved_at),
        age_days: Math.max(0, Math.floor(((x.resolved_at === null ? now : new Date(x.resolved_at)).getTime() - new Date(x.first_seen_at).getTime()) / DAY_MS)),
      }));
      return { items, next_cursor: r.rows.length > q.limit && last !== undefined ? encodeCursor(iso(last.first_seen_at), last.id) : null };
    });
  }
}
