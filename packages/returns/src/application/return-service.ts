import { withDbContext } from "@outlet/db";
import type { Queryable } from "@outlet/db";
import { authorize } from "@outlet/policy";
import type { Principal } from "@outlet/policy";
import { z } from "zod";
import { addBusinessDays, addDays, addHours, checkEligibility, decideResolution, isSerialReturner, returnShippingPayer } from "../domain/eligibility.js";
import { ReturnsError } from "../domain/errors.js";
import { transition } from "@outlet/orders";
import { RETURN } from "../domain/machines.js";
import type { ReturnEvent, ReturnState } from "../domain/machines.js";
import { RETURN_REASONS } from "../domain/reasons.js";
import { emit, makeEnv } from "./env.js";
import type { Env, ReturnsDeps } from "./env.js";

const uuid = z.uuid();
const requestSchema = z.strictObject({
  items: z.array(z.strictObject({ orderLineId: uuid, qty: z.number().int().min(1).max(10) })).min(1).max(50),
  reason: z.enum(RETURN_REASONS),
  method: z.enum(["pickup", "dropoff"]),
  evidenceMediaIds: z.array(uuid).max(10).default([]),
  /** Shopper's choice where both are legal (15.6). null = default for the tender. */
  refundChoice: z.enum(["original", "store_credit"]).nullable().default(null),
  /** Size reasons default to an exchange when the swap is in stock; set to insist on a refund. */
  preferRefund: z.boolean().default(false),
  idempotencyKey: uuid,
});
export type RequestReturnInput = z.input<typeof requestSchema>;

const inspectSchema = z.strictObject({
  result: z.enum(["accepted", "rejected"]),
  reasonCode: z.string().min(1).max(100).optional(),
  notes: z.string().max(2000).optional(),
  items: z.array(z.strictObject({
    orderLineId: uuid,
    condition: z.enum(["as_new", "used", "damaged", "defective", "missing"]),
    restock: z.enum(["restock", "relist_open_box", "write_off", "donate"]),
  })).max(50).default([]),
});
const restockSchema = z.object({
  return_item_id: uuid, store_id: uuid, sku_id: uuid, qty: z.number().int().min(1), decision: z.enum(["restock", "relist_open_box", "write_off", "donate"]),
});
export type InspectInput = z.input<typeof inspectSchema>;

export interface ReturnView {
  readonly id: string;
  readonly status: ReturnState;
  readonly sellerOrderId: string;
  readonly storeId: string;
  readonly reason: string;
  readonly resolution: string;
  readonly windowEndsAt: string;
  readonly inspectionDueAt: string | null;
  readonly replayed: boolean;
}

interface ReturnRow {
  id: string; status: ReturnState; seller_order_id: string; store_id: string; user_id: string; reason_code: string; resolution: string;
  window_ends_at: string; inspection_due_at: string | null; refund_due_at: string | null;
}

const view = (r: ReturnRow, replayed: boolean): ReturnView => ({
  id: r.id, status: r.status, sellerOrderId: r.seller_order_id, storeId: r.store_id, reason: r.reason_code, resolution: r.resolution,
  windowEndsAt: new Date(r.window_ends_at).toISOString(), inspectionDueAt: r.inspection_due_at === null ? null : new Date(r.inspection_due_at).toISOString(), replayed,
});

const ACTIVE = "('REQUESTED','APPROVED','PICKUP_SCHEDULED','IN_TRANSIT','RECEIVED','ACCEPTED','REJECTED','DISPUTED')";

export const lockReturn = async (tx: Queryable, id: string): Promise<ReturnRow> => {
  const r = await tx.query<ReturnRow>(
    `SELECT id, status, seller_order_id, store_id, user_id, reason_code, resolution, window_ends_at, inspection_due_at, refund_due_at FROM return_requests WHERE id = $1 FOR UPDATE`,
    [uuid.parse(id)],
  );
  const row = r.rows[0];
  if (row === undefined) throw new ReturnsError("not_found");
  return row;
};

export const setReturnStatus = async (tx: Queryable, id: string, from: ReturnState, event: ReturnEvent, now: Date, extra: { received?: Date; due?: Date; refundDue?: Date } = {}): Promise<ReturnState> => {
  let next: ReturnState;
  try {
    next = transition(RETURN, from, event);
  } catch {
    throw new ReturnsError("invalid_state", `return: cannot ${event} from ${from}`);
  }
  await tx.query(
    `UPDATE return_requests SET status = $2, version = version + 1, updated_at = $3::timestamptz,
            received_at = COALESCE($4::timestamptz, received_at), inspection_due_at = COALESCE($5::timestamptz, inspection_due_at), refund_due_at = COALESCE($6::timestamptz, refund_due_at)
      WHERE id = $1`,
    [id, next, now.toISOString(), extra.received?.toISOString() ?? null, extra.due?.toISOString() ?? null, extra.refundDue?.toISOString() ?? null],
  );
  return next;
};

/** Shopper, seller and system flows of a return (section 22). Authorization is deny-by-default: RLS (user / store context) plus @outlet/policy. */
export class ReturnService {
  private readonly env: Env;
  constructor(deps: ReturnsDeps) {
    this.env = makeEnv(deps);
  }

  private user<T>(userId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.env.app, { kind: "user", marketId: this.env.marketId, userId }, fn);
  }
  private store<T>(storeId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.env.app, { kind: "store", marketId: this.env.marketId, storeId }, fn);
  }
  private worker<T>(userId: string | null, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.env.worker, { kind: "worker", marketId: this.env.marketId, job: "finance.refunds", ...(userId === null ? {} : { userId }) }, fn);
  }

  /**
   * Shopper requests a return. Rules: delivered_at from the courier (never the order date); 14 days no reason, 30 days defect;
   * photos for defect / not-as-described; a disclosed-and-acknowledged defect is not a reason (ADR-0009); non-returnable categories
   * only for defects; exchange-first for size reasons. A window-valid request is approved at once (it is a statutory right).
   */
  async request(userId: string, raw: RequestReturnInput): Promise<ReturnView> {
    const input = requestSchema.parse(raw);
    const env = this.env;
    const now = env.now();
    const evidenceOk = input.evidenceMediaIds.length === 0 ? true : await env.evidence.allReady(input.evidenceMediaIds, userId);
    return this.user(userId, async (tx) => {
      const prior = await tx.query<ReturnRow>(
        `SELECT id, status, seller_order_id, store_id, user_id, reason_code, resolution, window_ends_at, inspection_due_at, refund_due_at FROM return_requests WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, input.idempotencyKey],
      );
      if (prior.rows[0] !== undefined) return view(prior.rows[0], true);

      const ids = input.items.map((x) => x.orderLineId);
      if (new Set(ids).size !== ids.length) throw new ReturnsError("nothing_to_return", "duplicate order line");
      const lines = (
        await tx.query<{ id: string; seller_order_id: string; order_group_id: string; store_id: string; sku_id: string; qty: number; status: string; defect_card: string | null; defect_ack: string | null; so_status: string; delivered_at: string | null }>(
          `SELECT l.id, l.seller_order_id, l.order_group_id, l.store_id, l.sku_id, l.qty, l.status, l.defect_card_id_snapshot AS defect_card, l.defect_ack_at AS defect_ack,
                  s.status AS so_status, s.delivered_at
             FROM order_lines l JOIN seller_orders s ON s.id = l.seller_order_id WHERE l.id = ANY($1::uuid[])`,
          [ids],
        )
      ).rows;
      // RLS hides foreign lines: any missing id is a 404, never a hint that it exists.
      if (lines.length !== ids.length) throw new ReturnsError("not_found");
      const first = lines[0];
      if (first === undefined || lines.some((l) => l.seller_order_id !== first.seller_order_id)) throw new ReturnsError("not_found");
      if (first.so_status !== "DELIVERED" && first.so_status !== "CLOSED") throw new ReturnsError("not_delivered");

      const nonReturnable = await env.policy.nonReturnable(lines.map((l) => l.sku_id));
      const eligibility = checkEligibility({
        reason: input.reason, deliveredAt: first.delivered_at === null ? null : new Date(first.delivered_at), now,
        nonReturnable: lines.some((l) => nonReturnable.has(l.sku_id)),
        disclosedDefect: lines.some((l) => l.defect_card !== null && l.defect_ack !== null),
        evidenceCount: evidenceOk ? input.evidenceMediaIds.length : 0,
      }, env.config);
      if (!eligibility.ok) throw new ReturnsError(eligibility.code === "photos_required" && input.evidenceMediaIds.length > 0 && !evidenceOk ? "evidence_invalid" : eligibility.code);

      const already = new Map(
        (
          await tx.query<{ order_line_id: string; q: string }>(
            `SELECT ri.order_line_id, SUM(ri.qty)::text AS q FROM return_items ri JOIN return_requests r ON r.id = ri.return_request_id
              WHERE ri.order_line_id = ANY($1::uuid[]) AND (r.status IN ${ACTIVE} OR (r.status = 'CLOSED' AND EXISTS (SELECT 1 FROM refunds f WHERE f.return_request_id = r.id)))
              GROUP BY ri.order_line_id`,
            [ids],
          )
        ).rows.map((r) => [r.order_line_id, Number(r.q)] as const),
      );
      for (const it of input.items) {
        const line = lines.find((l) => l.id === it.orderLineId);
        if (line === undefined || (already.get(line.id) ?? 0) + it.qty > line.qty) throw new ReturnsError("qty_exceeds_purchased");
      }

      const since = addDays(now, -183).toISOString();
      const counts = (
        await tx.query<{ delivered: string; returned: string }>(
          `SELECT count(*)::text AS delivered,
                  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM return_requests r WHERE r.seller_order_id = s.id AND r.resolution <> 'exchange'
                    AND (EXISTS (SELECT 1 FROM return_inspections i WHERE i.return_request_id = r.id AND i.result = 'accepted') OR EXISTS (SELECT 1 FROM refunds f WHERE f.return_request_id = r.id))))::text AS returned
             FROM seller_orders s WHERE s.user_id = $1 AND s.delivered_at IS NOT NULL AND s.delivered_at >= $2::timestamptz`,
          [userId, since],
        )
      ).rows[0];
      const serial = isSerialReturner(Number(counts?.delivered ?? 0), Number(counts?.returned ?? 0), env.config);

      const swap = lines.length === 1 ? await env.policy.sizeSwapAvailable(first.sku_id) : false;
      const resolution = decideResolution(input.reason, swap, input.preferRefund);
      const payer = returnShippingPayer(input.reason, resolution, await env.policy.isPlusMember(userId), serial);

      const id = env.newId();
      await tx.query(
        `INSERT INTO return_requests (id, seller_order_id, order_group_id, user_id, store_id, market_id, status, reason_code, fault, window_basis, delivered_at_snapshot, window_ends_at,
                                      method, resolution, refund_choice, return_shipping_payer, serial_returner, idempotency_key, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'REQUESTED',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)`,
        [id, first.seller_order_id, first.order_group_id, userId, first.store_id, env.marketId, input.reason, eligibility.fault, eligibility.windowBasis, first.delivered_at, eligibility.windowEndsAt.toISOString(),
         input.method, resolution, input.refundChoice, payer, serial, input.idempotencyKey, now.toISOString()],
      );
      for (const it of input.items) {
        await tx.query(`INSERT INTO return_items (id, return_request_id, order_line_id, user_id, store_id, market_id, qty) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [env.newId(), id, it.orderLineId, userId, first.store_id, env.marketId, it.qty]);
      }
      for (const m of input.evidenceMediaIds) {
        await tx.query(
          `INSERT INTO return_evidence (id, return_request_id, user_id, store_id, market_id, uploaded_by_type, media_id, kind) VALUES ($1,$2,$3,$4,$5,'shopper',$6,'defect_photo')`,
          [env.newId(), id, userId, first.store_id, env.marketId, m],
        );
      }
      await setReturnStatus(tx, id, "REQUESTED", "approve", now);
      for (const it of input.items) {
        const line = lines.find((l) => l.id === it.orderLineId);
        if ((already.get(it.orderLineId) ?? 0) + it.qty === line?.qty) await tx.query("UPDATE order_lines SET status = 'return_requested' WHERE id = $1 AND status = 'active'", [it.orderLineId]);
      }
      await emit(env, tx, "return.requested", "return_request", id, { return_request_id: id, seller_order_id: first.seller_order_id, store_id: first.store_id, reason: input.reason, resolution });
      return { id, status: "APPROVED", sellerOrderId: first.seller_order_id, storeId: first.store_id, reason: input.reason, resolution, windowEndsAt: eligibility.windowEndsAt.toISOString(), inspectionDueAt: null, replayed: false };
    });
  }

  /** Shopper reads one of their own returns. Another shopper's id is not_found. */
  async getForShopper(userId: string, returnId: string): Promise<ReturnView> {
    return this.user(userId, async (tx) => view(await lockReturnPlain(tx, returnId), false));
  }

  /** Shopper cancels before the parcel is handed over. */
  async cancel(userId: string, returnId: string): Promise<ReturnView> {
    return this.user(userId, async (tx) => {
      const r = await lockReturn(tx, returnId);
      await setReturnStatus(tx, r.id, r.status, "cancel", this.env.now());
      await tx.query(`UPDATE order_lines SET status = 'active' WHERE status = 'return_requested' AND id IN (SELECT order_line_id FROM return_items WHERE return_request_id = $1)`, [r.id]);
      return view({ ...r, status: "CANCELLED" }, false);
    });
  }

  /** Seller (warehouse / hub) queue. RLS shows only the store's own returns. */
  async listForStore(actor: Principal, storeId: string): Promise<readonly ReturnView[]> {
    this.assert(actor, "return.read", storeId);
    return this.store(storeId, async (tx) =>
      (await tx.query<ReturnRow>(`SELECT id, status, seller_order_id, store_id, user_id, reason_code, resolution, window_ends_at, inspection_due_at, refund_due_at FROM return_requests ORDER BY created_at DESC, id DESC LIMIT 50`)).rows.map((r) => view(r, false)),
    );
  }

  /** Courier / warehouse: parcel scanned back at the store or hub. Starts the 48 h inspection clock and the legal refund deadline. */
  async receive(actor: Principal, storeId: string, returnId: string): Promise<ReturnView> {
    this.assert(actor, "return.inspect", storeId);
    const now = this.env.now();
    return this.store(storeId, async (tx) => {
      const r = await lockReturn(tx, returnId);
      let s = r.status;
      if (s === "APPROVED") s = await setReturnStatus(tx, r.id, s, "in_transit", now);
      else if (s === "PICKUP_SCHEDULED") s = await setReturnStatus(tx, r.id, s, "in_transit", now);
      const due = addHours(now, this.env.config.inspectionHours);
      const refundDue = addDays(now, this.env.config.refundDeadlineDays);
      await setReturnStatus(tx, r.id, s, "receive", now, { received: now, due, refundDue });
      await emit(this.env, tx, "return.received", "return_request", r.id, { return_request_id: r.id, store_id: storeId });
      return view({ ...r, status: "RECEIVED", inspection_due_at: due.toISOString(), refund_due_at: refundDue.toISOString() }, false);
    });
  }

  async schedulePickup(actor: Principal, storeId: string, returnId: string): Promise<ReturnView> {
    this.assert(actor, "return.inspect", storeId);
    return this.store(storeId, async (tx) => {
      const r = await lockReturn(tx, returnId);
      await setReturnStatus(tx, r.id, r.status, "schedule_pickup", this.env.now());
      return view({ ...r, status: "PICKUP_SCHEDULED" }, false);
    });
  }

  /**
   * Seller inspection within 48 h of receipt. Accept emits return.accepted (the finance.refunds worker creates the refund);
   * reject needs a reason code and photos stay with the shopper's dispute path. Restock decisions are emitted as return.restock_requested (consumeRestock).
   */
  async inspect(actor: Principal, storeId: string, returnId: string, raw: InspectInput): Promise<ReturnView> {
    this.assert(actor, "return.inspect", storeId);
    const input = inspectSchema.parse(raw);
    if (input.result === "rejected" && (input.reasonCode === undefined || input.reasonCode.trim() === "")) throw new ReturnsError("invalid_state", "a rejection needs a reason code");
    const env = this.env;
    const now = env.now();
    const out = await this.store(storeId, async (tx) => {
      const r = await lockReturn(tx, returnId);
      if (r.status !== "RECEIVED") throw new ReturnsError("invalid_state", `return is ${r.status}, not RECEIVED`);
      const items = (await tx.query<{ id: string; order_line_id: string; qty: number; sku_id: string }>(
        `SELECT ri.id, ri.order_line_id, ri.qty, l.sku_id FROM return_items ri JOIN order_lines l ON l.id = ri.order_line_id WHERE ri.return_request_id = $1`, [r.id],
      )).rows;
      await tx.query(
        `INSERT INTO return_inspections (id, return_request_id, user_id, store_id, market_id, inspector_type, result, reason_code, notes, inspected_at) VALUES ($1,$2,$3,$4,$5,'seller',$6,$7,$8,$9)`,
        [env.newId(), r.id, r.user_id, storeId, env.marketId, input.result, input.reasonCode ?? null, input.notes ?? null, now.toISOString()],
      );
      for (const d of input.items) {
        const it = items.find((x) => x.order_line_id === d.orderLineId);
        if (it === undefined) throw new ReturnsError("not_found");
        await tx.query("UPDATE return_items SET condition_received = $2, restock_decision = $3 WHERE id = $1", [it.id, d.condition, d.restock]);
        if (input.result === "accepted") {
          // Restock is an at-least-once consumer of this event (consumeRestock), never a post-commit call that a crash could lose.
          await emit(env, tx, "return.restock_requested", "return_item", it.id, { return_item_id: it.id, return_request_id: r.id, store_id: storeId, sku_id: it.sku_id, qty: it.qty, decision: d.restock });
        }
      }
      const status = await setReturnStatus(tx, r.id, r.status, input.result === "accepted" ? "inspect_accept" : "inspect_reject", now);
      await emit(env, tx, input.result === "accepted" ? "return.accepted" : "return.rejected", "return_request", r.id, { return_request_id: r.id, store_id: storeId, user_id: r.user_id });
      return view({ ...r, status }, false);
    });
    return out;
  }

  /** Worker job: silence for 48 h after receipt = auto-approve (section 22). Returns the ids it accepted. */
  async autoApproveDue(limit = 50): Promise<readonly string[]> {
    const env = this.env;
    const now = env.now();
    const due = await this.worker(null, async (tx) =>
      (await tx.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM return_requests WHERE market_id = $1 AND status = 'RECEIVED' AND inspection_due_at <= $2::timestamptz ORDER BY inspection_due_at, id LIMIT $3::int`,
        [env.marketId, now.toISOString(), limit],
      )).rows,
    );
    const done: string[] = [];
    for (const row of due) {
      const ok = await this.worker(row.user_id, async (tx) => {
        const r = await lockReturn(tx, row.id);
        if (r.status !== "RECEIVED" || r.inspection_due_at === null || new Date(r.inspection_due_at).getTime() > now.getTime()) return false;
        await tx.query(
          `INSERT INTO return_inspections (id, return_request_id, user_id, store_id, market_id, inspector_type, result, notes, inspected_at) VALUES ($1,$2,$3,$4,$5,'system','accepted','auto-approved: no inspection within the deadline',$6)`,
          [env.newId(), r.id, r.user_id, r.store_id, env.marketId, now.toISOString()],
        );
        await setReturnStatus(tx, r.id, r.status, "auto_accept", now);
        await emit(env, tx, "return.accepted", "return_request", r.id, { return_request_id: r.id, store_id: r.store_id, user_id: r.user_id, auto: true });
        return true;
      });
      if (ok) done.push(row.id);
    }
    return done;
  }

  /**
   * Inbox consumer of return.restock_requested (at-least-once). Duplicate deliveries are skipped; a failing restock leaves no inbox row,
   * so the message is redelivered and retried. RestockPort.apply is idempotent per key, so a crash between apply and the inbox row is safe.
   */
  async consumeRestock(messageId: string, payload: Readonly<Record<string, unknown>>): Promise<"processed" | "duplicate"> {
    const msg = restockSchema.parse(payload);
    const consumer = "returns.restock";
    const seen = await this.worker(null, async (tx) => (await tx.query("SELECT 1 FROM inbox_processed WHERE consumer = $1 AND message_id = $2", [consumer, uuid.parse(messageId)])).rows.length > 0);
    if (seen) return "duplicate";
    await this.env.restock.apply({ storeId: msg.store_id, skuId: msg.sku_id, qty: msg.qty, decision: msg.decision, idempotencyKey: `return_restock:${msg.return_item_id}` });
    await this.worker(null, async (tx) => {
      await tx.query("INSERT INTO inbox_processed (consumer, message_id) VALUES ($1, $2) ON CONFLICT (consumer, message_id) DO NOTHING", [consumer, messageId]);
    });
    return "processed";
  }

  /** Worker job: a REJECTED return nobody disputed within rejectedCloseDays closes (REJECTED -> CLOSED). Returns the ids it closed. */
  async closeRejected(limit = 50): Promise<readonly string[]> {
    const env = this.env;
    const now = env.now();
    const cutoff = addDays(now, -env.config.rejectedCloseDays);
    const due = await this.worker(null, async (tx) =>
      (await tx.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM return_requests WHERE market_id = $1 AND status = 'REJECTED' AND updated_at <= $2::timestamptz ORDER BY updated_at, id LIMIT $3::int`,
        [env.marketId, cutoff.toISOString(), limit],
      )).rows,
    );
    const done: string[] = [];
    for (const row of due) {
      const ok = await this.worker(row.user_id, async (tx) => {
        const r = await lockReturn(tx, row.id);
        if (r.status !== "REJECTED") return false;
        await setReturnStatus(tx, r.id, r.status, "close", now);
        await emit(env, tx, "return.closed", "return_request", r.id, { return_request_id: r.id, store_id: r.store_id, reason: "rejection_not_disputed" });
        return true;
      });
      if (ok) done.push(row.id);
    }
    return done;
  }

  /** Worker job: emit dispute.sla_breached once for every open dispute past its 5-business-day T&S deadline (the human review SLA). */
  async flagDisputeSlaBreaches(limit = 50): Promise<readonly string[]> {
    const env = this.env;
    const now = env.now();
    const due = await this.worker(null, async (tx) =>
      (await tx.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM disputes WHERE market_id = $1 AND status IN ('OPEN','UNDER_REVIEW') AND sla_due_at < $2::timestamptz AND sla_breach_notified_at IS NULL ORDER BY sla_due_at, id LIMIT $3::int`,
        [env.marketId, now.toISOString(), limit],
      )).rows,
    );
    const done: string[] = [];
    for (const row of due) {
      const ok = await this.worker(row.user_id, async (tx) => {
        const d = (await tx.query<{ id: string; return_request_id: string; sla_due_at: string }>(
          "UPDATE disputes SET sla_breach_notified_at = $2::timestamptz WHERE id = $1 AND sla_breach_notified_at IS NULL AND status IN ('OPEN','UNDER_REVIEW') RETURNING id, return_request_id, sla_due_at", [row.id, now.toISOString()],
        )).rows[0];
        if (d === undefined) return false;
        await emit(env, tx, "dispute.sla_breached", "dispute", d.id, { dispute_id: d.id, return_request_id: d.return_request_id, sla_due_at: new Date(d.sla_due_at).toISOString() });
        return true;
      });
      if (ok) done.push(row.id);
    }
    return done;
  }

  /** Shopper disputes a seller rejection. A T&S human reviews within 5 business days (V15-style fairness rule, section 22). */
  async openDispute(userId: string, returnId: string, input: { reasonCode: "item_was_defective" | "item_not_as_described" | "rejection_unjustified" | "item_not_received_by_seller" | "other"; note?: string }): Promise<{ disputeId: string; slaDueAt: string }> {
    const env = this.env;
    const now = env.now();
    return this.user(userId, async (tx) => {
      const r = await lockReturn(tx, returnId);
      await setReturnStatus(tx, r.id, r.status, "dispute", now);
      const id = env.newId();
      const sla = addBusinessDays(now, env.config.disputeBusinessDays);
      await tx.query(
        `INSERT INTO disputes (id, return_request_id, user_id, store_id, market_id, status, reason_code, shopper_note, sla_due_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,'OPEN',$6,$7,$8,$9,$9)`,
        [id, r.id, userId, r.store_id, env.marketId, input.reasonCode, input.note ?? null, sla.toISOString(), now.toISOString()],
      );
      await emit(env, tx, "dispute.opened", "dispute", id, { dispute_id: id, return_request_id: r.id, reason: input.reasonCode });
      return { disputeId: id, slaDueAt: sla.toISOString() };
    });
  }

  /** T&S queue, oldest SLA first, with reason codes. Admin only. */
  async disputeQueue(actor: Principal, limit = 50): Promise<readonly { id: string; returnRequestId: string; reasonCode: string; slaDueAt: string; status: string }[]> {
    this.assertAdmin(actor, "dispute.decide");
    return this.worker(null, async (tx) =>
      (await tx.query<{ id: string; return_request_id: string; reason_code: string; sla_due_at: string; status: string }>(
        `SELECT id, return_request_id, reason_code, sla_due_at, status FROM disputes WHERE market_id = $1 AND status IN ('OPEN','UNDER_REVIEW') ORDER BY sla_due_at, id LIMIT $2::int`, [this.env.marketId, limit],
      )).rows.map((r) => ({ id: r.id, returnRequestId: r.return_request_id, reasonCode: r.reason_code, slaDueAt: new Date(r.sla_due_at).toISOString(), status: r.status })),
    );
  }

  /** T&S decision. In the shopper's favour the return becomes ACCEPTED (refund follows); in the seller's favour it closes. */
  async resolveDispute(actor: Principal, disputeId: string, outcome: "shopper" | "seller", note: string): Promise<ReturnState> {
    this.assertAdmin(actor, "dispute.decide");
    const env = this.env;
    const now = env.now();
    const row = await this.worker(null, async (tx) => (await tx.query<{ user_id: string }>("SELECT user_id FROM disputes WHERE id = $1", [uuid.parse(disputeId)])).rows[0]);
    if (row === undefined) throw new ReturnsError("not_found");
    return this.worker(row.user_id, async (tx) => {
      const d = (await tx.query<{ id: string; status: string; return_request_id: string }>("SELECT id, status, return_request_id FROM disputes WHERE id = $1 FOR UPDATE", [disputeId])).rows[0];
      if (d === undefined) throw new ReturnsError("not_found");
      if (d.status !== "OPEN" && d.status !== "UNDER_REVIEW") throw new ReturnsError("invalid_state", `dispute is ${d.status}`);
      await tx.query(
        `UPDATE disputes SET status = $2, assigned_staff_id = $3, resolution_note = $4, resolved_at = $5::timestamptz, version = version + 1, updated_at = $5::timestamptz WHERE id = $1`,
        [d.id, outcome === "shopper" ? "RESOLVED_SHOPPER" : "RESOLVED_SELLER", actor.userId ?? null, note, now.toISOString()],
      );
      const r = await lockReturn(tx, d.return_request_id);
      const next = await setReturnStatus(tx, r.id, r.status, outcome === "shopper" ? "resolve_shopper" : "resolve_seller", now);
      if (outcome === "shopper") await emit(env, tx, "return.accepted", "return_request", r.id, { return_request_id: r.id, store_id: r.store_id, user_id: r.user_id, dispute_id: d.id });
      return next;
    });
  }

  private assert(actor: Principal, action: string, storeId: string): void {
    const d = authorize(actor, action, { type: "return", storeId, marketId: this.env.marketId });
    if (d.effect === "deny") throw new ReturnsError(d.reason === "not_found" ? "not_found" : "forbidden");
  }
  private assertAdmin(actor: Principal, action: string): void {
    const d = authorize(actor, action, { type: "dispute", marketId: this.env.marketId });
    if (d.effect === "deny") throw new ReturnsError(d.reason === "not_found" ? "not_found" : "forbidden");
  }
}

const lockReturnPlain = async (tx: Queryable, id: string): Promise<ReturnRow> => {
  const r = await tx.query<ReturnRow>(`SELECT id, status, seller_order_id, store_id, user_id, reason_code, resolution, window_ends_at, inspection_due_at, refund_due_at FROM return_requests WHERE id = $1`, [uuid.parse(id)]);
  const row = r.rows[0];
  if (row === undefined) throw new ReturnsError("not_found");
  return row;
};
