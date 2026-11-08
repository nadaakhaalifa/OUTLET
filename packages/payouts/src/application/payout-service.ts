import type { AdminAccess } from "@outlet/admin-access";
import type { Queryable } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { Ledger } from "@outlet/ledger";
import { money, negate } from "@outlet/money";
import { can, transition } from "@outlet/orders";
import { authorize } from "@outlet/policy";
import type { Principal } from "@outlet/policy";
import { PAYOUT, PRE_SEND_STATES } from "../domain/payout-machine.js";
import type { PayoutEvent, PayoutState } from "../domain/payout-machine.js";
import { isEligible } from "../domain/eligibility.js";
import type { OpenHold } from "../domain/eligibility.js";
import { PayoutsError } from "../domain/errors.js";
import { ibanNameMatches } from "../domain/iban-match.js";
import { planPayout } from "../domain/netting.js";
import { weeklyCycle } from "../domain/cycle.js";
import { BANK_OWNER, acct } from "./accounts.js";
import type { AuditPort, PayoutDestination, PayoutDestinationPort, PayoutRailPort } from "./ports.js";
import { emit, inJob, toDate } from "./shared.js";
import type { FinanceDeps } from "./shared.js";

const JOB = "finance.payouts" as const;

export interface PayoutRow {
  readonly id: string;
  readonly batchId: string;
  readonly storeId: string;
  readonly marketId: string;
  readonly status: PayoutState;
  readonly grossMinor: bigint;
  readonly adjustmentsMinor: bigint;
  readonly netMinor: bigint;
  readonly currency: string;
  readonly cycleStart: string;
  readonly cycleEnd: string;
  readonly approvalRequestId: string | null;
  readonly approvedBy: string | null;
  readonly holdReason: string | null;
  readonly provider: string | null;
  readonly providerRef: string | null;
  readonly sentEntryId: string | null;
  readonly settledEntryId: string | null;
  readonly failureCode: string | null;
  readonly sendAttempt: number;
  readonly version: number;
}

interface PayoutDb {
  id: string; batch_id: string; store_id: string; market_id: string; status: PayoutState; gross_minor: string; adjustments_minor: string; net_minor: string;
  currency: string; cycle_start: string; cycle_end: string; approval_request_id: string | null; approved_by: string | null; hold_reason: string | null;
  provider: string | null; provider_ref: string | null; sent_entry_id: string | null; settled_entry_id: string | null; failure_code: string | null; send_attempt: number; version: number;
}
const COLS = `id, batch_id, store_id, market_id, status, gross_minor::text AS gross_minor, adjustments_minor::text AS adjustments_minor, net_minor::text AS net_minor, currency,
  cycle_start::text AS cycle_start, cycle_end::text AS cycle_end, approval_request_id, approved_by, hold_reason, provider, provider_ref, sent_entry_id, settled_entry_id, failure_code, send_attempt, version`;
const map = (r: PayoutDb): PayoutRow => ({
  id: r.id, batchId: r.batch_id, storeId: r.store_id, marketId: r.market_id, status: r.status, grossMinor: BigInt(r.gross_minor), adjustmentsMinor: BigInt(r.adjustments_minor),
  netMinor: BigInt(r.net_minor), currency: r.currency, cycleStart: r.cycle_start, cycleEnd: r.cycle_end, approvalRequestId: r.approval_request_id, approvedBy: r.approved_by,
  holdReason: r.hold_reason, provider: r.provider, providerRef: r.provider_ref, sentEntryId: r.sent_entry_id, settledEntryId: r.settled_entry_id, failureCode: r.failure_code, sendAttempt: r.send_attempt, version: r.version,
});

export interface BuildResult {
  readonly batchId: string;
  readonly cycle: { readonly start: string; readonly end: string };
  readonly payoutIds: readonly string[];
  readonly skipped: readonly { readonly storeId: string; readonly reason: string }[];
}
export type ApproveOutcome =
  | { readonly status: "approved" }
  | { readonly status: "approval_required"; readonly requestId: string };
export type SendOutcome =
  | { readonly status: "SENT"; readonly providerRef: string | null }
  | { readonly status: "ON_HOLD"; readonly reason: string }
  | { readonly status: "FAILED"; readonly code: string };

export interface PayoutServiceDeps extends FinanceDeps {
  readonly admin: AdminAccess;
  readonly rail: PayoutRailPort;
  readonly destinations: PayoutDestinationPort;
  readonly audit: AuditPort;
  readonly graceDays?: number;
  /**
   * Re-reads an approval request by id (B3). Used only when executeApproval reports `already_executed`: the request is then verified to
   * belong to this payout before the payout is approved. Absent = fail closed (the payout stays SCHEDULED; file a renewed request).
   */
  readonly readApproval?: (requestId: string) => Promise<{ readonly action: string; readonly targetType: string; readonly targetId: string; readonly status: string } | null>;
}

/** Identifies one send attempt. A bank return or rail failure is applied only to the attempt it names. */
export interface FailAttempt {
  readonly providerRef: string | null;
  readonly sendAttempt: number;
}

/** Extra columns a transition may write. Fixed list: the SQL below never interpolates caller input. */
interface Patch {
  readonly approvalRequestId?: string | null;
  readonly approvedBy?: string | null;
  readonly approvedAt?: Date | null;
  readonly holdReason?: string | null;
  readonly provider?: string | null;
  readonly providerRef?: string | null;
  readonly sentEntryId?: string | null;
  readonly settledEntryId?: string | null;
  readonly failureCode?: string | null;
  readonly sentAt?: Date | null;
  readonly settledAt?: Date | null;
  readonly sendAttempt?: number;
}
const PATCH_COLUMNS: readonly (readonly [keyof Patch, string])[] = [
  ["approvalRequestId", "approval_request_id"], ["approvedBy", "approved_by"], ["approvedAt", "approved_at"], ["holdReason", "hold_reason"], ["provider", "provider"],
  ["providerRef", "provider_ref"], ["sentEntryId", "sent_entry_id"], ["settledEntryId", "settled_entry_id"], ["failureCode", "failure_code"], ["sentAt", "sent_at"], ["settledAt", "settled_at"], ["sendAttempt", "send_attempt"],
];

const adminActor = (p: Principal): string => {
  if (p.kind !== "admin" || p.userId === undefined) throw new PayoutsError("INVALID_INPUT", "an admin principal is required");
  return p.userId;
};
/** Deny by default: payout.approve is granted to finance (and break-glass super_admin) only. Checked before any state or request id is revealed. */
const mustApprove = (p: Principal, row: { readonly id: string; readonly storeId: string }): void => {
  const d = authorize(p, "payout.approve", { type: "payout", id: row.id, storeId: row.storeId, marketId: p.marketId });
  if (d.effect === "deny") throw new PayoutsError("FORBIDDEN", "payout.approve denied");
};

/**
 * Payout lifecycle (TWO-KEY). All writes run as outlet_worker in job finance.payouts.
 * Money moves in the ledger exactly at two points (chart 4.11): SENT (Dr seller_available, Cr payouts_in_transit) and SETTLED
 * (Dr payouts_in_transit, Cr bank_collections). A failed send is undone by a reversing entry (never an edit).
 */
export class PayoutService {
  constructor(private readonly deps: PayoutServiceDeps) {}

  // ---------------------------------------------------------------- reads / helpers

  async get(marketId: string, payoutId: string): Promise<PayoutRow> {
    return inJob(this.deps, marketId, JOB, (tx) => this.load(tx, payoutId, false));
  }

  private async load(tx: Queryable, payoutId: string, lock: boolean): Promise<PayoutRow> {
    const r = await tx.query<PayoutDb>(`SELECT ${COLS} FROM payouts WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [payoutId]);
    const row = r.rows[0];
    if (!row) throw new PayoutsError("NOT_FOUND", `payout ${payoutId} not found`);
    return map(row);
  }

  /** Applies a machine event with optimistic locking on `version`. Throws OrderStateError for an invalid transition. */
  private async move(tx: Queryable, p: PayoutRow, event: PayoutEvent, patch: Patch = {}): Promise<PayoutRow> {
    const next = transition(PAYOUT, p.status, event);
    const sets: string[] = ["status = $3", "version = version + 1", "updated_at = $4::timestamptz"];
    const params: unknown[] = [p.id, p.version, next, this.deps.now().toISOString()];
    for (const [key, col] of PATCH_COLUMNS) {
      if (key in patch) {
        const v = patch[key];
        params.push(v instanceof Date ? v.toISOString() : v);
        sets.push(`${col} = $${String(params.length)}${v instanceof Date ? "::timestamptz" : ""}`);
      }
    }
    const r = await tx.query<PayoutDb>(`UPDATE payouts SET ${sets.join(", ")} WHERE id = $1 AND version = $2 RETURNING ${COLS}`, params);
    const row = r.rows[0];
    if (!row) throw new PayoutsError("INVALID_STATE", `payout ${p.id} changed concurrently`);
    return map(row);
  }

  private setAccruals(tx: Queryable, payoutId: string, from: readonly string[], to: "AVAILABLE" | "SCHEDULED" | "SENT" | "PAID"): Promise<unknown> {
    const clear = to === "AVAILABLE";
    return tx.query(
      `UPDATE payout_accruals SET status = $3${clear ? ", payout_id = NULL" : ""}, updated_at = $4::timestamptz WHERE payout_id = $1 AND status = ANY($2::text[])`,
      [payoutId, from, to, this.deps.now().toISOString()],
    );
  }

  private async audit(marketId: string, action: string, payoutId: string, actor: { type: "staff" | "system"; id: string | null }, after: unknown): Promise<void> {
    await this.deps.audit.append({
      marketId, actorType: actor.type, actorId: actor.id, action, targetType: "payout", targetId: payoutId, diff: { after }, ipHash: null, deviceId: null, requestId: null,
    });
  }

  private async availableOf(tx: Queryable, marketId: string, storeId: string): Promise<bigint> {
    return negate(await Ledger.balance(tx, acct("seller_available", marketId, this.deps.currency, storeId))).amountMinor;
  }

  private async openHolds(tx: Queryable, storeId: string, now: Date): Promise<OpenHold[]> {
    const r = await tx.query<{ seller_order_id: string | null }>(
      "SELECT seller_order_id FROM payout_holds WHERE store_id = $1 AND released_at IS NULL AND starts_at <= $2::timestamptz",
      [storeId, now.toISOString()],
    );
    return r.rows.map((h) => ({ sellerOrderId: h.seller_order_id }));
  }

  private checkDestination(d: PayoutDestination | null): string | null {
    if (d === null) return "no_verified_instrument";
    return ibanNameMatches(d.accountHolderName, d.legalName) ? null : "iban_name_mismatch";
  }

  // ---------------------------------------------------------------- build

  /**
   * One batch per market and Cairo week. One payout per store with eligible money: gross = eligible accruals, adjustments = netting of
   * refunds/chargebacks after earlier payouts (chart 4.11), net = what the seller is paid. Re-running the same week is a no-op per store.
   */
  async buildCycle(marketId: string, now: Date = this.deps.now()): Promise<BuildResult> {
    const cycle = weeklyCycle(now);
    const cur = this.deps.currency;
    const { batchId, stores } = await inJob(this.deps, marketId, JOB, async (tx) => {
      await tx.query(
        `INSERT INTO payout_batches (id, market_id, cycle_start, cycle_end, currency) VALUES ($1, $2, $3::date, $4::date, $5)
         ON CONFLICT (market_id, cycle_start, cycle_end) DO NOTHING`,
        [uuidv7(), marketId, cycle.start, cycle.end, cur],
      );
      const b = await tx.query<{ id: string }>("SELECT id FROM payout_batches WHERE market_id = $1 AND cycle_start = $2::date AND cycle_end = $3::date", [marketId, cycle.start, cycle.end]);
      const s = await tx.query<{ store_id: string }>("SELECT DISTINCT store_id FROM payout_accruals WHERE status = 'AVAILABLE' AND market_id = $1 ORDER BY store_id", [marketId]);
      return { batchId: b.rows[0]?.id ?? "", stores: s.rows.map((r) => r.store_id) };
    });
    const payoutIds: string[] = [];
    const skipped: { storeId: string; reason: string }[] = [];
    for (const storeId of stores) {
      const destination = await this.deps.destinations.resolve(storeId);
      const out = await inJob(this.deps, marketId, JOB, (tx) => this.scheduleStore(tx, marketId, batchId, cycle, storeId, destination, now));
      if (out.kind === "scheduled") payoutIds.push(out.id);
      else skipped.push({ storeId, reason: out.reason });
    }
    await inJob(this.deps, marketId, JOB, async (tx) => {
      await tx.query(
        `UPDATE payout_batches SET payout_count = c.n, total_net_minor = c.total
           FROM (SELECT count(*)::int AS n, COALESCE(sum(net_minor), 0)::bigint AS total FROM payouts WHERE batch_id = $1) c WHERE id = $1`,
        [batchId],
      );
    });
    return { batchId, cycle, payoutIds, skipped };
  }

  private async scheduleStore(
    tx: Queryable, marketId: string, batchId: string, cycle: { start: string; end: string }, storeId: string, destination: PayoutDestination | null, now: Date,
  ): Promise<{ kind: "scheduled"; id: string } | { kind: "skipped"; reason: string }> {
    const cur = this.deps.currency;
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`payout:${storeId}`]);
    const same = await tx.query("SELECT 1 FROM payouts WHERE store_id = $1 AND cycle_start = $2::date AND cycle_end = $3::date", [storeId, cycle.start, cycle.end]);
    if (same.rows.length > 0) return { kind: "skipped", reason: "already_scheduled" };
    const open = await tx.query("SELECT 1 FROM payouts WHERE store_id = $1 AND status = ANY($2::text[])", [storeId, PRE_SEND_STATES]);
    if (open.rows.length > 0) return { kind: "skipped", reason: "open_payout" };
    const holds = await this.openHolds(tx, storeId, now);
    const acc = await tx.query<{ id: string; seller_order_id: string; amount_minor: string; currency: string; eligible_at: Date | string | null }>(
      `SELECT id, seller_order_id, amount_minor::text AS amount_minor, currency, eligible_at FROM payout_accruals
        WHERE store_id = $1 AND status = 'AVAILABLE' ORDER BY eligible_at, id`,
      [storeId],
    );
    if (acc.rows.some((a) => a.currency !== cur)) return { kind: "skipped", reason: "currency_mismatch" };
    const views = acc.rows.map((a) => ({
      id: a.id, amountMinor: BigInt(a.amount_minor),
      eligible: isEligible({ status: "AVAILABLE", sellerOrderId: a.seller_order_id, eligibleAt: a.eligible_at === null ? null : toDate(a.eligible_at), now, holds }),
    }));
    const plan = planPayout(views, await this.availableOf(tx, marketId, storeId));
    if (plan.kind === "none") return { kind: "skipped", reason: plan.reason };
    if (destination === null) return { kind: "skipped", reason: "no_verified_instrument" };
    const hold = this.checkDestination(destination);
    const id = uuidv7();
    const p = await tx.query<PayoutDb>(
      `INSERT INTO payouts (id, batch_id, store_id, market_id, mode, payout_instrument_id, cycle_start, cycle_end, gross_minor, adjustments_minor, net_minor, currency, status, idempotency_key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'transfer', $5, $6::date, $7::date, $8::bigint, $9::bigint, $10::bigint, $11, 'SCHEDULED', $12, $13::timestamptz, $13::timestamptz) RETURNING ${COLS}`,
      [id, batchId, storeId, marketId, destination.instrumentId, cycle.start, cycle.end, plan.grossMinor.toString(), plan.adjustmentsMinor.toString(), plan.netMinor.toString(), cur,
        `payout:${storeId}:${cycle.start}:${cycle.end}`, now.toISOString()],
    );
    for (const l of plan.lines) {
      await tx.query(
        "INSERT INTO payout_lines (id, payout_id, store_id, market_id, kind, accrual_id, amount_minor, currency) VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8)",
        [uuidv7(), id, storeId, marketId, l.kind, l.accrualId, l.amountMinor.toString(), cur],
      );
    }
    await tx.query("UPDATE payout_accruals SET status = 'SCHEDULED', payout_id = $1, updated_at = $2::timestamptz WHERE id = ANY($3::uuid[])", [id, now.toISOString(), plan.lines.flatMap((l) => (l.accrualId === null ? [] : [l.accrualId]))]);
    await emit(tx, marketId, now, "payout.scheduled", "payout", id, { store_id: storeId, net_minor: plan.netMinor.toString(), currency: cur, cycle_start: cycle.start, cycle_end: cycle.end });
    const inserted = p.rows[0];
    if (inserted === undefined) throw new PayoutsError("INVALID_STATE", "payout insert returned no row");
    if (hold !== null) await this.move(tx, map(inserted), "hold", { holdReason: hold });
    await this.audit(marketId, "payout.scheduled", id, { type: "system", id: null }, { storeId, netMinor: plan.netMinor.toString(), hold });
    return { kind: "scheduled", id };
  }

  // ---------------------------------------------------------------- approval (dual above the threshold, via admin-access)

  /**
   * Below the threshold the actor approves directly. At or above it (policy.dualApprovalRequired) a PENDING approval request is filed and
   * stored on the payout; a second admin decides it, then completeApproval moves the payout to APPROVED.
   * Pass renew = true to file a new request after the previous one was rejected or expired.
   */
  async approve(actor: Principal, payoutId: string, opts: { readonly renew?: boolean } = {}): Promise<ApproveOutcome> {
    const marketId = actor.marketId;
    const approverId = adminActor(actor);
    const p = await this.get(marketId, payoutId);
    mustApprove(actor, p);
    if (p.status !== "SCHEDULED") throw new PayoutsError("INVALID_STATE", `payout is ${p.status}`);
    if (p.approvalRequestId !== null && opts.renew !== true) return { status: "approval_required", requestId: p.approvalRequestId };
    const r = await this.deps.admin.requireApproval(actor, {
      action: "payout.approve", targetType: "payout", targetId: payoutId, payload: { payoutId, storeId: p.storeId, currency: p.currency }, amountMinor: p.netMinor,
    });
    if (!r.required) {
      await this.markApproved(marketId, payoutId, approverId);
      return { status: "approved" };
    }
    await inJob(this.deps, marketId, JOB, async (tx) => {
      const cur = await this.load(tx, payoutId, true);
      if (cur.status !== "SCHEDULED") throw new PayoutsError("INVALID_STATE", `payout is ${cur.status}`);
      await tx.query("UPDATE payouts SET approval_request_id = $2, version = version + 1, updated_at = $3::timestamptz WHERE id = $1", [payoutId, r.request.id, this.deps.now().toISOString()]);
    });
    await this.audit(marketId, "payout.approval_requested", payoutId, { type: "staff", id: approverId }, { requestId: r.request.id, netMinor: p.netMinor.toString() });
    return { status: "approval_required", requestId: r.request.id };
  }

  /** Second step of dual approval: the executing admin consumes the APPROVED request (exactly once) and the payout becomes APPROVED. Replays are safe. */
  async completeApproval(actor: Principal, payoutId: string): Promise<ApproveOutcome> {
    const marketId = actor.marketId;
    const executorId = adminActor(actor);
    const p = await this.get(marketId, payoutId);
    mustApprove(actor, p);
    if (p.status === "APPROVED") return { status: "approved" };
    if (p.status !== "SCHEDULED") throw new PayoutsError("INVALID_STATE", `payout is ${p.status}`);
    if (p.approvalRequestId === null) throw new PayoutsError("APPROVAL_NOT_READY", "no approval request was filed for this payout");
    const requestId = p.approvalRequestId;
    const exec = await this.deps.admin.executeApproval(actor, requestId, (req) => {
      if (req.action !== "payout.approve" || req.targetType !== "payout" || req.targetId !== payoutId) {
        return Promise.reject(new PayoutsError("APPROVAL_NOT_READY", "approval request does not belong to this payout"));
      }
      return Promise.resolve(req.id);
    });
    if (!exec.executed) {
      // The request was consumed by an earlier call whose second commit (markApproved) never ran. Resume only after re-reading it (B3).
      const req = await this.deps.readApproval?.(requestId);
      if (req === undefined || req === null) throw new PayoutsError("APPROVAL_NOT_READY", "approval already consumed and cannot be verified; file a renewed request");
      if (req.action !== "payout.approve" || req.targetType !== "payout" || req.targetId !== payoutId || req.status !== "APPROVED") {
        throw new PayoutsError("APPROVAL_NOT_READY", "approval request does not belong to this payout");
      }
    }
    await this.markApproved(marketId, payoutId, executorId);
    return { status: "approved" };
  }

  private async markApproved(marketId: string, payoutId: string, approverId: string): Promise<void> {
    await inJob(this.deps, marketId, JOB, async (tx) => {
      const p = await this.load(tx, payoutId, true);
      if (p.status === "APPROVED") return;
      await this.move(tx, p, "approve", { approvedBy: approverId, approvedAt: this.deps.now() });
    });
    await this.audit(marketId, "payout.approved", payoutId, { type: "staff", id: approverId }, {});
  }

  // ---------------------------------------------------------------- hold / release / cancel

  async hold(marketId: string, payoutId: string, reason: string): Promise<void> {
    await inJob(this.deps, marketId, JOB, async (tx) => {
      const p = await this.load(tx, payoutId, true);
      await this.move(tx, p, "hold", { holdReason: reason });
      await emit(tx, marketId, this.deps.now(), "payout.on_hold", "payout", payoutId, { reason });
    });
    await this.audit(marketId, "payout.on_hold", payoutId, { type: "system", id: null }, { reason });
  }

  /** ON_HOLD -> SCHEDULED. The earlier approval is void: it must be requested again. */
  async release(marketId: string, payoutId: string): Promise<void> {
    await inJob(this.deps, marketId, JOB, async (tx) => {
      const p = await this.load(tx, payoutId, true);
      await this.move(tx, p, "release", { holdReason: null, approvalRequestId: null, approvedBy: null, approvedAt: null });
    });
    await this.audit(marketId, "payout.released", payoutId, { type: "system", id: null }, {});
  }

  /** Frees the accruals: they become AVAILABLE again and are picked up by the next cycle. */
  async cancel(marketId: string, payoutId: string, reason: string): Promise<void> {
    await inJob(this.deps, marketId, JOB, async (tx) => {
      const p = await this.load(tx, payoutId, true);
      await this.move(tx, p, "cancel", { holdReason: reason });
      await this.setAccruals(tx, payoutId, ["SCHEDULED"], "AVAILABLE");
      await this.completeBatchIfDone(tx, p.batchId);
      await emit(tx, marketId, this.deps.now(), "payout.cancelled", "payout", payoutId, { reason });
    });
    await this.audit(marketId, "payout.cancelled", payoutId, { type: "system", id: null }, { reason });
  }

  // ---------------------------------------------------------------- send

  /**
   * APPROVED -> SENT. Idempotent: the ledger entry is keyed payout_sent:{id}, the rail call carries payout:{id}.
   * A rail that throws leaves the payout SENT (outcome unknown): call send again, the same key is used. Re-checks the balance (I12)
   * and the destination before any money moves; a failed check parks the payout ON_HOLD instead of paying.
   */
  async send(marketId: string, payoutId: string): Promise<SendOutcome> {
    const cur = this.deps.currency;
    const first = await this.get(marketId, payoutId);
    const destination = await this.deps.destinations.resolve(first.storeId);
    const step = await inJob(this.deps, marketId, JOB, async (tx): Promise<{ kind: "go"; p: PayoutRow } | { kind: "held"; reason: string } | { kind: "done"; p: PayoutRow }> => {
      const p = await this.load(tx, payoutId, true);
      if (p.status === "SENT") return p.providerRef === null ? { kind: "go", p } : { kind: "done", p };
      if (p.status !== "APPROVED") throw new PayoutsError("INVALID_STATE", `payout is ${p.status}, not APPROVED`);
      const bad = this.checkDestination(destination) ?? ((await this.availableOf(tx, marketId, p.storeId)) < p.netMinor ? "insufficient_balance" : null);
      if (bad !== null) {
        await this.move(tx, p, "hold", { holdReason: bad });
        await emit(tx, marketId, this.deps.now(), "payout.on_hold", "payout", payoutId, { reason: bad });
        return { kind: "held", reason: bad };
      }
      const now = this.deps.now();
      const { entryId } = await Ledger.post(tx, {
        kind: "payout_sent", idempotencyKey: `payout_sent:${p.id}:${String(p.sendAttempt)}`, marketId, occurredAt: now, ref: { type: "payout", id: p.id },
        postings: [
          { accountCode: acct("seller_available", marketId, cur, p.storeId), amount: money(p.netMinor, cur) },
          { accountCode: acct("payouts_in_transit", marketId, cur), amount: money(-p.netMinor, cur) },
        ],
      });
      const sent = await this.move(tx, p, "send", { sentEntryId: entryId, sentAt: now, provider: null, providerRef: null });
      await this.setAccruals(tx, payoutId, ["SCHEDULED"], "SENT");
      await emit(tx, marketId, now, "payout.sent", "payout", payoutId, { store_id: p.storeId, net_minor: p.netMinor.toString(), currency: cur });
      return { kind: "go", p: sent };
    });
    if (step.kind === "held") {
      await this.audit(marketId, "payout.on_hold", payoutId, { type: "system", id: null }, { reason: step.reason });
      return { status: "ON_HOLD", reason: step.reason };
    }
    if (step.kind === "done") return { status: "SENT", providerRef: step.p.providerRef };
    if (destination === null) throw new PayoutsError("INVALID_STATE", "destination vanished between check and send");
    const res = await this.deps.rail.send({ idempotencyKey: `payout:${payoutId}:${String(step.p.sendAttempt)}`, payoutId, storeId: step.p.storeId, amount: money(step.p.netMinor, cur), destination });
    if (res.status === "rejected") {
      await this.fail(marketId, payoutId, res.code, { providerRef: null, sendAttempt: step.p.sendAttempt });
      return { status: "FAILED", code: res.code };
    }
    await inJob(this.deps, marketId, JOB, (tx) =>
      tx.query("UPDATE payouts SET provider = $2, provider_ref = $3, updated_at = $4::timestamptz WHERE id = $1 AND status = 'SENT'", [payoutId, res.provider, res.providerRef, this.deps.now().toISOString()]),
    );
    await this.audit(marketId, "payout.sent", payoutId, { type: "system", id: null }, { provider: res.provider, providerRef: res.providerRef });
    return { status: "SENT", providerRef: res.providerRef };
  }

  // ---------------------------------------------------------------- failure and settlement

  /**
   * SENT -> FAILED (rail rejected, or the bank reported a return): reversing ledger entry, accruals back to SCHEDULED, payout parked ON_HOLD.
   * `attempt` names the send being failed (B1): it must equal the payout's current sendAttempt and provider_ref, otherwise a stale return for an
   * earlier attempt would reverse a later one. A replay of an already-applied failure (same attempt, payout parked) is a no-op.
   */
  async fail(marketId: string, payoutId: string, code: string, attempt: FailAttempt): Promise<void> {
    const did = await inJob(this.deps, marketId, JOB, async (tx) => {
      const p = await this.load(tx, payoutId, true);
      if (p.status === "ON_HOLD" && p.failureCode !== null && attempt.sendAttempt === p.sendAttempt - 1 && attempt.providerRef === p.providerRef) return false;
      if (attempt.sendAttempt !== p.sendAttempt || attempt.providerRef !== p.providerRef) {
        throw new PayoutsError("STALE_ATTEMPT", `failure names attempt ${String(attempt.sendAttempt)} but the payout is at attempt ${String(p.sendAttempt)}`);
      }
      if (p.sentEntryId === null) throw new PayoutsError("INVALID_STATE", "payout was never sent");
      transition(PAYOUT, p.status, "fail");
      await Ledger.reverse(tx, p.sentEntryId, { idempotencyKey: `payout_failed:${p.id}:${String(p.sendAttempt)}`, reason: `payout failed: ${code}`.slice(0, 500), occurredAt: this.deps.now() });
      const failed = await this.move(tx, p, "fail", { failureCode: code });
      await this.move(tx, failed, "park", { holdReason: `rail_failed:${code}`.slice(0, 100), sendAttempt: p.sendAttempt + 1 });
      await this.setAccruals(tx, payoutId, ["SENT"], "SCHEDULED");
      await emit(tx, marketId, this.deps.now(), "payout.failed", "payout", payoutId, { store_id: p.storeId, net_minor: p.netMinor.toString(), failure_code: code });
      return true;
    });
    if (did) await this.audit(marketId, "payout.failed", payoutId, { type: "system", id: null }, { code });
  }

  /** The bank confirms the transfer: SENT -> SETTLED, Dr payouts_in_transit / Cr bank_collections (chart 4.11), accruals PAID. Replay-safe. */
  async settle(marketId: string, payoutId: string, settledAt: Date = this.deps.now()): Promise<void> {
    const cur = this.deps.currency;
    const did = await inJob(this.deps, marketId, JOB, async (tx) => {
      const p = await this.load(tx, payoutId, true);
      if (p.status === "SETTLED") return false;
      if (!can(PAYOUT, p.status, "settle")) throw new PayoutsError("INVALID_STATE", `payout is ${p.status}, not SENT`);
      const { entryId } = await Ledger.post(tx, {
        kind: "payout_settled", idempotencyKey: `payout_settled:${p.id}`, marketId, occurredAt: settledAt, ref: { type: "payout", id: p.id },
        postings: [
          { accountCode: acct("payouts_in_transit", marketId, cur), amount: money(p.netMinor, cur) },
          { accountCode: acct("bank_collections", marketId, cur, BANK_OWNER), amount: money(-p.netMinor, cur) },
        ],
      });
      await this.move(tx, p, "settle", { settledEntryId: entryId, settledAt });
      await this.setAccruals(tx, payoutId, ["SENT"], "PAID");
      await this.completeBatchIfDone(tx, p.batchId);
      await emit(tx, marketId, this.deps.now(), "payout.settled", "payout", payoutId, { store_id: p.storeId, net_minor: p.netMinor.toString(), currency: cur });
      return true;
    });
    if (did) await this.audit(marketId, "payout.settled", payoutId, { type: "system", id: null }, {});
  }

  /** Settlement notification keyed by the provider reference recorded at send. */
  async settleByProviderRef(marketId: string, provider: string, providerRef: string, settledAt?: Date): Promise<void> {
    const id = await inJob(this.deps, marketId, JOB, async (tx) => {
      const r = await tx.query<{ id: string }>("SELECT id FROM payouts WHERE provider = $1 AND provider_ref = $2", [provider, providerRef]);
      return r.rows[0]?.id;
    });
    if (id === undefined) throw new PayoutsError("NOT_FOUND", `no payout for ${provider}:${providerRef}`);
    await this.settle(marketId, id, settledAt);
  }

  private async completeBatchIfDone(tx: Queryable, batchId: string): Promise<void> {
    await tx.query(
      `UPDATE payout_batches SET status = 'COMPLETED', completed_at = $2::timestamptz
        WHERE id = $1 AND status = 'SCHEDULED' AND NOT EXISTS (SELECT 1 FROM payouts WHERE batch_id = $1 AND status NOT IN ('SETTLED', 'CANCELLED'))`,
      [batchId, this.deps.now().toISOString()],
    );
  }
}
