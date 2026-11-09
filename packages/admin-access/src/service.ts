import { createHash } from "node:crypto";
import { PiiAccessLog, canonicalJson } from "@outlet/audit-log";
import type { AuditEntryInput } from "@outlet/audit-log";
import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import { authorize, dualApprovalRequired, requiresReasonCode } from "@outlet/policy";
import type { Principal } from "@outlet/policy";
import { z } from "zod";
import {
  APPROVAL_TTL_MS, AdminRole, DEFAULT_GRANT_DAYS, ELEVATION_PENDING_MS, MAX_ELEVATION_MINUTES, MAX_GRANT_DAYS, REQUIRED_APPROVALS, ReasonCode, liveRoles, nextApprovalStatus,
} from "./domain.js";
import type { ApprovalStatus } from "./domain.js";
import { AdminAccessError } from "./errors.js";

/** Port: PgAuditStore satisfies it structurally. The entry is written in the caller's transaction, so it commits or rolls back with the audited change. */
export interface AuditPort {
  appendIn(tx: Queryable, input: AuditEntryInput): Promise<unknown>;
}
export interface AuditMeta {
  readonly ipHash: string | null;
  readonly deviceId: string | null;
  readonly requestId: string | null;
}
export interface AdminAccessDeps {
  readonly db: RoleSqlClient<"outlet_app">;
  readonly audit: AuditPort;
  readonly clock: () => Date;
  /** Piastres; payout/refund approvals at or above need dual approval (policy.dualApprovalRequired). */
  readonly thresholdMinor: bigint;
  /** Per-request metadata for audit entries. */
  readonly meta?: () => AuditMeta;
  readonly newId?: () => string;
}

export interface ApprovalRequestRow {
  readonly id: string;
  readonly marketId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly requestedBy: string;
  readonly status: ApprovalStatus;
  readonly requiredApprovals: number;
  readonly expiresAt: Date;
  readonly executedAt: Date | null;
}
export type RequireApprovalResult = { readonly required: false } | { readonly required: true; readonly request: ApprovalRequestRow };
export type ExecuteResult<T> = { readonly executed: true; readonly result: T } | { readonly executed: false; readonly reason: "already_executed" };
export interface ElevationRow {
  readonly id: string;
  readonly staffId: string;
  readonly role: string;
  readonly ttlMinutes: number;
  readonly status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
  /** Set for super_admin (break-glass): the elevation activates only when this dual-approval request is approved and executed. */
  readonly approvalRequestId?: string;
}

const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();
const ELEVATION_APPROVE = "elevation.approve";
const ElevationPayload = z.object({ elevationId: z.uuid(), role: AdminRole, ttlMinutes: z.number().int().min(1).max(MAX_ELEVATION_MINUTES), reason: z.string() });
const reasonText = z.string().trim().min(1).max(500);
const RoleGrantPayload = z.object({ staffId: z.uuid(), role: AdminRole, ttlDays: z.number().int().min(1).max(MAX_GRANT_DAYS), reason: reasonText });

interface ApprovalDb {
  id: string; market_id: string; action: string; target_type: string; target_id: string; payload: Record<string, unknown>;
  payload_hash: Uint8Array; requested_by: string; status: ApprovalStatus; required_approvals: number;
  expires_at: Date | string; executed_at: Date | string | null;
}
const APPROVAL_COLS = "id, market_id, action, target_type, target_id, payload, payload_hash, requested_by, status, required_approvals, expires_at, executed_at";
const mapApproval = (r: ApprovalDb): ApprovalRequestRow => ({
  id: r.id, marketId: r.market_id, action: r.action, targetType: r.target_type, targetId: r.target_id, payload: r.payload, requestedBy: r.requested_by,
  status: r.status, requiredApprovals: r.required_approvals, expiresAt: toDate(r.expires_at), executedAt: r.executed_at === null ? null : toDate(r.executed_at),
});
const approvalHash = (a: { action: string; targetType: string; targetId: string; payload: unknown }): Buffer =>
  sha256(canonicalJson({ action: a.action, targetType: a.targetType, targetId: a.targetId, payload: a.payload }));

export const createAdminAccess = (deps: AdminAccessDeps) => {
  const newId = deps.newId ?? (() => uuidv7());
  // pii_access_log is the single source of truth for staff PII views; the chain entry only points at its row.
  const piiLog = new PiiAccessLog(deps.db, { now: deps.clock, newId });
  const outbox = new OutboxWriter(pgTransactionalWriter);

  const actorId = (p: Principal): string => {
    if (p.kind !== "admin" || p.userId === undefined) throw new AdminAccessError("FORBIDDEN", "admin principal required");
    return p.userId;
  };
  const run = <T>(p: Principal, fn: (tx: Queryable, now: Date) => Promise<T>): Promise<T> =>
    withDbContext(deps.db, { kind: "user", marketId: p.marketId, userId: actorId(p) }, (tx) => fn(tx, deps.clock()));

  const must = (p: Principal, action: string): void => {
    actorId(p);
    // "elevation.approve" is the approval-request action for break-glass; its approvers need role.grant (policy has no such action).
    const d = authorize(p, action === ELEVATION_APPROVE ? "role.grant" : action, { type: "admin_access", marketId: p.marketId });
    if (d.effect === "deny") throw new AdminAccessError(d.reason === "not_found" ? "NOT_FOUND" : "FORBIDDEN", `${action} denied`);
  };

  const audit = (tx: Queryable, p: Principal, action: string, targetType: string, targetId: string, after: unknown, before?: unknown): Promise<unknown> =>
    deps.audit.appendIn(tx, {
      marketId: p.marketId, actorType: "staff", actorId: p.userId ?? null, action, targetType, targetId,
      diff: { ...(before === undefined ? {} : { before }), after },
      ipHash: deps.meta?.().ipHash ?? null, deviceId: deps.meta?.().deviceId ?? null, requestId: deps.meta?.().requestId ?? null,
    }).then(() => undefined);

  const emit = (tx: Queryable, p: Principal, now: Date, type: string, aggregateType: string, aggregateId: string, payload: Record<string, string>): Promise<unknown> =>
    outbox.append(tx, { id: newId(), type, aggregateType, aggregateId, marketId: p.marketId, occurredAt: now.toISOString(), payload });

  // ---- dual approval core -------------------------------------------------------------------------------

  const createApproval = async (tx: Queryable, p: Principal, now: Date, a: { action: string; targetType: string; targetId: string; payload: Record<string, unknown> }, ttlMs: number = APPROVAL_TTL_MS): Promise<ApprovalRequestRow> => {
    const id = newId();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const r = await tx.query<ApprovalDb>(
      `INSERT INTO approval_requests (id, market_id, action, target_type, target_id, payload, payload_hash, requested_by, status, required_approvals, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'PENDING',$9,$10,$11) RETURNING ${APPROVAL_COLS}`,
      [id, p.marketId, a.action, a.targetType, a.targetId, canonicalJson(a.payload), approvalHash(a), actorId(p), REQUIRED_APPROVALS, expiresAt.toISOString(), now.toISOString()],
    );
    const row = r.rows[0];
    if (!row) throw new Error("approval insert returned no row");
    await audit(tx, p, "approval.requested", "approval_request", id, { action: a.action, targetType: a.targetType, targetId: a.targetId, expiresAt: expiresAt.toISOString() });
    return mapApproval(row);
  };

  /**
   * Decides via policy.dualApprovalRequired. Not required: the caller may act directly. Required: a PENDING request
   * is stored (payload must be JSON; money as decimal strings) and the action must be executed via executeApproval.
   */
  const requireApproval = async (actor: Principal, input: { action: string; targetType: string; targetId: string; payload: Record<string, unknown>; amountMinor?: bigint; /** kill_switch.engage only: false opts a non-money switch out; omitted = money (fail safe, policy decides). */ moneySwitch?: boolean }): Promise<RequireApprovalResult> => {
    must(actor, input.action);
    if (!dualApprovalRequired(input.action, { thresholdMinor: deps.thresholdMinor }, input.amountMinor, actor, input.moneySwitch === undefined ? undefined : { moneySwitch: input.moneySwitch })) return Promise.resolve({ required: false });
    const payload = input.amountMinor === undefined ? input.payload : { ...input.payload, amountMinor: input.amountMinor.toString() };
    const { moneySwitch: _ignored, ...rest } = input;
    return run(actor, async (tx, now) => ({ required: true as const, request: await createApproval(tx, actor, now, { ...rest, payload }) }));
  };

  const loadApproval = async (tx: Queryable, p: Principal, id: string): Promise<ApprovalDb> => {
    const r = await tx.query<ApprovalDb>(`SELECT ${APPROVAL_COLS} FROM approval_requests WHERE id = $1 AND market_id = $2 FOR UPDATE`, [id, p.marketId]);
    const row = r.rows[0];
    if (!row) throw new AdminAccessError("NOT_FOUND", "approval request not found");
    return row;
  };

  const decideApproval = async (approver: Principal, requestId: string, decision: "approve" | "reject", note?: string): Promise<ApprovalRequestRow> => {
    const outcome = await run(approver, async (tx, now) => {
      const row = await loadApproval(tx, approver, requestId);
      if (row.status !== "PENDING") throw new AdminAccessError("APPROVAL_NOT_PENDING", `request is ${row.status}`);
      if (now.getTime() >= toDate(row.expires_at).getTime()) {
        nextApprovalStatus(row.status, "expire", 0, row.required_approvals);
        await tx.query("UPDATE approval_requests SET status = 'EXPIRED', decided_at = $2 WHERE id = $1", [requestId, now.toISOString()]);
        await audit(tx, approver, "approval.expired", "approval_request", requestId, { status: "EXPIRED" }, { status: "PENDING" });
        return { expired: true as const };
      }
      const me = actorId(approver);
      if (me === row.requested_by) throw new AdminAccessError("SELF_APPROVAL", "requester cannot decide own request");
      must(approver, row.action);
      const dup = await tx.query("SELECT 1 FROM approval_decisions WHERE approval_request_id = $1 AND approver_id = $2", [requestId, me]);
      if (dup.rows.length > 0) throw new AdminAccessError("ALREADY_DECIDED", "approver already voted");
      await tx.query(
        "INSERT INTO approval_decisions (id, approval_request_id, market_id, approver_id, decision, note, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [newId(), requestId, approver.marketId, me, decision === "approve" ? "APPROVE" : "REJECT", note ?? null, now.toISOString()],
      );
      const n = await tx.query<{ n: number | string }>("SELECT count(*) AS n FROM approval_decisions WHERE approval_request_id = $1 AND decision = 'APPROVE'", [requestId]);
      const approvals = Number(n.rows[0]?.n ?? 0);
      const next = nextApprovalStatus(row.status, decision, approvals, row.required_approvals);
      await audit(tx, approver, decision === "approve" ? "approval.approved_vote" : "approval.rejected_vote", "approval_request", requestId, { approvals, status: next });
      if (next !== "PENDING") {
        await tx.query("UPDATE approval_requests SET status = $2, decided_by = $3, decided_at = $4, reason = $5 WHERE id = $1", [requestId, next, me, now.toISOString(), note ?? null]);
        await emit(tx, approver, now, `admin_access.approval_${next.toLowerCase()}`, "approval_request", requestId, { action: row.action });
      }
      return { expired: false as const, row: mapApproval({ ...row, status: next }) };
    });
    if (outcome.expired) throw new AdminAccessError("APPROVAL_EXPIRED", "approval request expired");
    return outcome.row;
  };

  /**
   * Runs `fn` exactly once for an APPROVED request. The executed_at claim and fn share one transaction, so a
   * failing fn releases the claim; a replay returns {executed:false}. Idempotency key = request id.
   */
  const executeApproval = <T>(actor: Principal, requestId: string, fn: (req: ApprovalRequestRow, tx: Queryable, now: Date) => Promise<T>): Promise<ExecuteResult<T>> =>
    run(actor, async (tx, now) => {
      const row = await loadApproval(tx, actor, requestId);
      must(actor, row.action);
      if (row.status !== "APPROVED") throw new AdminAccessError("APPROVAL_NOT_APPROVED", `request is ${row.status}`);
      if (!Buffer.from(row.payload_hash).equals(approvalHash({ action: row.action, targetType: row.target_type, targetId: row.target_id, payload: row.payload }))) {
        throw new AdminAccessError("APPROVAL_TAMPERED", "payload does not match approved hash");
      }
      if (row.executed_at !== null) return { executed: false as const, reason: "already_executed" as const };
      if (now.getTime() >= toDate(row.expires_at).getTime()) throw new AdminAccessError("APPROVAL_EXPIRED", "approval too old to execute");
      const claim = await tx.query("UPDATE approval_requests SET executed_at = $2 WHERE id = $1 AND executed_at IS NULL RETURNING id", [requestId, now.toISOString()]);
      if (claim.rows.length === 0) return { executed: false as const, reason: "already_executed" as const };
      const result = await fn(mapApproval(row), tx, now);
      await audit(tx, actor, "approval.executed", "approval_request", requestId, { action: row.action });
      return { executed: true as const, result };
    });

  // ---- role grants --------------------------------------------------------------------------------------

  /** Never applies directly: always files a dual-approval request (role.grant is ALWAYS_DUAL_APPROVAL). */
  const grantRole = async (actor: Principal, target: { staffId: string }, role: string, opts: { reason: string; ttlDays?: number }): Promise<ApprovalRequestRow> => {
    must(actor, "role.grant");
    const payload = RoleGrantPayload.safeParse({ staffId: target.staffId, role, ttlDays: opts.ttlDays ?? DEFAULT_GRANT_DAYS, reason: opts.reason });
    if (!payload.success) throw new AdminAccessError("INVALID_INPUT", "invalid role grant");
    if (payload.data.staffId === actor.userId) throw new AdminAccessError("SELF_GRANT", "cannot grant a role to yourself");
    return run(actor, (tx, now) => createApproval(tx, actor, now, { action: "role.grant", targetType: "staff", targetId: payload.data.staffId, payload: payload.data }));
  };

  /** Applies an APPROVED role.grant (idempotent). A live grant of the same role is extended (renewal), never duplicated. */
  const applyRoleGrant = (actor: Principal, requestId: string): Promise<ExecuteResult<{ assignmentId: string; expiresAt: Date }>> =>
    executeApproval(actor, requestId, async (req, tx, now) => {
      if (req.action !== "role.grant") throw new AdminAccessError("INVALID_INPUT", "not a role.grant request");
      const p = RoleGrantPayload.parse(req.payload);
      const expiresAt = new Date(now.getTime() + p.ttlDays * 86_400_000);
      const live = await tx.query<{ id: string }>(
        "SELECT id FROM staff_role_assignments WHERE staff_id = $1 AND role_code = $2 AND market_id = $3 AND revoked_at IS NULL AND expires_at > $4 FOR UPDATE",
        [p.staffId, p.role, actor.marketId, now.toISOString()],
      );
      let assignmentId = live.rows[0]?.id;
      if (assignmentId !== undefined) {
        await tx.query("UPDATE staff_role_assignments SET expires_at = GREATEST(expires_at, $2), approval_request_id = $3 WHERE id = $1", [assignmentId, expiresAt.toISOString(), req.id]);
      } else {
        assignmentId = newId();
        await tx.query(
          `INSERT INTO staff_role_assignments (id, staff_id, role_code, market_id, granted_by, approval_request_id, reason, starts_at, expires_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8)`,
          [assignmentId, p.staffId, p.role, actor.marketId, req.requestedBy, req.id, p.reason, now.toISOString(), expiresAt.toISOString()],
        );
      }
      await audit(tx, actor, "role.granted", "staff", p.staffId, { role: p.role, assignmentId, expiresAt: expiresAt.toISOString(), approvalRequestId: req.id });
      await emit(tx, actor, now, "admin_access.role_granted", "staff_role_assignment", assignmentId, { role: p.role });
      return { assignmentId, expiresAt };
    });

  /** Immediate, audited. */
  const revokeRole = async (actor: Principal, assignmentId: string, opts: { reason: string }): Promise<void> => {
    must(actor, "role.grant");
    const reason = reasonText.safeParse(opts.reason);
    if (!reason.success) throw new AdminAccessError("INVALID_INPUT", "reason required");
    return run(actor, async (tx, now) => {
      const r = await tx.query<{ staff_id: string; role_code: string; revoked_at: Date | string | null }>(
        "SELECT staff_id, role_code, revoked_at FROM staff_role_assignments WHERE id = $1 AND market_id = $2 FOR UPDATE", [assignmentId, actor.marketId]);
      const row = r.rows[0];
      if (!row) throw new AdminAccessError("NOT_FOUND", "assignment not found");
      if (row.revoked_at !== null) throw new AdminAccessError("ALREADY_REVOKED", "already revoked");
      await tx.query("UPDATE staff_role_assignments SET revoked_at = $2, revoked_by = $3 WHERE id = $1", [assignmentId, now.toISOString(), actor.userId]);
      await audit(tx, actor, "role.revoked", "staff", row.staff_id, { role: row.role_code, assignmentId, reason: reason.data }, { revoked: false });
      await emit(tx, actor, now, "admin_access.role_revoked", "staff_role_assignment", assignmentId, { role: row.role_code });
    });
  };

  // ---- JIT elevation ------------------------------------------------------------------------------------

  const requestElevation = async (actor: Principal, role: string, opts: { reason: string; ttlMinutes: number }): Promise<ElevationRow> => {
    const me = actorId(actor);
    const parsed = z.object({ role: AdminRole, reason: reasonText, ttlMinutes: z.number().int().min(1).max(MAX_ELEVATION_MINUTES) }).safeParse({ role, ...opts });
    if (!parsed.success) throw new AdminAccessError("INVALID_INPUT", "invalid elevation request");
    return run(actor, async (tx, now) => {
      const id = newId();
      const pendingUntil = new Date(now.getTime() + ELEVATION_PENDING_MS);
      await tx.query(
        `INSERT INTO elevation_requests (id, market_id, staff_id, role_code, reason, ttl_minutes, status, pending_until, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7,$8)`,
        [id, actor.marketId, me, parsed.data.role, parsed.data.reason, parsed.data.ttlMinutes, pendingUntil.toISOString(), now.toISOString()],
      );
      await audit(tx, actor, "elevation.requested", "elevation_request", id, { role: parsed.data.role, ttlMinutes: parsed.data.ttlMinutes, reason: parsed.data.reason });
      const base = { id, staffId: me, role: parsed.data.role, ttlMinutes: parsed.data.ttlMinutes, status: "PENDING" as const };
      if (parsed.data.role !== "super_admin") return base;
      // ADM-T06: break-glass needs two distinct approvers holding role.grant; the approval window equals the pending window.
      const approval = await createApproval(tx, actor, now, {
        action: ELEVATION_APPROVE, targetType: "elevation_request", targetId: id,
        payload: { elevationId: id, role: parsed.data.role, ttlMinutes: parsed.data.ttlMinutes, reason: parsed.data.reason },
      }, ELEVATION_PENDING_MS);
      return { ...base, approvalRequestId: approval.id };
    });
  };

  interface ElevDb { staff_id: string; role_code: string; ttl_minutes: number; status: ElevationRow["status"]; pending_until: Date | string }
  const decideElevation = async (approver: Principal, id: string, decision: "approve" | "reject"): Promise<ElevationRow> => {
    const out = await run(approver, async (tx, now) => {
      const r = await tx.query<ElevDb>("SELECT staff_id, role_code, ttl_minutes, status, pending_until FROM elevation_requests WHERE id = $1 AND market_id = $2 FOR UPDATE", [id, approver.marketId]);
      const row = r.rows[0];
      if (!row) throw new AdminAccessError("NOT_FOUND", "elevation request not found");
      if (row.status !== "PENDING") throw new AdminAccessError("ELEVATION_NOT_PENDING", `elevation is ${row.status}`);
      if (decision === "approve" && row.role_code === "super_admin") throw new AdminAccessError("DUAL_APPROVAL_REQUIRED", "super_admin elevation needs two approvers via its approval request");
      if (now.getTime() >= toDate(row.pending_until).getTime()) {
        await tx.query("UPDATE elevation_requests SET status = 'EXPIRED', decided_at = $2 WHERE id = $1", [id, now.toISOString()]);
        await audit(tx, approver, "elevation.expired", "elevation_request", id, { status: "EXPIRED" }, { status: "PENDING" });
        return { expired: true as const };
      }
      if (row.staff_id === approver.userId) throw new AdminAccessError("SELF_APPROVAL", "requester cannot approve own elevation");
      must(approver, "role.grant");
      const status: ElevationRow["status"] = decision === "approve" ? "APPROVED" : "REJECTED";
      const ends = new Date(now.getTime() + row.ttl_minutes * 60_000);
      if (decision === "approve") {
        await tx.query("UPDATE elevation_requests SET status = 'APPROVED', approved_by = $2, decided_at = $3, starts_at = $3, expires_at = $4 WHERE id = $1", [id, approver.userId, now.toISOString(), ends.toISOString()]);
      } else {
        await tx.query("UPDATE elevation_requests SET status = 'REJECTED', decided_at = $2 WHERE id = $1", [id, now.toISOString()]);
      }
      await audit(tx, approver, decision === "approve" ? "elevation.approved" : "elevation.rejected", "elevation_request", id,
        { role: row.role_code, status, ...(decision === "approve" ? { expiresAt: ends.toISOString(), breakGlass: row.role_code === "super_admin" } : {}) }, { status: "PENDING" });
      if (decision === "approve") await emit(tx, approver, now, "admin_access.elevation_approved", "elevation_request", id, { role: row.role_code });
      return { expired: false as const, elevation: { id, staffId: row.staff_id, role: row.role_code, ttlMinutes: row.ttl_minutes, status } };
    });
    if (out.expired) throw new AdminAccessError("ELEVATION_EXPIRED", "elevation request expired");
    return out.elevation;
  };

  /**
   * Activates a super_admin (break-glass) elevation once its dual-approval request is APPROVED. Runs exactly once
   * (executeApproval claim). The executor must not be the requester. Emits admin.break_glass_activated.
   */
  const activateElevation = (actor: Principal, approvalRequestId: string): Promise<ExecuteResult<ElevationRow>> =>
    executeApproval(actor, approvalRequestId, async (req, tx, now) => {
      if (req.action !== ELEVATION_APPROVE) throw new AdminAccessError("INVALID_INPUT", "not an elevation.approve request");
      const me = actorId(actor);
      if (me === req.requestedBy) throw new AdminAccessError("SELF_APPROVAL", "requester cannot activate own elevation");
      const p = ElevationPayload.parse(req.payload);
      const r = await tx.query<ElevDb>("SELECT staff_id, role_code, ttl_minutes, status, pending_until FROM elevation_requests WHERE id = $1 AND market_id = $2 FOR UPDATE", [p.elevationId, actor.marketId]);
      const row = r.rows[0];
      if (!row) throw new AdminAccessError("NOT_FOUND", "elevation request not found");
      if (row.status !== "PENDING") throw new AdminAccessError("ELEVATION_NOT_PENDING", `elevation is ${row.status}`);
      const ends = new Date(now.getTime() + row.ttl_minutes * 60_000);
      await tx.query("UPDATE elevation_requests SET status = 'APPROVED', approved_by = $2, decided_at = $3, starts_at = $3, expires_at = $4 WHERE id = $1", [p.elevationId, me, now.toISOString(), ends.toISOString()]);
      const votes = await tx.query<{ approver_id: string }>("SELECT approver_id FROM approval_decisions WHERE approval_request_id = $1 AND decision = 'APPROVE' ORDER BY approver_id", [approvalRequestId]);
      const approvers = votes.rows.map((v) => v.approver_id);
      await audit(tx, actor, "elevation.approved", "elevation_request", p.elevationId, { role: row.role_code, status: "APPROVED", expiresAt: ends.toISOString(), breakGlass: true, approvers, approvalRequestId }, { status: "PENDING" });
      await emit(tx, actor, now, "admin.break_glass_activated", "elevation_request", p.elevationId,
        { actor: row.staff_id, approvers: approvers.join(","), reason: p.reason, ttlMinutes: String(row.ttl_minutes), approvalRequestId });
      return { id: p.elevationId, staffId: row.staff_id, role: row.role_code, ttlMinutes: row.ttl_minutes, status: "APPROVED" as const };
    });

  /**
   * Standing grants + active elevations at `now` (default: injected clock). breakGlass only while an approved
   * super_admin elevation (which always has a reason, DB CHECK) is active; a standing super_admin grant alone never sets it.
   */
  const buildPrincipal = (marketId: string, adminUserId: string, now?: Date): Promise<Principal> =>
    withDbContext(deps.db, { kind: "user", marketId, userId: adminUserId }, async (tx) => {
      const at = (now ?? deps.clock()).toISOString();
      const g = await tx.query<{ role_code: string; starts_at: Date | string; expires_at: Date | string; revoked_at: Date | string | null }>(
        "SELECT role_code, starts_at, expires_at, revoked_at FROM staff_role_assignments WHERE staff_id = $1 AND market_id = $2 AND revoked_at IS NULL AND starts_at <= $3 AND expires_at > $3", [adminUserId, marketId, at]);
      const e = await tx.query<{ role_code: string; starts_at: Date | string; expires_at: Date | string; reason: string }>(
        "SELECT role_code, starts_at, expires_at, reason FROM elevation_requests WHERE staff_id = $1 AND market_id = $2 AND status = 'APPROVED' AND starts_at <= $3 AND expires_at > $3", [adminUserId, marketId, at]);
      const when = now ?? deps.clock();
      const grants = g.rows.map((r) => ({ role: r.role_code, startsAt: toDate(r.starts_at), expiresAt: toDate(r.expires_at), revokedAt: r.revoked_at === null ? null : toDate(r.revoked_at) }));
      const elevs = e.rows.map((r) => ({ role: r.role_code, startsAt: toDate(r.starts_at), expiresAt: toDate(r.expires_at) }));
      const roles = liveRoles(grants, elevs, when);
      const breakGlass = e.rows.some((r) => r.role_code === "super_admin" && r.reason.trim().length > 0);
      return { kind: "admin", userId: adminUserId, marketId, roles, scopes: [], ...(breakGlass ? { breakGlass: true } : {}) };
    });

  // ---- PII views ----------------------------------------------------------------------------------------

  /**
   * Call BEFORE returning PII. Throws REASON_CODE_REQUIRED for any action in REQUIRES_REASON_CODE without a valid code
   * (and for other_with_note without a note). The entry carries ids and the code only, never the data viewed.
   */
  const recordPiiView = async (actor: Principal, view: { action: string; targetType: string; targetId: string }, reasonCode: string | undefined, note?: string): Promise<void> => {
    must(actor, view.action);
    const code = ReasonCode.safeParse(reasonCode);
    if (!code.success) {
      if (requiresReasonCode(view.action)) throw new AdminAccessError("REASON_CODE_REQUIRED", `${view.action} requires a reason code`);
      return;
    }
    const trimmed = note?.trim();
    if (code.data === "other_with_note" && (trimmed === undefined || trimmed.length === 0)) throw new AdminAccessError("REASON_CODE_REQUIRED", "other_with_note requires a note");
    if (trimmed !== undefined && trimmed.length > 500) throw new AdminAccessError("INVALID_INPUT", "note too long");
    await run(actor, async (tx) => {
      const rec = await piiLog.recordIn(tx, {
        marketId: actor.marketId, actorId: actorId(actor), targetType: view.targetType, targetId: view.targetId, action: view.action, reasonCode: code.data, requestId: deps.meta?.().requestId ?? null,
      });
      await audit(tx, actor, "pii.viewed", view.targetType, view.targetId, { piiAccessId: rec.id });
    });
  };

  return {
    requireApproval, decideApproval, approve: (a: Principal, id: string, note?: string) => decideApproval(a, id, "approve", note),
    reject: (a: Principal, id: string, note?: string) => decideApproval(a, id, "reject", note), executeApproval,
    grantRole, applyRoleGrant, revokeRole,
    requestElevation, activateElevation, approveElevation: (a: Principal, id: string) => decideElevation(a, id, "approve"), rejectElevation: (a: Principal, id: string) => decideElevation(a, id, "reject"),
    buildPrincipal, recordPiiView,
  };
};
export type AdminAccess = ReturnType<typeof createAdminAccess>;
