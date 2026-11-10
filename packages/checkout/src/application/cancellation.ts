import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import type { ReservationService } from "@outlet/inventory";
import { CANCELLABLE_SHIPMENT_STATUSES, SHIPMENT_CANCEL_REQUIRED_EVENT } from "@outlet/shipping";
import { SELLER_ORDER, transition } from "@outlet/orders";
import type { OrderGroupState, SellerOrderState } from "@outlet/orders";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import { z } from "zod";
import { CheckoutError } from "../domain/errors.js";
import type { PaymentProviderPort, StoreCreditPort } from "../ports.js";
import type { Env } from "./env.js";
import { lockGroup, lockIntentOfGroup, moveGroup, moveIntent, setSessionStatus } from "./order-ops.js";
import type { GroupRow } from "./order-ops.js";
import { PROMOTIONS_SETTLE_ATTENTION } from "./promotions-settle-consumer.js";
import { INVENTORY_RELEASE_REQUIRED_EVENT } from "./seller-order-events.js";

export const ORDER_GROUP_CANCELLED_EVENT = "order_group.cancelled";
export const SELLER_ORDER_CANCELLED_EVENT = "seller_order.cancelled";
/** A voucher release / reinstate failed after the cancel committed: finance and ops resolve it (the caps stay counted meanwhile). */
export const PROMOTIONS_SETTLE_ATTENTION_EVENT = PROMOTIONS_SETTLE_ATTENTION;

/** Shopper reasons (API CancelInput) and seller reasons. Stored as text, never shown raw (Arabic copy is mapped in the clients). */
export const SHOPPER_CANCEL_REASONS = ["changed_mind", "ordered_by_mistake", "delivery_too_slow", "other"] as const;
export const SELLER_CANCEL_REASONS = ["out_of_stock", "cannot_fulfil", "pricing_error", "other"] as const;
export type ShopperCancelReason = (typeof SHOPPER_CANCEL_REASONS)[number];
export type SellerCancelReason = (typeof SELLER_CANCEL_REASONS)[number];
export type RefundPreference = "original" | "store_credit";
export type CancelInitiator = "shopper" | "seller";

/** Seller-order states a cancel may still leave (before SHIPPED, master prompt 20.1). The machine is the authority; this set only orders errors. */
const CANCELLABLE: ReadonlySet<SellerOrderState> = new Set<SellerOrderState>(["PAID", "CONFIRMED_COD", "ACCEPTED", "PACKED"]);
/** Settled before shipping: they never block a group cancel and are never cancelled again. */
const DEAD: ReadonlySet<SellerOrderState> = new Set<SellerOrderState>(["CANCELLED", "REJECTED_BY_SELLER", "VOIDED"]);
const UNPAID: ReadonlySet<OrderGroupState> = new Set<OrderGroupState>(["PENDING_PAYMENT", "AWAITING_COD_CONFIRMATION"]);
const PAID_GROUP: ReadonlySet<OrderGroupState> = new Set<OrderGroupState>(["PAID", "CONFIRMED_COD", "PARTIALLY_FULFILLED"]);
const PENDING_INTENT = new Set(["CREATED", "REQUIRES_ACTION", "AUTHORIZED"]);
const EXTERNAL = new Set(["card", "apple_pay", "meeza", "wallet", "instapay", "fawry", "bnpl"]);

export interface CancellationAuditEntry {
  readonly marketId: string;
  /** "user" for the shopper, "store_member" for a seller-initiated cancel (actorId is then the store member, never the shopper). */
  readonly actorType: "user" | "store_member";
  readonly actorId: string;
  readonly action: "order.cancel";
  readonly targetType: "order_group";
  readonly targetId: string;
  readonly diff: { readonly before: Readonly<Record<string, unknown>>; readonly after: Readonly<Record<string, unknown>> };
}

/**
 * Audit sink (append-only hash-chained log, master prompt A2.9). Appends INSIDE the cancel transaction, so the record commits (or rolls back)
 * with the state change. Production: @outlet/audit-log PgAuditStore.appendIn behind the composition root.
 */
export interface CancellationAuditPort {
  appendIn(tx: Queryable, e: CancellationAuditEntry): Promise<void>;
}

/** Error-level log sink (structurally @outlet/logger Logger). */
export interface CancellationLog { error(msg: string, fields?: Record<string, unknown>): void }

const stderrLog: CancellationLog = {
  error: (msg, fields) => { process.stderr.write(`${JSON.stringify({ level: "error", msg, ...fields })}\n`); },
};

/** Structurally @outlet/promotions VoucherService (release before payment; reinstate only for a whole group cancelled before shipping). */
export interface VoucherSettlementPort {
  release(userId: string, orderGroupId: string): Promise<number>;
  reinstate(userId: string, orderGroupId: string): Promise<number>;
}

export interface OrderCancellationDeps {
  /** outlet_app (ADR-0011): the request path. No money moves here; refunds are created by the finance.refunds worker from the outbox. */
  readonly client: RoleSqlClient<"outlet_app">;
  readonly marketId: string;
  readonly reservations: Pick<ReservationService, "releaseIn">;
  readonly provider: Pick<PaymentProviderPort, "voidIntent">;
  readonly credit: Pick<StoreCreditPort, "release">;
  readonly audit: CancellationAuditPort;
  /** Absent = promotions not wired (no voucher was reserved). */
  readonly vouchers?: VoucherSettlementPort;
  readonly outbox?: OutboxWriter;
  /** Defaults to a JSON line on stderr. */
  readonly log?: CancellationLog;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

const uuid = z.uuid();
const shopperInput = z.strictObject({
  userId: uuid,
  orderGroupId: uuid,
  reasonCode: z.enum(SHOPPER_CANCEL_REASONS),
  refundPreference: z.enum(["original", "store_credit"]).optional(),
  /** Partial cancel: only these seller orders (unshipped stores). Absent = every live seller order of the group. */
  sellerOrderIds: z.array(uuid).min(1).max(50).optional(),
});

/** Same shape as apps/api OrderCancellationPort input, plus the optional partial-cancel list. */
export interface CancelRequest {
  readonly userId: string;
  readonly orderGroupId: string;
  readonly reasonCode: string;
  readonly refundPreference?: RefundPreference | undefined;
  readonly sellerOrderIds?: readonly string[] | undefined;
}

export interface CancellationResult {
  readonly orderGroupId: string;
  readonly groupStatus: OrderGroupState;
  readonly scope: "full" | "partial";
  /** Seller orders this call moved (empty on a replay). */
  readonly cancelledSellerOrderIds: readonly string[];
  /** Money was charged and a refund will be created by the worker (false: unpaid, COD before delivery). */
  readonly refundExpected: boolean;
  readonly vouchers: "none" | "released" | "reinstated" | "failed";
  readonly replayed: boolean;
}

interface SoRow { readonly id: string; readonly store_id: string; readonly status: SellerOrderState; readonly cancel_reason: string | null }

interface Plan {
  readonly result: Omit<CancellationResult, "vouchers">;
  readonly voucherAction: "release" | "reinstate" | null;
  readonly before: OrderGroupState;
}

/**
 * OrderCancellation (master prompt 20.1, 15.6, B5): free cancellation before SHIPPED, by the shopper (whole group or chosen stores) or by
 * the seller (one seller order). One transaction per call, as the shopper's user context:
 *  - unpaid group (PENDING_PAYMENT / AWAITING_COD_CONFIRMATION): whole group only; the PSP intent is voided FIRST, outside the transaction
 *    (`already_captured` = 409 payment-in-flight, the webhook settles); intent, group and seller orders move by the machines; credit holds
 *    and the reservation are released; vouchers released after commit. Nothing was charged: no refund.
 *  - paid group (PAID / CONFIRMED_COD / PARTIALLY_FULFILLED): each target seller order PAID|CONFIRMED_COD|ACCEPTED|PACKED -> CANCELLED with
 *    reason, time and the shopper's refund choice; lines cancelled; per store `inventory.release_required` (claimed units) and
 *    `seller_order.cancelled` (payouts, notifications, CancellationRefundConsumer -> RefundService.createForCancellation). The group moves
 *    to CANCELLED when no live seller order remains; then vouchers are reinstated (refund-then-reuse rule).
 *  - any target at or after SHIPPED: 409 cancel-after-shipping (it is a refusal or a return).
 * Idempotent by (order group, reason): a repeat with the same reason replays; a different reason on an already cancelled target is 409.
 * Every group change emits `order_group.cancelled {user_id, ...}` (notifications). The audit record is appended in the same transaction
 * (replays included). A failed voucher settlement after commit is logged at error level and parked as `promotions.settle_attention`.
 */
export class OrderCancellation {
  private readonly outbox: OutboxWriter;
  private readonly now: () => Date;
  private readonly newId: () => string;
  constructor(private readonly d: OrderCancellationDeps) {
    this.outbox = d.outbox ?? new OutboxWriter(pgTransactionalWriter);
    this.now = d.now ?? (() => new Date());
    this.newId = d.newId ?? (() => uuidv7());
  }

  /** apps/api OrderCancellationPort. */
  async cancel(input: CancelRequest): Promise<void> {
    await this.execute(input);
  }

  async execute(input: CancelRequest): Promise<CancellationResult> {
    const p = shopperInput.parse(stripUndefined(input));
    return this.run({ userId: p.userId, groupId: p.orderGroupId, targets: p.sellerOrderIds ?? null, reason: p.reasonCode, preference: p.refundPreference ?? null, initiator: "shopper", actorId: p.userId });
  }

  /**
   * Seller-initiated cancel of one seller order before shipping. The seller order is read under the store context (another store's id is
   * not_found); the owner's user id then comes from that row, never from the request. A seller cannot cancel an unpaid group.
   */
  async cancelBySeller(input: { readonly storeId: string; readonly actorId: string; readonly sellerOrderId: string; readonly reasonCode: string }): Promise<CancellationResult> {
    const p = z.strictObject({ storeId: uuid, actorId: z.string().min(1).max(100), sellerOrderId: uuid, reasonCode: z.enum(SELLER_CANCEL_REASONS) }).parse(input);
    const so = await withDbContext(this.d.client, { kind: "store", marketId: this.d.marketId, storeId: p.storeId }, async (tx) =>
      (await tx.query<{ user_id: string; order_group_id: string }>("SELECT user_id, order_group_id FROM seller_orders WHERE id = $1", [p.sellerOrderId])).rows[0],
    );
    if (so === undefined) throw new CheckoutError("not-found", "seller order not found");
    return this.run({ userId: so.user_id, groupId: so.order_group_id, targets: [p.sellerOrderId], reason: p.reasonCode, preference: null, initiator: "seller", actorId: p.actorId });
  }

  private inUserTx<T>(userId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.d.client, { kind: "user", marketId: this.d.marketId, userId }, fn);
  }

  private async run(r: { userId: string; groupId: string; targets: readonly string[] | null; reason: string; preference: RefundPreference | null; initiator: CancelInitiator; actorId: string }): Promise<CancellationResult> {
    // 1. An unpaid external payment is voided at the PSP before anything changes (never inside a transaction). A capture wins: 409.
    const pre = await this.inUserTx(r.userId, async (tx) => {
      const g = (await tx.query<{ status: OrderGroupState }>("SELECT status FROM order_groups WHERE id = $1", [r.groupId])).rows[0];
      if (g === undefined) throw new CheckoutError("not-found", "order group not found");
      const i = (await tx.query<{ id: string; provider_ref: string | null; method: string; status: string }>("SELECT id, provider_ref, method, status FROM payment_intents WHERE order_group_id = $1", [r.groupId])).rows[0];
      return { status: g.status, intent: i ?? null };
    });
    if (pre.status === "PENDING_PAYMENT" && r.initiator === "shopper" && pre.intent !== null && EXTERNAL.has(pre.intent.method) && PENDING_INTENT.has(pre.intent.status)) {
      const v = await this.d.provider.voidIntent({ paymentIntentId: pre.intent.id, providerRef: pre.intent.provider_ref }, `cancel:${r.groupId}`);
      if (v.outcome === "already_captured") throw new CheckoutError("payment-in-flight", "the payment was captured; the order will be confirmed, then it can be cancelled");
      // H1: the PSP does not know an intent we saw it act on: its state is unknown, so fail closed (a CREATED intent never reached the PSP)
      if (v.outcome === "not_found" && (pre.intent.status === "REQUIRES_ACTION" || pre.intent.status === "AUTHORIZED")) {
        throw new CheckoutError("payment-in-flight", "the payment provider could not confirm the payment was voided; try again shortly");
      }
    }

    // 2. One transaction for every state change, event and the audit record (M5: the audit row commits with the change).
    const plan = await this.inUserTx(r.userId, async (tx) => {
      const p = await this.apply(tx, r);
      await this.d.audit.appendIn(tx, {
        marketId: this.d.marketId, actorType: r.initiator === "shopper" ? "user" : "store_member", actorId: r.actorId, action: "order.cancel", targetType: "order_group", targetId: r.groupId,
        diff: {
          before: { status: p.before },
          after: { status: p.result.groupStatus, scope: p.result.scope, reason_code: r.reason, seller_order_ids: p.result.cancelledSellerOrderIds, refund_preference: r.preference, replayed: p.result.replayed },
        },
      });
      return p;
    });

    // 3. After commit: vouchers (own transaction, idempotent).
    let vouchers: CancellationResult["vouchers"] = "none";
    if (plan.voucherAction !== null && this.d.vouchers !== undefined) {
      const action = plan.voucherAction;
      try {
        await (action === "release" ? this.d.vouchers.release(r.userId, r.groupId) : this.d.vouchers.reinstate(r.userId, r.groupId));
        vouchers = action === "release" ? "released" : "reinstated";
      } catch (e) {
        vouchers = "failed"; // caps stay counted (never under-counts); a replay of this cancel retries
        await this.settleAttention(r.userId, r.groupId, action, e);
      }
    }
    return { ...plan.result, vouchers };
  }

  /** H1 (finding 1): never fail silently. Error log first (survives a DB outage), then a durable attention event in a small transaction. */
  private async settleAttention(userId: string, groupId: string, action: "release" | "reinstate", e: unknown): Promise<void> {
    const error = errorCode(e);
    (this.d.log ?? stderrLog).error("cancellation voucher settlement failed", { order_group_id: groupId, action, error });
    try {
      await this.inUserTx(userId, (tx) => this.event(tx, PROMOTIONS_SETTLE_ATTENTION_EVENT, "order_group", groupId, this.now().toISOString(), { order_group_id: groupId, action, error }));
    } catch (inner) {
      (this.d.log ?? stderrLog).error("promotions.settle_attention could not be written", { order_group_id: groupId, action, error: errorCode(inner) });
    }
  }

  private async apply(tx: Queryable, r: { userId: string; groupId: string; targets: readonly string[] | null; reason: string; preference: RefundPreference | null; initiator: CancelInitiator }): Promise<Plan> {
    const g = await lockGroup(tx, r.groupId);
    const meta = (await tx.query<{ cancel_reason: string | null; paid_at: string | null }>("SELECT cancel_reason, paid_at FROM order_groups WHERE id = $1", [g.id])).rows[0];
    const sos = (await tx.query<SoRow>("SELECT id, store_id, status, cancel_reason FROM seller_orders WHERE order_group_id = $1 ORDER BY id FOR UPDATE", [g.id])).rows;
    if (r.targets?.some((t) => !sos.some((s) => s.id === t)) === true) throw new CheckoutError("not-found", "seller order not found in this order group");
    const discounted = BigInt(g.discount_minor) > 0n;

    if (UNPAID.has(g.status)) {
      if (r.initiator === "seller" || (r.targets !== null && r.targets.length !== sos.length)) throw new CheckoutError("order-not-cancellable", "an unpaid order is cancelled as a whole, by the shopper");
      return this.cancelUnpaid(tx, g, sos, r, discounted);
    }
    if (g.status === "CANCELLED") {
      if (meta?.cancel_reason === r.reason) return replay(g, "full", discounted ? (meta.paid_at === null ? "release" : "reinstate") : null);
      throw new CheckoutError("order-not-cancellable", "the order is already cancelled");
    }
    if (!PAID_GROUP.has(g.status)) throw new CheckoutError("order-not-cancellable", `order is ${g.status}`);
    if (r.preference === "store_credit" && g.payment_method === "bnpl") throw new CheckoutError("refund-preference-invalid", "BNPL refunds go back through the provider only");

    const targets = r.targets === null ? sos.filter((s) => !DEAD.has(s.status) || (s.status === "CANCELLED" && s.cancel_reason === r.reason)) : sos.filter((s) => r.targets?.includes(s.id));
    if (targets.some((s) => !CANCELLABLE.has(s.status) && !DEAD.has(s.status))) throw new CheckoutError("cancel-after-shipping", "a store has already shipped: refuse the parcel or return it instead");
    if (targets.some((s) => DEAD.has(s.status) && !(s.status === "CANCELLED" && s.cancel_reason === r.reason))) throw new CheckoutError("order-not-cancellable", "a seller order is already settled");
    const fresh = targets.filter((s) => CANCELLABLE.has(s.status));
    if (fresh.length === 0) {
      if (targets.length === 0) throw new CheckoutError("order-not-cancellable", "nothing left to cancel");
      return replay(g, "partial", null);
    }

    const at = this.now().toISOString();
    const charged = g.payment_method !== "cod";
    for (const so of fresh) {
      const next = transition(SELLER_ORDER, so.status, "cancel");
      await tx.query(
        `UPDATE seller_orders SET status = $2, cancel_reason = $3, cancelled_at = $4::timestamptz, cancel_refund_choice = $5, version = version + 1, updated_at = $4::timestamptz WHERE id = $1`,
        [so.id, next, r.reason, at, r.preference],
      );
      const lines = (await tx.query<{ sku_id: string; qty: number }>("UPDATE order_lines SET status = 'cancelled' WHERE seller_order_id = $1 AND status = 'active' RETURNING sku_id, qty", [so.id])).rows;
      lines.sort((a, b) => (a.sku_id < b.sku_id ? -1 : a.sku_id > b.sku_id ? 1 : 0));
      // Paid or COD-confirmed units are CLAIMED (ADR-0005): the inventory module lowers `committed` (ReleaseRequiredConsumer).
      if (lines.length > 0) {
        await this.event(tx, INVENTORY_RELEASE_REQUIRED_EVENT, "seller_order", so.id, at, {
          seller_order_id: so.id, order_group_id: g.id, store_id: so.store_id, user_id: g.user_id, market_id: this.d.marketId, reservation_id: g.reservation_id, lines, occurred_at: at,
        });
      }
      // M4: a PACKED order may already have its AWB/label; the shipping worker cancels it at the courier (same transaction as the cancel).
      if (so.status === "PACKED") {
        const ships = (await tx.query<{ id: string }>(
          "SELECT id FROM shipments WHERE $1::uuid = ANY(seller_order_ids) AND direction = 'outbound' AND status = ANY($2::text[]) ORDER BY id", [so.id, [...CANCELLABLE_SHIPMENT_STATUSES]],
        )).rows;
        for (const sh of ships) {
          await this.event(tx, SHIPMENT_CANCEL_REQUIRED_EVENT, "shipment", sh.id, at, {
            shipment_id: sh.id, seller_order_id: so.id, order_group_id: g.id, store_id: so.store_id, user_id: g.user_id, market_id: this.d.marketId, occurred_at: at,
          });
        }
      }
      await this.event(tx, SELLER_ORDER_CANCELLED_EVENT, "seller_order", so.id, at, {
        seller_order_id: so.id, order_group_id: g.id, store_id: so.store_id, user_id: g.user_id, reason_code: r.reason, initiator: r.initiator, charged, refund_preference: r.preference,
      });
    }
    const alive = sos.filter((s) => !DEAD.has(s.status) && !fresh.some((f) => f.id === s.id));
    let status: OrderGroupState = g.status;
    if (alive.length === 0 && g.status !== "PARTIALLY_FULFILLED") {
      status = await moveGroup(this.env(), tx, g, "cancel");
      await tx.query("UPDATE order_groups SET cancelled_at = $2::timestamptz, cancel_reason = $3 WHERE id = $1", [g.id, at, r.reason]);
    }
    const scope = status === "CANCELLED" ? "full" : "partial";
    await this.event(tx, ORDER_GROUP_CANCELLED_EVENT, "order_group", g.id, at, {
      order_group_id: g.id, user_id: g.user_id, scope, reason_code: r.reason, initiator: r.initiator, seller_order_ids: fresh.map((s) => s.id), refund_expected: charged, currency: g.currency,
    });
    return {
      before: g.status, voucherAction: scope === "full" && discounted ? "reinstate" : null,
      result: { orderGroupId: g.id, groupStatus: status, scope, cancelledSellerOrderIds: fresh.map((s) => s.id), refundExpected: charged, replayed: false },
    };
  }

  private async cancelUnpaid(tx: Queryable, g: GroupRow, sos: readonly SoRow[], r: { reason: string; initiator: CancelInitiator }, discounted: boolean): Promise<Plan> {
    const env = this.env();
    const at = this.now().toISOString();
    const i = await lockIntentOfGroup(tx, g.id);
    if (PENDING_INTENT.has(i.status)) await moveIntent(env, tx, i, "cancel");
    const status = await moveGroup(env, tx, g, "cancel");
    await tx.query("UPDATE order_groups SET cancelled_at = $2::timestamptz, cancel_reason = $3 WHERE id = $1", [g.id, at, r.reason]);
    for (const so of sos) {
      if (so.status !== "PENDING_PAYMENT") continue;
      await tx.query("UPDATE seller_orders SET status = $2, cancel_reason = $3, version = version + 1, updated_at = $4::timestamptz WHERE id = $1", [so.id, transition(SELLER_ORDER, so.status, "void"), r.reason, at]);
      await tx.query("UPDATE order_lines SET status = 'cancelled' WHERE seller_order_id = $1 AND status = 'active'", [so.id]);
    }
    await this.d.credit.release(tx, g.id, "RELEASED");
    if (g.reservation_id !== null) await this.d.reservations.releaseIn(tx, g.reservation_id);
    await setSessionStatus(env, tx, g.checkout_session_id, "expired");
    await this.event(tx, ORDER_GROUP_CANCELLED_EVENT, "order_group", g.id, at, {
      order_group_id: g.id, user_id: g.user_id, scope: "full", reason_code: r.reason, initiator: r.initiator, seller_order_ids: sos.map((s) => s.id), refund_expected: false, currency: g.currency,
    });
    return {
      before: g.status, voucherAction: discounted ? "release" : null,
      result: { orderGroupId: g.id, groupStatus: status, scope: "full", cancelledSellerOrderIds: sos.map((s) => s.id), refundExpected: false, replayed: false },
    };
  }

  private async event(tx: Queryable, type: string, aggregateType: string, aggregateId: string, at: string, payload: Record<string, unknown>): Promise<void> {
    await this.outbox.append(tx, { id: this.newId(), type, aggregateType, aggregateId, marketId: this.d.marketId, occurredAt: at, visibility: "internal", payload });
  }

  /** The order-ops state movers only read the clock. */
  private env(): Pick<Env, "now"> {
    return { now: this.now };
  }
}

/**
 * M3: a replay of a whole-group cancel re-runs the voucher settlement (release before payment, reinstate after; both idempotent), so a
 * settlement that failed after the first commit is retried by repeating the request. A partial replay never touches vouchers.
 */
const replay = (g: GroupRow, scope: "full" | "partial", voucherAction: Plan["voucherAction"]): Plan => ({
  before: g.status, voucherAction,
  result: { orderGroupId: g.id, groupStatus: g.status, scope, cancelledSellerOrderIds: [], refundExpected: g.payment_method !== "cod", replayed: true },
});

/** A stable, PII-free failure label: a domain error code when there is one, else the error class name. */
const errorCode = (e: unknown): string => {
  if (e instanceof Error) return "code" in e && typeof e.code === "string" ? e.code : e.name;
  return "unknown";
};

/** exactOptionalPropertyTypes: the API passes `refundPreference: undefined`; the strict schema wants the key absent. */
const stripUndefined = (o: CancelRequest): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
