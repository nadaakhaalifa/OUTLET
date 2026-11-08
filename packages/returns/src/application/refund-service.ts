import { AdminAccessError } from "@outlet/admin-access";
import { withDbContext } from "@outlet/db";
import type { Queryable } from "@outlet/db";
import { Ledger, accountCode } from "@outlet/ledger";
import type { JournalEntryDraft, PostingDraft } from "@outlet/ledger";
import { money, percentOf } from "@outlet/money";
import type { Currency, Money } from "@outlet/money";
import { authorize, dualApprovalRequired } from "@outlet/policy";
import type { Principal } from "@outlet/policy";
import { z } from "zod";
import { computeRefund, tenderSplit } from "../domain/calc.js";
import { addDays } from "../domain/eligibility.js";
import { ReturnsError } from "../domain/errors.js";
import { transition } from "@outlet/orders";
import { REFUND, RETURN } from "../domain/machines.js";
import type { RefundEvent, RefundState } from "../domain/machines.js";
import { routeRefund, summaryRoute } from "../domain/router.js";
import type { CreditLeg, Destination, RouteKind, TenderMethod } from "../domain/router.js";
import { emit, makeEnv } from "./env.js";
import type { Env, ReturnsDeps } from "./env.js";
import { REFUNDS_KILL_SWITCH } from "./ports.js";
import { lockReturn, setReturnStatus } from "./return-service.js";

const uuid = z.uuid();

export interface RefundView {
  readonly id: string;
  readonly status: RefundState;
  readonly route: RouteKind | "mixed";
  readonly amount: Money;
  readonly replayed: boolean;
}

/** Dual approval outcome (payouts shape): below the threshold the actor decides alone; at or above it a second and third admin vote on a stored request. */
export type RefundApproveOutcome = { readonly status: "approved" } | { readonly status: "approval_required"; readonly requestId: string };
export type ManualResolveOutcome = { readonly status: "completed"; readonly refund: RefundView } | { readonly status: "approval_required"; readonly requestId: string };

interface RefundRow {
  id: string; status: RefundState; user_id: string; store_id: string; order_group_id: string; seller_order_id: string; return_request_id: string | null; currency: Currency;
  amount_minor: string; goods_minor: string; delivery_fee_minor: string; delivery_vat_minor: string; commission_minor: string; commission_vat_minor: string; seller_minor: string;
  seller_account: "seller_pending" | "seller_available"; destinations: DestinationJson[]; route: RouteKind | "mixed"; idempotency_key: string; journal_entry_id: string | null;
  attempts: number; next_attempt_at: string | null; approval_request_id: string | null; resolution_approval_request_id: string | null;
}
interface DestinationJson { route: RouteKind; amountMinor: string; accountCode: string }

const SELECT_REFUND = `SELECT id, status, user_id, store_id, order_group_id, seller_order_id, return_request_id, currency, amount_minor::text, goods_minor::text, delivery_fee_minor::text, delivery_vat_minor::text,
  commission_minor::text, commission_vat_minor::text, seller_minor::text, seller_account, destinations, route, idempotency_key, journal_entry_id, attempts, next_attempt_at, approval_request_id, resolution_approval_request_id FROM refunds`;

const toDestinations = (r: RefundRow): Destination[] => r.destinations.map((d) => ({ route: d.route, amount: money(BigInt(d.amountMinor), r.currency), accountCode: d.accountCode }));

/** The refund entry (ledger spec 4.5 / 4.6): debit the seller, commission, VAT and delivery revenue; credit the destinations. Zero postings are omitted; same accounts are merged. */
export function refundDraft(i: { marketId: string; refundId: string; storeId: string; occurredAt: Date; currency: Currency; sellerAccount: "seller_pending" | "seller_available"; seller: Money; commission: Money; commissionVat: Money; deliveryFee: Money; deliveryVat: Money; destinations: readonly Destination[]; keySuffix?: string }): JournalEntryDraft {
  const cur = i.currency;
  const acc = (type: "seller_pending" | "seller_available" | "commission_revenue" | "platform_vat_output" | "shipping_revenue", owner?: string): string => accountCode({ type, market: i.marketId, currency: cur, ...(owner === undefined ? {} : { owner }) });
  const merged = new Map<string, bigint>();
  const put = (code: string, amount: bigint): void => {
    if (amount !== 0n) merged.set(code, (merged.get(code) ?? 0n) + amount);
  };
  put(acc(i.sellerAccount, i.storeId), i.seller.amountMinor);
  put(acc("commission_revenue"), i.commission.amountMinor);
  put(acc("platform_vat_output"), i.commissionVat.amountMinor + i.deliveryVat.amountMinor);
  put(acc("shipping_revenue"), i.deliveryFee.amountMinor - i.deliveryVat.amountMinor);
  for (const d of i.destinations) put(d.accountCode, -d.amount.amountMinor);
  const postings: PostingDraft[] = [...merged].map(([accountCodeValue, amount]) => ({ accountCode: accountCodeValue, amount: money(amount, cur) }));
  return { kind: "refund_issued", idempotencyKey: `refund:${i.refundId}${i.keySuffix ?? ""}`, marketId: i.marketId, occurredAt: i.occurredAt, ref: { type: "refund", id: i.refundId }, postings };
}

/**
 * RefundService (master prompt 15.6): ledger first, then the provider. Runs only as the finance.refunds worker, narrowed to the shopper
 * of each refund. Provider calls are never inside a database transaction; every external call carries the refund's idempotency key.
 */
export class RefundService {
  private readonly env: Env;
  constructor(deps: ReturnsDeps) {
    this.env = makeEnv(deps);
  }

  private worker<T>(userId: string | null, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.env.worker, { kind: "worker", marketId: this.env.marketId, job: "finance.refunds", ...(userId === null ? {} : { userId }) }, fn);
  }

  /**
   * Consumer of return.accepted. Idempotent on `refund:return:{id}`. Returns null for an exchange (no money moves).
   * Amount rules: goods = paid price of the returned units (voucher share given back proportionally); delivery fee only when the seller
   * is at fault or the whole order comes back within 7 days; commission and VAT reversed by differencing (4.5).
   */
  async createForReturn(returnId: string): Promise<RefundView | null> {
    const env = this.env;
    const scan = await this.worker(null, async (tx) => (await tx.query<{ user_id: string }>("SELECT user_id FROM return_requests WHERE id = $1", [uuid.parse(returnId)])).rows[0]);
    if (scan === undefined) throw new ReturnsError("not_found");
    const now = env.now();
    return this.worker(scan.user_id, async (tx) => {
      const key = `refund:return:${returnId}`;
      const existing = (await tx.query<RefundRow>(`${SELECT_REFUND} WHERE idempotency_key = $1`, [key])).rows[0];
      if (existing !== undefined) return { id: existing.id, status: existing.status, route: existing.route, amount: money(BigInt(existing.amount_minor), existing.currency), replayed: true };
      const ret = await lockReturn(tx, returnId);
      if (ret.status !== "ACCEPTED") throw new ReturnsError("invalid_state", `return is ${ret.status}, not ACCEPTED`);
      const rr = (await tx.query<{ resolution: string; fault: string; refund_choice: "original" | "store_credit" | null; refund_due_at: string | null; delivered_at_snapshot: string }>(
        "SELECT resolution, fault, refund_choice, refund_due_at, delivered_at_snapshot FROM return_requests WHERE id = $1", [returnId],
      )).rows[0];
      if (rr === undefined) throw new ReturnsError("not_found");
      if (rr.resolution === "exchange") return null;

      const so = (await tx.query<{ id: string; store_id: string; order_group_id: string; currency: Currency; items: string; pd: string; sd: string; ship: string; ship_vat: string; total: string; bp: number; comm: string; comm_vat: string; closed_at: string | null; status: string }>(
        `SELECT id, store_id, order_group_id, currency, items_subtotal_minor::text AS items, platform_discount_minor::text AS pd, seller_discount_minor::text AS sd, shipping_minor::text AS ship,
                shipping_vat_minor::text AS ship_vat, total_minor::text AS total, commission_bp_snapshot AS bp, commission_minor::text AS comm, commission_vat_minor::text AS comm_vat, closed_at, status
           FROM seller_orders WHERE id = $1`, [ret.seller_order_id],
      )).rows[0];
      if (so === undefined) throw new ReturnsError("not_found");
      const cur = so.currency;
      const base = BigInt(so.items) - BigInt(so.pd) - BigInt(so.sd);
      const cOf = (x: bigint): bigint => percentOf(money(x, cur), BigInt(so.bp)).amountMinor;
      const vOf = (x: bigint): bigint => percentOf(money(x, cur), BigInt(env.config.commissionVatBp)).amountMinor;
      if (cOf(base) !== BigInt(so.comm) || vOf(BigInt(so.comm)) !== BigInt(so.comm_vat)) throw new ReturnsError("commission_base_mismatch");

      const lines = (await tx.query<{ id: string; unit: string; qty: number; disc: string; ret_qty: number }>(
        `SELECT l.id, l.unit_price_minor::text AS unit, l.qty, (l.platform_discount_minor + l.seller_discount_minor)::text AS disc, ri.qty AS ret_qty
           FROM return_items ri JOIN order_lines l ON l.id = ri.order_line_id WHERE ri.return_request_id = $1 ORDER BY l.id`, [returnId],
      )).rows;
      const prior = (await tx.query<{ goods: string; total: string; delivery: string }>(
        `SELECT COALESCE(SUM(goods_minor),0)::text AS goods, COALESCE(SUM(amount_minor),0)::text AS total, COALESCE(SUM(delivery_fee_minor),0)::text AS delivery FROM refunds WHERE seller_order_id = $1`, [so.id],
      )).rows[0];
      const priorQty = new Map((await tx.query<{ order_line_id: string; q: string }>(
        `SELECT a.order_line_id, SUM(a.qty)::text AS q FROM refund_allocations a JOIN refunds f ON f.id = a.refund_id WHERE f.seller_order_id = $1 AND a.order_line_id IS NOT NULL GROUP BY a.order_line_id`, [so.id],
      )).rows.map((r) => [r.order_line_id, Number(r.q)] as const));
      const allLines = (await tx.query<{ id: string; qty: number }>("SELECT id, qty FROM order_lines WHERE seller_order_id = $1", [so.id])).rows;

      const fullAfter = allLines.every((l) => (priorQty.get(l.id) ?? 0) + (lines.find((x) => x.id === l.id)?.ret_qty ?? 0) === l.qty);
      const within7d = now.getTime() <= addDays(new Date(rr.delivered_at_snapshot), 7).getTime();
      const feeAlready = BigInt(prior?.delivery ?? "0") > 0n;
      const giveFee = !feeAlready && BigInt(so.ship) > 0n && (rr.fault === "seller" || (fullAfter && within7d));

      const calc = computeRefund({
        currency: cur, base, goodsRefundedBefore: BigInt(prior?.goods ?? "0"), commissionBp: so.bp, commissionVatBp: env.config.commissionVatBp,
        lines: lines.map((l) => ({ orderLineId: l.id, unitPrice: BigInt(l.unit), qty: l.qty, qtyAlreadyReturned: priorQty.get(l.id) ?? 0, returnQty: l.ret_qty, discount: BigInt(l.disc) })),
        delivery: giveFee ? { gross: BigInt(so.ship), vat: BigInt(so.ship_vat) } : null,
      });
      if (calc.total.amountMinor < 0n) throw new ReturnsError("nothing_to_return");
      if (calc.total.amountMinor === 0n) {
        // Nothing is owed (fully discounted units): the return closes without a refund row, not as an error.
        await setReturnStatus(tx, ret.id, ret.status, "close", now);
        await emit(env, tx, "return.closed", "return_request", ret.id, { return_request_id: ret.id, store_id: ret.store_id, reason: "no_refund_due" });
        return null;
      }
      if (BigInt(prior?.total ?? "0") + calc.total.amountMinor > BigInt(so.total)) throw new ReturnsError("refund_exceeds_paid");

      const g = (await tx.query<{ method: TenderMethod; credit: string; total: string }>("SELECT payment_method AS method, store_credit_minor::text AS credit, total_minor::text AS total FROM order_groups WHERE id = $1", [so.order_group_id])).rows[0];
      const intent = (await tx.query<{ id: string; provider: string; bnpl: string | null }>("SELECT id, provider, bnpl_provider AS bnpl FROM payment_intents WHERE order_group_id = $1", [so.order_group_id])).rows[0];
      if (g === undefined) throw new ReturnsError("not_found");
      const groupPrior = (await tx.query<{ t: string }>("SELECT COALESCE(SUM(amount_minor),0)::text AS t FROM refunds WHERE order_group_id = $1", [so.order_group_id])).rows[0];
      const creditPaid = BigInt(g.credit);
      const split = tenderSplit(calc.total, BigInt(groupPrior?.t ?? "0"), creditPaid, BigInt(g.total) - creditPaid);
      const legs: CreditLeg[] = (await tx.query<{ code: string; amount: string }>(
        `SELECT a.code, h.amount_minor::text AS amount FROM ledger_holds h JOIN ledger_accounts a ON a.id = h.account_id WHERE h.ref_type = 'order_group' AND h.ref_id = $1 AND h.status = 'CAPTURED' ORDER BY a.code`, [so.order_group_id],
      )).rows.map((r) => ({ accountCode: r.code, amount: money(BigInt(r.amount), cur) }));
      const owner = g.method === "bnpl" ? (intent?.bnpl ?? null) : g.method === "cod" || g.method === "store_credit" ? null : intent === undefined ? null : intent.provider === "paymob" || intent.provider === "fake" ? "paymob" : intent.provider;
      const destinations = routeRefund({
        marketId: env.marketId, userId: ret.user_id, method: g.method, clearingOwner: owner, pspReversible: env.provider.canReverse(g.method),
        refund: calc.total, credit: split.credit, external: split.external, creditLegs: legs, choice: rr.refund_choice,
      });

      const id = env.newId();
      // Provisional only: the account is decided under a seller_orders row lock inside process(), when the entry is actually posted (A2).
      const sellerAccount = "seller_pending";
      const needsApproval = dualApprovalRequired("refund.approve", env.config.dualApproval, calc.total.amountMinor);
      await tx.query(
        `INSERT INTO refunds (id, order_group_id, seller_order_id, return_request_id, user_id, store_id, market_id, reason, route, shopper_choice, currency, amount_minor, goods_minor, delivery_fee_minor,
                              delivery_vat_minor, commission_minor, commission_vat_minor, seller_minor, seller_account, destinations, status, idempotency_key, due_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'return',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,'REQUESTED',$20,$21,$22,$22)`,
        [id, so.order_group_id, so.id, returnId, ret.user_id, so.store_id, env.marketId, summaryRoute(destinations), rr.refund_choice, cur, calc.total.amountMinor.toString(), calc.goods.amountMinor.toString(),
         calc.deliveryFee.amountMinor.toString(), calc.deliveryVat.amountMinor.toString(), calc.commission.amountMinor.toString(), calc.commissionVat.amountMinor.toString(), calc.seller.amountMinor.toString(),
         sellerAccount, JSON.stringify(destinations.map((d) => ({ route: d.route, amountMinor: d.amount.amountMinor.toString(), accountCode: d.accountCode }))), key, rr.refund_due_at, now.toISOString()],
      );
      let n = 0;
      for (const l of calc.lines) {
        n += 1;
        await tx.query(
          `INSERT INTO refund_allocations (refund_id, line_no, order_line_id, user_id, store_id, market_id, component, qty, gross_minor, discount_share_minor, amount_minor, commission_minor, commission_vat_minor, currency)
           VALUES ($1,$2,$3,$4,$5,$6,'goods',$7,$8,$9,$10,$11,$12,$13)`,
          [id, n, l.orderLineId, ret.user_id, so.store_id, env.marketId, l.qty, l.gross.toString(), l.discountShare.toString(), l.amount.toString(), l.commission.toString(), l.commissionVat.toString(), cur],
        );
      }
      if (calc.deliveryFee.amountMinor > 0n) {
        n += 1;
        await tx.query(
          `INSERT INTO refund_allocations (refund_id, line_no, order_line_id, user_id, store_id, market_id, component, qty, gross_minor, discount_share_minor, amount_minor, currency) VALUES ($1,$2,NULL,$3,$4,$5,'delivery_fee',0,$6,0,$6,$7)`,
          [id, n, ret.user_id, so.store_id, env.marketId, calc.deliveryFee.amountMinor.toString(), cur],
        );
      }
      if (!needsApproval) await this.setStatus(tx, id, "REQUESTED", "approve", now);
      await emit(env, tx, needsApproval ? "refund.approval_required" : "refund.approved", "refund", id, { refund_id: id, return_request_id: returnId, amount_minor: calc.total.amountMinor.toString(), currency: cur });
      return { id, status: needsApproval ? "REQUESTED" : "APPROVED", route: summaryRoute(destinations), amount: calc.total, replayed: false };
    });
  }

  private deny(actor: Principal): void {
    const d = authorize(actor, "refund.approve", { type: "refund", marketId: this.env.marketId });
    if (d.effect === "deny") throw new ReturnsError(d.reason === "not_found" ? "not_found" : "forbidden");
  }

  private async scanUser(table: "refunds", id: string): Promise<string> {
    const scan = await this.worker(null, async (tx) => (await tx.query<{ user_id: string }>(`SELECT user_id FROM ${table} WHERE id = $1`, [uuid.parse(id)])).rows[0]);
    if (scan === undefined) throw new ReturnsError("not_found");
    return scan.user_id;
  }

  /** Consumes an APPROVED request exactly once and checks it belongs to this refund and action (never trust the request id alone). */
  private async consumeApproval(actor: Principal, requestId: string, expect: { targetType: string; refundId: string; bankRef?: string }): Promise<boolean> {
    try {
      const res = await this.env.admin.executeApproval(actor, requestId, (req) => {
        const bankOk = expect.bankRef === undefined || Reflect.get(req.payload, "bankRef") === expect.bankRef;
        if (req.action !== "refund.approve" || req.targetType !== expect.targetType || req.targetId !== expect.refundId || !bankOk) {
          return Promise.reject(new ReturnsError("approval_required", "approval request does not belong to this refund"));
        }
        return Promise.resolve(req.id);
      });
      return res.executed;
    } catch (e) {
      if (e instanceof AdminAccessError) {
        if (e.code === "APPROVAL_NOT_APPROVED" || e.code === "APPROVAL_EXPIRED") throw new ReturnsError("approval_required", e.code);
        if (e.code === "FORBIDDEN") throw new ReturnsError("forbidden");
        if (e.code === "NOT_FOUND") throw new ReturnsError("not_found");
      }
      throw e;
    }
  }

  /**
   * Refund approval (policy refund.approve), dual above the threshold exactly like payouts: the first call files an admin-access request
   * (stored on the refund) and returns approval_required; two other admins vote; a later call consumes the APPROVED request once
   * (executeApproval) and moves the refund to APPROVED. Pass renew = true to file a new request after a rejection or expiry.
   */
  async approve(actor: Principal, refundId: string, opts: { readonly renew?: boolean } = {}): Promise<RefundApproveOutcome> {
    this.deny(actor);
    const userId = await this.scanUser("refunds", refundId);
    const r0 = await this.worker(userId, (tx) => this.lock(tx, refundId));
    if (r0.status !== "REQUESTED") throw new ReturnsError("invalid_state", `refund is ${r0.status}`);
    const amount = BigInt(r0.amount_minor);
    const needs = dualApprovalRequired("refund.approve", this.env.config.dualApproval, amount, actor);
    const approveNow = async (): Promise<RefundApproveOutcome> => {
      await this.worker(userId, async (tx) => {
        const r = await this.lock(tx, refundId);
        if (r.status === "APPROVED") return;
        await this.setStatus(tx, r.id, r.status, "approve", this.env.now());
      });
      return { status: "approved" };
    };
    if (r0.approval_request_id !== null && opts.renew !== true) {
      if (!(await this.consumeApproval(actor, r0.approval_request_id, { targetType: "refund", refundId }))) {
        throw new ReturnsError("invalid_state", "approval request was already consumed; renew it");
      }
      return approveNow();
    }
    const req = await this.env.admin.requireApproval(actor, { action: "refund.approve", targetType: "refund", targetId: refundId, payload: { refundId, currency: r0.currency }, amountMinor: amount });
    if (!req.required) {
      if (needs) throw new ReturnsError("approval_required", "approval thresholds disagree; fail closed");
      return approveNow();
    }
    await this.worker(userId, async (tx) => {
      const r = await this.lock(tx, refundId);
      if (r.status !== "REQUESTED") throw new ReturnsError("invalid_state", `refund is ${r.status}`);
      await tx.query("UPDATE refunds SET approval_request_id = $2, version = version + 1, updated_at = $3::timestamptz WHERE id = $1", [r.id, req.request.id, this.env.now().toISOString()]);
    });
    return { status: "approval_required", requestId: req.request.id };
  }

  /**
   * Ledger first (one entry, idempotent), then the provider leg(s). Replays are safe: a COMPLETED refund returns as is, a posted entry is
   * not posted again, and the provider key is stable. Store-credit legs complete with the ledger entry; bank-transfer and Fawry-voucher
   * legs are owed (shopper_refunds_payable) and go to MANUAL_REVIEW for finance to pay out.
   */
  async process(refundId: string): Promise<RefundView> {
    const env = this.env;
    if (await env.kill.isEngaged(REFUNDS_KILL_SWITCH)) throw new ReturnsError("refunds_disabled");
    const scan = await this.worker(null, async (tx) => (await tx.query<{ user_id: string }>("SELECT user_id FROM refunds WHERE id = $1", [uuid.parse(refundId)])).rows[0]);
    if (scan === undefined) throw new ReturnsError("not_found");
    const now = env.now();

    const started = await this.worker(scan.user_id, async (tx) => {
      const r = await this.lock(tx, refundId);
      if (r.status === "COMPLETED") return { done: r };
      if (r.status === "REQUESTED") throw new ReturnsError("approval_required");
      if (r.status === "MANUAL_REVIEW") return { done: r };
      if (r.status === "FAILED" && r.next_attempt_at !== null && new Date(r.next_attempt_at).getTime() > now.getTime()) return { done: r };
      const dests = toDestinations(r);
      const cur = r.currency;
      let sellerAccount = r.seller_account;
      if (r.journal_entry_id === null) {
        // A2: decide the debited seller account now, under the seller_orders row lock, from the ledger fact that the line closed
        // (the availability mover's line_closed entry). Deciding at creation could debit seller_pending below zero after a close.
        await tx.query("SELECT id FROM seller_orders WHERE id = $1 FOR UPDATE", [r.seller_order_id]);
        const closed = (await tx.query("SELECT 1 FROM journal_entries WHERE idempotency_key = $1", [`line_closed:${r.seller_order_id}`])).rows.length > 0;
        sellerAccount = closed ? "seller_available" : "seller_pending";
        await tx.query("UPDATE refunds SET seller_account = $2 WHERE id = $1", [r.id, sellerAccount]);
      }
      const posted = await Ledger.post(tx, refundDraft({
        marketId: env.marketId, refundId: r.id, storeId: r.store_id, occurredAt: now, currency: cur, sellerAccount, seller: money(BigInt(r.seller_minor), cur),
        commission: money(BigInt(r.commission_minor), cur), commissionVat: money(BigInt(r.commission_vat_minor), cur), deliveryFee: money(BigInt(r.delivery_fee_minor), cur),
        deliveryVat: money(BigInt(r.delivery_vat_minor), cur), destinations: dests,
      }));
      const event: RefundEvent = r.status === "APPROVED" ? "start" : "retry";
      if (r.status !== "PROCESSING") await this.setStatus(tx, r.id, r.status, event, now);
      await tx.query("UPDATE refunds SET journal_entry_id = $2, attempts = attempts + 1, initiated_at = COALESCE(initiated_at, $3::timestamptz) WHERE id = $1", [r.id, posted.entryId, now.toISOString()]);
      if (sellerAccount === "seller_available") {
        await emit(env, tx, "refund.after_payout", "refund", r.id, { refund_id: r.id, store_id: r.store_id, seller_order_id: r.seller_order_id, seller_minor: r.seller_minor, currency: cur, journal_entry_id: posted.entryId });
      }
      const intent = (await tx.query<{ id: string }>("SELECT id FROM payment_intents WHERE order_group_id = $1", [r.order_group_id])).rows[0];
      return { r, dests, attempts: r.attempts + 1, intentId: intent?.id ?? null };
    });
    if ("done" in started) return this.viewOf(started.done);

    const { r, dests, attempts, intentId } = started;
    let providerRef: string | null = null;
    let failure: { retryable: boolean; code: string } | null = null;
    const manual = dests.some((d) => d.route === "bank_transfer" || d.route === "fawry_voucher");
    let n = 0;
    for (const d of dests) {
      if (d.route !== "psp_original" && d.route !== "bnpl_provider") continue;
      n += 1;
      if (intentId === null) {
        failure = { retryable: false, code: "no_payment_intent" };
        break;
      }
      const res = await env.provider.refund({ refundId: r.id, orderGroupId: r.order_group_id, paymentIntentId: intentId, route: d.route, amount: d.amount, idempotencyKey: `${r.idempotency_key}:${String(n)}` });
      if (res.outcome === "accepted") providerRef = res.providerRef;
      else {
        failure = { retryable: res.outcome === "retryable", code: res.code };
        break;
      }
    }

    return this.worker(scan.user_id, async (tx) => {
      const cur = await this.lock(tx, refundId);
      let event: RefundEvent;
      if (failure === null && !manual) event = "complete";
      else if (failure === null) event = "escalate";
      else if (failure.retryable && attempts < env.config.maxRefundAttempts) event = "fail";
      else event = "escalate";
      const next = await this.setStatus(tx, cur.id, cur.status, event, now);
      if (failure !== null && event === "escalate" && cur.journal_entry_id !== null) {
        // A3: a final provider rejection must not leave the refund booked. The entry is reversed (trial balance stays 0) and the refund waits in
        // MANUAL_REVIEW; finance pays it out of band and resolveManually re-books it with the real bank reference.
        await Ledger.reverse(tx, cur.journal_entry_id, { idempotencyKey: `refund_reversal:${cur.id}`, reason: `provider rejected refund: ${failure.code}`, occurredAt: now });
      }
      const err = failure?.code ?? (manual ? "manual_payout_required" : null);
      const retryAt = event === "fail" ? new Date(now.getTime() + env.config.retryBackoffSec * 1000 * 2 ** (attempts - 1)) : null;
      await tx.query(
        `UPDATE refunds SET provider_ref = COALESCE($2, provider_ref), last_error = $3, next_attempt_at = $4::timestamptz, completed_at = CASE WHEN $5 THEN $6::timestamptz ELSE completed_at END WHERE id = $1`,
        [cur.id, providerRef, err, retryAt?.toISOString() ?? null, next === "COMPLETED", now.toISOString()],
      );
      if (next === "COMPLETED") await this.onCompleted(tx, cur, now);
      else await emit(env, tx, "refund.attention", "refund", cur.id, { refund_id: cur.id, status: next, error: err });
      return this.viewOf({ ...cur, status: next });
    });
  }

  /**
   * Finance confirms a refund was paid out of band (MANUAL_REVIEW -> COMPLETED) with the bank reference. Dual approval above the threshold,
   * same shape as approve (a separate request bound to the bankRef). Ledger: Dr shopper_refunds_payable / Cr bank_collections for the
   * owed legs. When the provider finally rejected the refund (entry reversed) the refund is first re-booked, provider legs routed to the payable.
   */
  async resolveManually(actor: Principal, refundId: string, bankRef: string, opts: { readonly renew?: boolean } = {}): Promise<ManualResolveOutcome> {
    this.deny(actor);
    const ref = z.string().trim().min(1).max(100).parse(bankRef);
    const env = this.env;
    const userId = await this.scanUser("refunds", refundId);
    const now = env.now();
    const r0 = await this.worker(userId, (tx) => this.lock(tx, refundId));
    if (r0.status !== "MANUAL_REVIEW") throw new ReturnsError("invalid_state", `refund is ${r0.status}, not MANUAL_REVIEW`);
    const amount = BigInt(r0.amount_minor);
    const needs = dualApprovalRequired("refund.approve", env.config.dualApproval, amount, actor);
    if (r0.resolution_approval_request_id !== null && opts.renew !== true) {
      if (!(await this.consumeApproval(actor, r0.resolution_approval_request_id, { targetType: "refund_manual", refundId, bankRef: ref }))) {
        throw new ReturnsError("invalid_state", "approval request was already consumed; renew it");
      }
    } else {
      const req = await env.admin.requireApproval(actor, { action: "refund.approve", targetType: "refund_manual", targetId: refundId, payload: { refundId, bankRef: ref, currency: r0.currency }, amountMinor: amount });
      if (req.required) {
        await this.worker(userId, async (tx) => {
          const r = await this.lock(tx, refundId);
          if (r.status !== "MANUAL_REVIEW") throw new ReturnsError("invalid_state", `refund is ${r.status}`);
          await tx.query("UPDATE refunds SET resolution_approval_request_id = $2, version = version + 1, updated_at = $3::timestamptz WHERE id = $1", [r.id, req.request.id, now.toISOString()]);
        });
        return { status: "approval_required", requestId: req.request.id };
      }
      if (needs) throw new ReturnsError("approval_required", "approval thresholds disagree; fail closed");
    }
    const refund = await this.worker(userId, async (tx) => {
      const r = await this.lock(tx, refundId);
      if (r.status !== "MANUAL_REVIEW") throw new ReturnsError("invalid_state", `refund is ${r.status}, not MANUAL_REVIEW`);
      const cur = r.currency;
      const payable = accountCode({ type: "shopper_refunds_payable", market: env.marketId, currency: cur });
      const bank = accountCode({ type: "bank_collections", market: env.marketId, currency: cur, owner: "main" });
      let dests = toDestinations(r);
      const reversed = r.journal_entry_id !== null && (await tx.query("SELECT 1 FROM journal_entries WHERE reverses_entry_id = $1", [r.journal_entry_id])).rows.length > 0;
      if (reversed || r.journal_entry_id === null) {
        // Provider legs (card / wallet) are now paid by bank transfer; BNPL legs keep their provider clearing account (provider cancels the loan).
        dests = dests.map((d) => (d.route === "psp_original" ? { ...d, route: "bank_transfer" as const, accountCode: payable } : d));
        const posted = await Ledger.post(tx, refundDraft({
          marketId: env.marketId, refundId: r.id, storeId: r.store_id, occurredAt: now, currency: cur, sellerAccount: r.seller_account, seller: money(BigInt(r.seller_minor), cur),
          commission: money(BigInt(r.commission_minor), cur), commissionVat: money(BigInt(r.commission_vat_minor), cur), deliveryFee: money(BigInt(r.delivery_fee_minor), cur),
          deliveryVat: money(BigInt(r.delivery_vat_minor), cur), destinations: dests, keySuffix: ":manual",
        }));
        await tx.query("UPDATE refunds SET journal_entry_id = $2 WHERE id = $1", [r.id, posted.entryId]);
      }
      const owed = dests.filter((d) => d.accountCode === payable).reduce((a, d) => a + d.amount.amountMinor, 0n);
      if (owed > 0n) {
        await Ledger.post(tx, {
          kind: "refund_issued", idempotencyKey: `refund_paid:${r.id}`, marketId: env.marketId, occurredAt: now, ref: { type: "refund", id: r.id },
          postings: [{ accountCode: payable, amount: money(owed, cur) }, { accountCode: bank, amount: money(-owed, cur) }],
        });
      }
      const next = await this.setStatus(tx, r.id, r.status, "resolve_manually", now);
      await tx.query("UPDATE refunds SET completed_at = $2::timestamptz, manual_ref = $3, last_error = NULL WHERE id = $1", [r.id, now.toISOString(), ref]);
      await this.onCompleted(tx, r, now);
      return this.viewOf({ ...r, status: next });
    });
    return { status: "completed", refund };
  }

  /** Worker job: retry every FAILED refund whose backoff elapsed. */
  async retryDue(limit = 50): Promise<readonly string[]> {
    const now = this.env.now();
    const due = await this.worker(null, async (tx) =>
      (await tx.query<{ id: string }>(`SELECT id FROM refunds WHERE market_id = $1 AND status = 'FAILED' AND next_attempt_at <= $2::timestamptz ORDER BY next_attempt_at, id LIMIT $3::int`, [this.env.marketId, now.toISOString(), limit])).rows,
    );
    const out: string[] = [];
    for (const d of due) {
      await this.process(d.id);
      out.push(d.id);
    }
    return out;
  }

  private async onCompleted(tx: Queryable, r: RefundRow, now: Date): Promise<void> {
    if (r.return_request_id !== null) {
      const ret = await lockReturn(tx, r.return_request_id);
      if (ret.status === "ACCEPTED") {
        const next = transition(RETURN, ret.status, "refund_completed");
        await tx.query("UPDATE return_requests SET status = $2, version = version + 1, updated_at = $3::timestamptz WHERE id = $1", [ret.id, next, now.toISOString()]);
      }
      await tx.query(
        `UPDATE order_lines SET status = 'refunded' WHERE id IN (SELECT a.order_line_id FROM refund_allocations a WHERE a.refund_id = $1 AND a.order_line_id IS NOT NULL)
            AND qty <= (SELECT COALESCE(SUM(a2.qty),0) FROM refund_allocations a2 JOIN refunds f2 ON f2.id = a2.refund_id WHERE a2.order_line_id = order_lines.id)`,
        [r.id],
      );
    }
    await emit(this.env, tx, "refund.completed", "refund", r.id, { refund_id: r.id, amount_minor: r.amount_minor, currency: r.currency, route: r.route });
  }

  private async setStatus(tx: Queryable, id: string, from: RefundState, event: RefundEvent, now: Date): Promise<RefundState> {
    let next: RefundState;
    try {
      next = transition(REFUND, from, event);
    } catch {
      throw new ReturnsError("invalid_state", `refund: cannot ${event} from ${from}`);
    }
    await tx.query("UPDATE refunds SET status = $2, version = version + 1, updated_at = $3::timestamptz WHERE id = $1", [id, next, now.toISOString()]);
    return next;
  }

  private async lock(tx: Queryable, id: string): Promise<RefundRow> {
    const r = (await tx.query<RefundRow>(`${SELECT_REFUND} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (r === undefined) throw new ReturnsError("not_found");
    return r;
  }

  private viewOf(r: RefundRow): RefundView {
    return { id: r.id, status: r.status, route: r.route, amount: money(BigInt(r.amount_minor), r.currency), replayed: false };
  }
}

