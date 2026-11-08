import type { Queryable } from "@outlet/db";
import { money } from "@outlet/money";
import type { Currency, Money } from "@outlet/money";
import { ORDER_GROUP, PAYMENT_INTENT, SELLER_ORDER, transition } from "@outlet/orders";
import type { OrderGroupEvent, OrderGroupState, PaymentIntentEvent, PaymentIntentState, SellerOrderEvent, SellerOrderState } from "@outlet/orders";
import type { OutboxEventInput } from "@outlet/outbox";
import { CheckoutError } from "../domain/errors.js";
import type { SellerAmounts } from "../domain/split.js";
import type { PaymentMethod } from "../ports.js";
import type { Env } from "./env.js";

export interface GroupRow {
  readonly id: string;
  readonly user_id: string;
  readonly status: OrderGroupState;
  readonly currency: Currency;
  readonly payment_method: PaymentMethod;
  readonly total_minor: string | bigint;
  readonly store_credit_minor: string | bigint;
  readonly reservation_id: string | null;
  readonly payment_expires_at: Date | string | null;
  readonly checkout_session_id: string;
}
export interface IntentRow {
  readonly id: string;
  readonly order_group_id: string;
  readonly user_id: string;
  readonly provider: string;
  readonly provider_ref: string | null;
  readonly method: PaymentMethod;
  readonly bnpl_provider: string | null;
  readonly amount_minor: string | bigint;
  readonly currency: Currency;
  readonly status: PaymentIntentState;
  readonly client_action: unknown;
}

const iso = (d: Date): string => d.toISOString();

export const lockGroup = async (tx: Queryable, groupId: string): Promise<GroupRow> => {
  const g = (
    await tx.query<GroupRow>(
      `SELECT id, user_id, status, currency, payment_method, total_minor, store_credit_minor, reservation_id, payment_expires_at, checkout_session_id
         FROM order_groups WHERE id = $1 FOR UPDATE`,
      [groupId],
    )
  ).rows[0];
  if (g === undefined) throw new CheckoutError("not-found", "order group not found");
  return g;
};

export const lockIntentOfGroup = async (tx: Queryable, groupId: string): Promise<IntentRow> => {
  const i = (
    await tx.query<IntentRow>(
      `SELECT id, order_group_id, user_id, provider, provider_ref, method, bnpl_provider, amount_minor, currency, status, client_action
         FROM payment_intents WHERE order_group_id = $1 FOR UPDATE`,
      [groupId],
    )
  ).rows[0];
  if (i === undefined) throw new CheckoutError("not-found", "payment intent not found");
  return i;
};

export const moveGroup = async (env: Env, tx: Queryable, g: GroupRow, event: OrderGroupEvent, extra: { paid?: boolean } = {}): Promise<OrderGroupState> => {
  const next = transition(ORDER_GROUP, g.status, event);
  const at = iso(env.now());
  await tx.query("UPDATE order_groups SET status = $2, paid_at = CASE WHEN $3::boolean THEN $4::timestamptz ELSE paid_at END, version = version + 1, updated_at = $4::timestamptz WHERE id = $1", [g.id, next, extra.paid === true, at]);
  return next;
};

export const moveIntent = async (env: Env, tx: Queryable, i: IntentRow, event: PaymentIntentEvent, set: { failureCode?: string } = {}): Promise<PaymentIntentState> => {
  const next = transition(PAYMENT_INTENT, i.status, event);
  await tx.query("UPDATE payment_intents SET status = $2, failure_code = COALESCE($3, failure_code), version = version + 1, updated_at = $4::timestamptz WHERE id = $1", [i.id, next, set.failureCode ?? null, iso(env.now())]);
  return next;
};

/** Every seller order of a group moves together until fulfilment starts. Each row goes through the machine. */
export const moveSellerOrders = async (env: Env, tx: Queryable, groupId: string, event: SellerOrderEvent, opts: { acceptBy?: Date } = {}): Promise<number> => {
  const rows = (await tx.query<{ id: string; status: SellerOrderState }>("SELECT id, status FROM seller_orders WHERE order_group_id = $1 ORDER BY id FOR UPDATE", [groupId])).rows;
  for (const r of rows) {
    const next = transition(SELLER_ORDER, r.status, event);
    await tx.query("UPDATE seller_orders SET status = $2, accept_by = COALESCE($3::timestamptz, accept_by), version = version + 1, updated_at = $4::timestamptz WHERE id = $1", [r.id, next, opts.acceptBy === undefined ? null : iso(opts.acceptBy), iso(env.now())]);
  }
  return rows.length;
};

export const setSessionStatus = async (env: Env, tx: Queryable, sessionId: string, status: "completed" | "expired"): Promise<void> => {
  await tx.query("UPDATE checkout_sessions SET status = $2, updated_at = $3::timestamptz WHERE id = $1", [sessionId, status, iso(env.now())]);
};

/** Rebuilds the per-store amounts from the rows written at placement (the stored snapshot is authoritative, never re-quoted). */
export const loadSellerAmounts = async (tx: Queryable, groupId: string, currency: Currency): Promise<{ sellers: SellerAmounts[]; sellerOrderIds: Map<string, string> }> => {
  const rows = (
    await tx.query<{ id: string; store_id: string; items_subtotal_minor: string | bigint; shipping_minor: string | bigint; shipping_vat_minor: string | bigint; vat_minor: string | bigint; total_minor: string | bigint; commission_bp_snapshot: number; commission_minor: string | bigint; commission_vat_minor: string | bigint; seller_net_minor: string | bigint }>(
      `SELECT id, store_id, items_subtotal_minor, shipping_minor, shipping_vat_minor, vat_minor, total_minor, commission_bp_snapshot, commission_minor, commission_vat_minor, seller_net_minor
         FROM seller_orders WHERE order_group_id = $1 ORDER BY store_id`,
      [groupId],
    )
  ).rows;
  const m = (v: string | bigint): Money => money(BigInt(v), currency);
  return {
    sellerOrderIds: new Map(rows.map((r) => [r.store_id, r.id])),
    sellers: rows.map((r) => ({
      storeId: r.store_id, items: m(r.items_subtotal_minor), shipping: m(r.shipping_minor), shippingVat: m(r.shipping_vat_minor),
      shippingNet: m(BigInt(r.shipping_minor) - BigInt(r.shipping_vat_minor)), goodsVat: m(BigInt(r.vat_minor) - BigInt(r.shipping_vat_minor)),
      commissionBp: r.commission_bp_snapshot, commission: m(r.commission_minor), commissionVat: m(r.commission_vat_minor), net: m(r.seller_net_minor), total: m(r.total_minor),
    })),
  };
};

export const emit = async (env: Env, tx: Queryable, type: string, groupId: string, payload: Record<string, string | number | boolean | null>): Promise<void> => {
  const e: OutboxEventInput = { id: env.newId(), type, aggregateType: "order_group", aggregateId: groupId, marketId: env.marketId, occurredAt: iso(env.now()), visibility: "internal", payload: { order_group_id: groupId, ...payload } };
  await env.outbox.append(tx, e);
};

/** Ledger owner of the clearing account for an intent. `fake` stands in for the seeded paymob account; unseeded PSPs fail closed. */
export const clearingFor = (provider: string, method: PaymentMethod, bnplProvider: string | null): { type: "psp_clearing" | "bnpl_clearing"; owner: string } => {
  if (method === "bnpl") {
    if (bnplProvider === null) throw new CheckoutError("invalid-state", "bnpl intent without a provider");
    return { type: "bnpl_clearing", owner: bnplProvider };
  }
  if (provider === "paymob" || provider === "fake") return { type: "psp_clearing", owner: "paymob" };
  throw new CheckoutError("invalid-state", `no clearing account is seeded for provider ${provider}`);
};
