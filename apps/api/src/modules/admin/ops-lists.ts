import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import { can } from "@outlet/orders";
import { PAYOUT, PayoutsError } from "@outlet/payouts";
import type { PayoutService } from "@outlet/payouts";
import type { Principal } from "@outlet/policy";
import { decodeCursor, encodeCursor } from "../../platform/cursor.js";
import { ProblemError, Problems } from "../../platform/problem.js";
import type {
  DisputeDto, DisputePage, DisputesQuery, PayoutDetailDto, PayoutDto, PayoutPage, PayoutsQuery, RefundDto, RefundPage, RefundsQuery, ReturnDto, ReturnPage, ReturnsQuery,
} from "./dto-lists.js";
import type { AuditAppendPort } from "./ports.js";

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();
const isoOrNull = (v: Date | string | null): string | null => (v === null ? null : iso(v));
const day = (v: Date | string): string => (typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10));
const money = (amount: string, currency: string): { amount_minor: string; currency: string } => ({ amount_minor: amount, currency: currency.trim() });

/** Reads behind the Money and Orders list pages. The route has already proven the action; these classes never decide who may see what. */
export interface OpsListsPort {
  refunds(marketId: string, q: RefundsQuery, now: Date): Promise<RefundPage>;
  returns(marketId: string, q: ReturnsQuery, now: Date): Promise<ReturnPage>;
  disputes(marketId: string, q: DisputesQuery, now: Date): Promise<DisputePage>;
  payouts(marketId: string, q: PayoutsQuery): Promise<PayoutPage>;
  /** Null when the payout is not in the market (404). */
  payout(marketId: string, id: string): Promise<PayoutDetailDto | null>;
}

/** Keyset cursor `(created_at, id)`, newest first. */
const keyset = (cursor: string | undefined, params: unknown[], col: string): string => {
  if (cursor === undefined) return "";
  const [at, id] = decodeCursor(cursor, 2);
  if (at === undefined || id === undefined || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/i.test(id)) throw Problems.badRequest("cursor-invalid");
  return ` AND (${col}, id) < ($${String(params.push(at))}::timestamptz, $${String(params.push(id))}::uuid)`;
};
const nextOf = <T extends { id: string }>(rows: readonly T[], limit: number, at: (r: T) => Date | string): string | null => {
  const last = rows[limit - 1];
  return rows.length > limit && last !== undefined ? encodeCursor(iso(at(last)), last.id) : null;
};

interface RefundRow {
  id: string; order_group_id: string; seller_order_id: string; return_request_id: string | null; store_id: string; status: RefundDto["status"]; reason: RefundDto["reason"]; route: RefundDto["route"];
  currency: string; amount_minor: string; attempts: number; due_at: Date | string | null; created_at: Date | string; completed_at: Date | string | null;
}
interface ReturnRow {
  id: string; order_group_id: string; seller_order_id: string; store_id: string; status: ReturnDto["status"]; reason_code: string; resolution: ReturnDto["resolution"];
  created_at: Date | string; received_at: Date | string | null; inspection_due_at: Date | string | null;
}
interface DisputeRow {
  id: string; return_request_id: string; store_id: string; status: DisputeDto["status"]; reason_code: string; assigned: boolean; sla_due_at: Date | string; created_at: Date | string; resolved_at: Date | string | null;
}
interface PayoutRow {
  id: string; store_id: string; status: PayoutDto["status"]; mode: "transfer" | "statement"; cycle_start: Date | string; cycle_end: Date | string; gross_minor: string; adjustments_minor: string; net_minor: string;
  currency: string; hold_reason: string | null; failure_code: string | null; approval_request_id: string | null; sent_at: Date | string | null; settled_at: Date | string | null; created_at: Date | string;
}

const payoutDto = (x: PayoutRow): PayoutDto => ({
  id: x.id, store_id: x.store_id, status: x.status, mode: x.mode, cycle_start: day(x.cycle_start), cycle_end: day(x.cycle_end),
  gross: money(x.gross_minor, x.currency), adjustments: money(x.adjustments_minor, x.currency), net: money(x.net_minor, x.currency),
  hold_reason: x.hold_reason, failure_code: x.failure_code, approval_request_id: x.approval_request_id, sent_at: isoOrNull(x.sent_at), settled_at: isoOrNull(x.settled_at), created_at: iso(x.created_at),
});
const PAYOUT_COLS = `id, store_id, status, mode, cycle_start, cycle_end, gross_minor::text AS gross_minor, adjustments_minor::text AS adjustments_minor, net_minor::text AS net_minor, currency,
  hold_reason, failure_code, approval_request_id, sent_at, settled_at, created_at`;

/**
 * Refunds, returns and disputes are read as the `finance.refunds` worker job (SELECT-only policies from migration 0019 on exactly these three tables, market pinned), payouts as
 * `finance.payouts`. No SECURITY DEFINER function and no new grant: the same mechanism as PgReconciliationReader, and these are the jobs that already own those tables.
 * Shopper identity (`user_id`) and every free-text column (shopper note, last_error, resolution note) are never selected.
 */
export class PgOpsLists implements OpsListsPort {
  constructor(private readonly worker: RoleSqlClient<"outlet_worker">) {}

  private refundsJob<T>(marketId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.worker, { kind: "worker", marketId, job: "finance.refunds" }, fn);
  }

  private payoutsJob<T>(marketId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.worker, { kind: "worker", marketId, job: "finance.payouts" }, fn);
  }

  async refunds(marketId: string, q: RefundsQuery, now: Date): Promise<RefundPage> {
    const params: unknown[] = [marketId];
    let where = "market_id = $1";
    if (q.status !== undefined) where += ` AND status = $${String(params.push(q.status))}`;
    where += keyset(q.cursor, params, "created_at");
    return this.refundsJob(marketId, async (tx) => {
      const r = await tx.query<RefundRow>(
        `SELECT id, order_group_id, seller_order_id, return_request_id, store_id, status, reason, route, currency, amount_minor::text AS amount_minor, attempts, due_at, created_at, completed_at
           FROM refunds WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ${String(q.limit + 1)}`,
        params,
      );
      const s = await tx.query<{ status: RefundPage["summary"][number]["status"]; currency: string; n: number; total: string; overdue: number }>(
        `SELECT status, currency, count(*)::int AS n, sum(amount_minor)::text AS total, count(*) FILTER (WHERE due_at < $2::timestamptz)::int AS overdue
           FROM refunds WHERE market_id = $1 AND status <> 'COMPLETED' GROUP BY status, currency ORDER BY status, currency`,
        [marketId, now.toISOString()],
      );
      const items = r.rows.slice(0, q.limit).map((x): RefundDto => ({
        id: x.id, order_group_id: x.order_group_id, seller_order_id: x.seller_order_id, return_request_id: x.return_request_id, store_id: x.store_id, status: x.status, reason: x.reason, route: x.route,
        amount: money(x.amount_minor, x.currency), attempts: x.attempts, overdue: x.status !== "COMPLETED" && x.due_at !== null && new Date(x.due_at).getTime() < now.getTime(),
        due_at: isoOrNull(x.due_at), created_at: iso(x.created_at), completed_at: isoOrNull(x.completed_at),
      }));
      return {
        items, next_cursor: nextOf(r.rows, q.limit, (x) => x.created_at),
        summary: s.rows.map((x) => ({ status: x.status, count: x.n, amount: money(x.total, x.currency) })),
        overdue_count: s.rows.reduce((n, x) => n + x.overdue, 0),
      };
    });
  }

  async returns(marketId: string, q: ReturnsQuery, now: Date): Promise<ReturnPage> {
    const params: unknown[] = [marketId];
    const STAGE: Record<"requested" | "in_transit" | "awaiting_inspection", string> = {
      requested: "status = 'REQUESTED'",
      in_transit: "status = 'IN_TRANSIT'",
      awaiting_inspection: "status = 'RECEIVED'",
    };
    // No stage = the same pipeline the Home tile counts: REQUESTED, IN_TRANSIT and RECEIVED.
    const stage = q.stage === undefined ? "status IN ('REQUESTED', 'IN_TRANSIT', 'RECEIVED')"
      : q.stage === "inspection_overdue" ? `status = 'RECEIVED' AND inspection_due_at < $${String(params.push(now.toISOString()))}::timestamptz` : STAGE[q.stage];
    const where = `market_id = $1 AND ${stage}${keyset(q.cursor, params, "created_at")}`;
    return this.refundsJob(marketId, async (tx) => {
      const r = await tx.query<ReturnRow>(
        `SELECT id, order_group_id, seller_order_id, store_id, status, reason_code, resolution, created_at, received_at, inspection_due_at
           FROM return_requests WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ${String(q.limit + 1)}`,
        params,
      );
      const s = await tx.query<{ q: number; t: number; w: number; o: number }>(
        `SELECT count(*) FILTER (WHERE status = 'REQUESTED')::int AS q, count(*) FILTER (WHERE status = 'IN_TRANSIT')::int AS t, count(*) FILTER (WHERE status = 'RECEIVED')::int AS w,
                count(*) FILTER (WHERE status = 'RECEIVED' AND inspection_due_at < $2::timestamptz)::int AS o
           FROM return_requests WHERE market_id = $1 AND status IN ('REQUESTED', 'IN_TRANSIT', 'RECEIVED')`,
        [marketId, now.toISOString()],
      );
      const c = s.rows[0];
      const items = r.rows.slice(0, q.limit).map((x): ReturnDto => ({
        id: x.id, order_group_id: x.order_group_id, seller_order_id: x.seller_order_id, store_id: x.store_id, status: x.status,
        stage: x.status === "REQUESTED" ? "requested" : x.status === "IN_TRANSIT" ? "in_transit" : x.inspection_due_at !== null && new Date(x.inspection_due_at).getTime() < now.getTime() ? "inspection_overdue" : "awaiting_inspection",
        reason_code: x.reason_code, resolution: x.resolution, created_at: iso(x.created_at), received_at: isoOrNull(x.received_at), inspection_due_at: isoOrNull(x.inspection_due_at),
      }));
      return { items, next_cursor: nextOf(r.rows, q.limit, (x) => x.created_at), summary: { requested: c?.q ?? 0, in_transit: c?.t ?? 0, awaiting_inspection: c?.w ?? 0, inspection_overdue: c?.o ?? 0 } };
    });
  }

  async disputes(marketId: string, q: DisputesQuery, now: Date): Promise<DisputePage> {
    const params: unknown[] = [marketId];
    // No filter = the open queue (OPEN and UNDER_REVIEW), what the Home tile counts.
    const status = q.status === undefined ? "status IN ('OPEN', 'UNDER_REVIEW')" : `status = $${String(params.push(q.status))}`;
    const where = `market_id = $1 AND ${status}${keyset(q.cursor, params, "created_at")}`;
    return this.refundsJob(marketId, async (tx) => {
      const r = await tx.query<DisputeRow>(
        `SELECT id, return_request_id, store_id, status, reason_code, (assigned_staff_id IS NOT NULL) AS assigned, sla_due_at, created_at, resolved_at
           FROM disputes WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ${String(q.limit + 1)}`,
        params,
      );
      const s = await tx.query<{ n: number; late: number }>(
        "SELECT count(*)::int AS n, count(*) FILTER (WHERE sla_due_at < $2::timestamptz)::int AS late FROM disputes WHERE market_id = $1 AND status IN ('OPEN', 'UNDER_REVIEW')",
        [marketId, now.toISOString()],
      );
      const items = r.rows.slice(0, q.limit).map((x): DisputeDto => ({
        id: x.id, return_request_id: x.return_request_id, store_id: x.store_id, status: x.status, reason_code: x.reason_code, assigned: x.assigned, sla_due_at: iso(x.sla_due_at),
        past_sla: (x.status === "OPEN" || x.status === "UNDER_REVIEW") && new Date(x.sla_due_at).getTime() < now.getTime(), created_at: iso(x.created_at), resolved_at: isoOrNull(x.resolved_at),
      }));
      return { items, next_cursor: nextOf(r.rows, q.limit, (x) => x.created_at), summary: { open: s.rows[0]?.n ?? 0, past_sla: s.rows[0]?.late ?? 0 } };
    });
  }

  async payouts(marketId: string, q: PayoutsQuery): Promise<PayoutPage> {
    const params: unknown[] = [marketId];
    let where = "market_id = $1 AND status <> 'CANCELLED'";
    if (q.status !== undefined) where += ` AND status = $${String(params.push(q.status))}`;
    where += keyset(q.cursor, params, "created_at");
    return this.payoutsJob(marketId, async (tx) => {
      const r = await tx.query<PayoutRow>(`SELECT ${PAYOUT_COLS} FROM payouts WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ${String(q.limit + 1)}`, params);
      const s = await tx.query<{ status: PayoutPage["summary"][number]["status"]; currency: string; n: number; net: string }>(
        `SELECT status, currency, count(*)::int AS n, sum(net_minor)::text AS net FROM payouts WHERE market_id = $1 AND status IN ('SCHEDULED', 'ON_HOLD', 'APPROVED', 'FAILED') GROUP BY status, currency ORDER BY status, currency`,
        [marketId],
      );
      return { items: r.rows.slice(0, q.limit).map(payoutDto), next_cursor: nextOf(r.rows, q.limit, (x) => x.created_at), summary: s.rows.map((x) => ({ status: x.status, count: x.n, net: money(x.net, x.currency) })) };
    });
  }

  async payout(marketId: string, id: string): Promise<PayoutDetailDto | null> {
    return this.payoutsJob(marketId, async (tx) => {
      const r = await tx.query<PayoutRow & { store_id: string }>(`SELECT ${PAYOUT_COLS} FROM payouts WHERE id = $1 AND market_id = $2 AND status <> 'CANCELLED'`, [id, marketId]);
      const x = r.rows[0];
      if (x === undefined) return null;
      const lines = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM payout_lines WHERE payout_id = $1", [id]);
      const holds = await tx.query<{ id: string; reason: "risk" | "enforcement" | "kyc" | "dispute"; seller_order_id: string | null; starts_at: Date | string; released_at: Date | string | null }>(
        "SELECT id, reason, seller_order_id, starts_at, released_at FROM payout_holds WHERE store_id = $1 AND market_id = $2 AND released_at IS NULL ORDER BY starts_at DESC, id DESC LIMIT 50",
        [x.store_id, marketId],
      );
      return {
        ...payoutDto(x), line_count: lines.rows[0]?.n ?? 0,
        open_holds: holds.rows.map((h) => ({ id: h.id, reason: h.reason, seller_order_id: h.seller_order_id, starts_at: iso(h.starts_at), released_at: isoOrNull(h.released_at) })),
      };
    });
  }
}

// ---------------------------------------------------------------- payout hold / release

export interface PayoutsAdminPort {
  /** Idempotent: holding an already-held payout with the same reason changes nothing and writes no second audit entry. 404 outside the market, 409 `invalid-transition` unless SCHEDULED or APPROVED. */
  hold(p: Principal, payoutId: string, reasonCode: string): Promise<{ readonly changed: boolean }>;
  /** Proof that a payout can be released (ON_HOLD, in the market) before a dual-approval request is filed; 404 / 409 otherwise. */
  assertReleasable(p: Principal, payoutId: string): Promise<{ readonly storeId: string; readonly holdReason: string | null; readonly version: number }>;
  /** The id of a live PENDING release request that was filed for this exact hold (same reason and version), else null: one request per hold, never a second. */
  findPendingRelease(p: Principal, payoutId: string, hold: { readonly holdReason: string | null; readonly version: number }): Promise<string | null>;
  /** Effect of an APPROVED release request (second key done): ON_HOLD -> SCHEDULED, the earlier approval is void. Idempotent: an already-released payout is a no-op. `filed` is the hold the approvers voted on: another reason or version (re-held since) is 409 `stale-approval`, audited as `payout.release_refused`, nothing changes. */
  release(p: Principal, payoutId: string, filed?: { readonly holdReason: string | null; readonly version: number }): Promise<{ readonly changed: boolean }>;
  /** Audit entry `payout.released`, in the approval's claim transaction. */
  recordRelease(p: Principal, tx: Queryable, input: { readonly payoutId: string; readonly reasonCode: string; readonly approvalRequestId: string; readonly changed: boolean }): Promise<void>;
}

export type PayoutServicePort = Pick<PayoutService, "get" | "hold" | "release">;

const stateProblem = (e: unknown): never => {
  if (e instanceof PayoutsError && e.code === "NOT_FOUND") throw Problems.notFound();
  if (e instanceof PayoutsError && e.code === "INVALID_STATE") throw new ProblemError(409, "invalid-transition", "The payout changed or cannot move from its state");
  throw e;
};

/**
 * Staff side of payout hold / release. The mutation is `PayoutService.hold` / `release` (finance.payouts worker job: state machine, optimistic version lock, outbox event
 * `payout.on_hold`), so the transition rules live in one place. The worker and the audit chain are different roles, so, like DlqAdmin, a hold writes an INTENT entry through
 * outlet_app BEFORE the effect and the result entry after it; a failed intent write stops the effect. A release always sits behind dual approval: its audit entry joins the
 * approval's claim transaction (`recordRelease`).
 */
export class PayoutsAdmin implements PayoutsAdminPort {
  constructor(private readonly service: PayoutServicePort, private readonly app: RoleSqlClient<"outlet_app">, private readonly audit: AuditAppendPort) {}

  private actor(p: Principal): string {
    if (p.userId === undefined) throw Problems.forbidden();
    return p.userId;
  }

  private async load(p: Principal, id: string): Promise<{ status: string; storeId: string; holdReason: string | null; version: number }> {
    try {
      const row = await this.service.get(p.marketId, id);
      return { status: row.status, storeId: row.storeId, holdReason: row.holdReason, version: row.version };
    } catch (e) {
      return stateProblem(e);
    }
  }

  async hold(p: Principal, payoutId: string, reasonCode: string): Promise<{ changed: boolean }> {
    const actor = this.actor(p);
    const stored = `ops:${reasonCode}`;
    const before = await this.load(p, payoutId);
    if (before.status === "ON_HOLD" && before.holdReason === stored) return { changed: false };
    if (!can(PAYOUT, before.status, "hold")) throw new ProblemError(409, "invalid-transition", `The payout is ${before.status}`);
    await withDbContext(this.app, { kind: "user", marketId: p.marketId, userId: actor }, (tx) =>
      this.audit.appendIn(tx, {
        marketId: p.marketId, actorType: "staff", actorId: actor, action: "payout.hold_requested", targetType: "payout", targetId: payoutId,
        diff: { before: { status: before.status }, after: { reasonCode } }, ipHash: null, deviceId: null, requestId: null,
      }),
    );
    try {
      await this.service.hold(p.marketId, payoutId, stored);
    } catch (e) {
      // The loser of a hold race leaves no orphan intent: the failure and its problem code are audited before the error goes on.
      const code = e instanceof PayoutsError ? (e.code === "NOT_FOUND" ? "not-found" : e.code === "INVALID_STATE" ? "invalid-transition" : "error") : "error";
      await withDbContext(this.app, { kind: "user", marketId: p.marketId, userId: actor }, (tx) =>
        this.audit.appendIn(tx, {
          marketId: p.marketId, actorType: "staff", actorId: actor, action: "payout.hold_failed", targetType: "payout", targetId: payoutId,
          diff: { before: { status: before.status }, after: { reasonCode, problem: code } }, ipHash: null, deviceId: null, requestId: null,
        }),
      );
      return stateProblem(e);
    }
    await withDbContext(this.app, { kind: "user", marketId: p.marketId, userId: actor }, (tx) =>
      this.audit.appendIn(tx, {
        marketId: p.marketId, actorType: "staff", actorId: actor, action: "payout.on_hold", targetType: "payout", targetId: payoutId,
        diff: { before: { status: before.status }, after: { status: "ON_HOLD", reasonCode } }, ipHash: null, deviceId: null, requestId: null,
      }),
    );
    return { changed: true };
  }

  async assertReleasable(p: Principal, payoutId: string): Promise<{ storeId: string; holdReason: string | null; version: number }> {
    const row = await this.load(p, payoutId);
    if (!can(PAYOUT, row.status, "release")) throw new ProblemError(409, "invalid-transition", `The payout is ${row.status}`);
    return { storeId: row.storeId, holdReason: row.holdReason, version: row.version };
  }

  async findPendingRelease(p: Principal, payoutId: string, hold: { holdReason: string | null; version: number }): Promise<string | null> {
    const rows = await withDbContext(this.app, { kind: "user", marketId: p.marketId, userId: this.actor(p) }, (tx) =>
      tx.query<{ id: string; payload: Record<string, unknown> }>(
        "SELECT id, payload FROM approval_requests WHERE market_id = $1 AND action = 'payout.release' AND target_type = 'payout' AND target_id = $2 AND status = 'PENDING' AND expires_at > now() ORDER BY created_at DESC",
        [p.marketId, payoutId],
      ),
    );
    return rows.rows.find((r) => r.payload.holdReason === hold.holdReason && r.payload.version === hold.version)?.id ?? null;
  }

  async release(p: Principal, payoutId: string, filed?: { holdReason: string | null; version: number }): Promise<{ changed: boolean }> {
    const row = await this.load(p, payoutId);
    // Already released by an earlier attempt of the same approved request: converge, change nothing.
    if (row.status === "SCHEDULED" && row.holdReason === null) return { changed: false };
    if (!can(PAYOUT, row.status, "release")) throw new ProblemError(409, "invalid-transition", `The payout is ${row.status}`);
    if (filed !== undefined && (row.holdReason !== filed.holdReason || row.version !== filed.version)) {
      const actor = this.actor(p);
      await withDbContext(this.app, { kind: "user", marketId: p.marketId, userId: actor }, (tx) =>
        this.audit.appendIn(tx, {
          marketId: p.marketId, actorType: "staff", actorId: actor, action: "payout.release_refused", targetType: "payout", targetId: payoutId,
          diff: { before: { status: row.status, holdReason: row.holdReason, version: row.version }, after: { problem: "stale-approval", filedHoldReason: filed.holdReason, filedVersion: filed.version } }, ipHash: null, deviceId: null, requestId: null,
        }),
      );
      throw new ProblemError(409, "stale-approval", "The payout was held again after this release was requested");
    }
    try {
      await this.service.release(p.marketId, payoutId);
    } catch (e) {
      return stateProblem(e);
    }
    return { changed: true };
  }

  async recordRelease(p: Principal, tx: Queryable, i: { payoutId: string; reasonCode: string; approvalRequestId: string; changed: boolean }): Promise<void> {
    await this.audit.appendIn(tx, {
      marketId: p.marketId, actorType: "staff", actorId: this.actor(p), action: "payout.released", targetType: "payout", targetId: i.payoutId,
      diff: { before: { status: "ON_HOLD" }, after: { status: "SCHEDULED", reasonCode: i.reasonCode, approvalRequestId: i.approvalRequestId, changed: i.changed } }, ipHash: null, deviceId: null, requestId: null,
    });
  }
}
