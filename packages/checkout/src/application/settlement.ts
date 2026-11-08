import { Ledger } from "@outlet/ledger";
import type { Queryable } from "@outlet/db";
import { money } from "@outlet/money";
import { lateRefundDraft, orderPaidDraft } from "../domain/ledger-entry.js";
import { clearingFor, emit, loadSellerAmounts, moveGroup, moveIntent, moveSellerOrders, setSessionStatus } from "./order-ops.js";
import type { GroupRow, IntentRow } from "./order-ops.js";
import type { Env } from "./env.js";

const PENDING_INTENT = new Set(["CREATED", "REQUIRES_ACTION", "AUTHORIZED"]);

/**
 * Payment arrived (PSP capture, store-credit-only placement or a late capture): ONE ledger entry (order_recognised, key order_paid:{group}),
 * holds CAPTURED, group and seller orders PAID, intent CAPTURED, outbox order_group.paid. Runs in the caller's transaction, after the
 * inventory claim succeeded in that same transaction.
 */
export async function recordPaid(env: Env, tx: Queryable, g: GroupRow, i: IntentRow, opts: { readonly late: boolean }): Promise<string> {
  const cur = g.currency;
  const { sellers } = await loadSellerAmounts(tx, g.id, cur);
  const held = await env.credit.heldFor(tx, g.id);
  const external = money(i.status === "NOT_REQUIRED" ? 0n : BigInt(i.amount_minor), cur);
  const clearing = external.amountMinor > 0n ? clearingFor(i.provider, i.method, i.bnpl_provider) : ({ type: "psp_clearing", owner: "paymob" } as const);
  const now = env.now();
  const draft = orderPaidDraft({ marketId: env.marketId, currency: cur, orderGroupId: g.id, occurredAt: now, clearing, external, credit: held, sellers });
  const { entryId } = await Ledger.post(tx, draft);
  await env.credit.markCaptured(tx, g.id, entryId);
  if (i.status !== "NOT_REQUIRED") await moveIntent(env, tx, i, PENDING_INTENT.has(i.status) ? "capture" : "late_capture");
  await moveGroup(env, tx, g, opts.late ? "late_payment_claimed" : "payment_succeeded", { paid: true });
  await moveSellerOrders(env, tx, g.id, opts.late ? "late_pay" : "pay", { acceptBy: new Date(now.getTime() + env.config.sellerAcceptSlaSec * 1000) });
  await setSessionStatus(env, tx, g.checkout_session_id, "completed");
  await emit(env, tx, "order_group.paid", g.id, { total_minor: BigInt(g.total_minor).toString(), currency: cur, late: opts.late, ledger_entry_id: entryId });
  return entryId;
}

/** COD confirmed (risk allowed it or the shopper confirmed): nothing is posted at placement (I15); the claim already happened. */
export async function recordCodConfirmed(env: Env, tx: Queryable, g: GroupRow): Promise<void> {
  await moveGroup(env, tx, g, "cod_confirmed");
  await moveSellerOrders(env, tx, g.id, "cod_confirm", { acceptBy: new Date(env.now().getTime() + env.config.sellerAcceptSlaSec * 1000) });
  await setSessionStatus(env, tx, g.checkout_session_id, "completed");
  await emit(env, tx, "order_group.confirmed_cod", g.id, { total_minor: BigInt(g.total_minor).toString(), currency: g.currency });
}

/**
 * Compensation for a failed or expired payment, same transaction as the state change.
 * failed (COD or a synchronous PSP decline; a webhook decline on an external method is NOT final, see recordAttemptFailed): the reservation is released (terminal). expired: an external reservation lapses through the inventory sweeper at the same
 * instant (so a late capture can still be auto-claimed, README section 9); a COD reservation has no late-payment path and is released.
 */
export async function compensate(env: Env, tx: Queryable, g: GroupRow, i: IntentRow, kind: "failed" | "expired", failureCode: string | null): Promise<boolean> {
  if (g.status !== "PENDING_PAYMENT" && !(kind === "expired" && g.status === "AWAITING_COD_CONFIRMATION")) return false;
  if (PENDING_INTENT.has(i.status)) await moveIntent(env, tx, i, kind === "failed" ? "fail" : "expire", failureCode === null ? {} : { failureCode });
  await moveGroup(env, tx, g, kind === "failed" ? "payment_failed" : "expire");
  await moveSellerOrders(env, tx, g.id, "void");
  await env.credit.release(tx, g.id, kind === "failed" ? "RELEASED" : "EXPIRED");
  if (g.reservation_id !== null && (kind === "failed" || g.payment_method === "cod")) await env.reservations.releaseIn(tx, g.reservation_id);
  await setSessionStatus(env, tx, g.checkout_session_id, "expired");
  await emit(env, tx, kind === "failed" ? "order_group.payment_failed" : "order_group.expired", g.id, { failure_code: failureCode });
  return true;
}

/**
 * C1: a declined attempt on an EXTERNAL method is not final (the shopper may retry with another card, and the PSP may later report
 * success for the same intent). Nothing is compensated: the group stays PENDING_PAYMENT, the reservation and credit hold lapse at the
 * window's end (same as `expired`), and only `failure_code` is recorded. A later `payment.succeeded` within the window claims normally.
 * VERIFY V41: Paymob per-attempt callback semantics (one order, several transactions) must be confirmed with the contract/sandbox.
 */
export async function recordAttemptFailed(env: Env, tx: Queryable, g: GroupRow, i: IntentRow, failureCode: string): Promise<void> {
  await tx.query("UPDATE payment_intents SET failure_code = $2, version = version + 1, updated_at = $3::timestamptz WHERE id = $1", [i.id, failureCode, env.now().toISOString()]);
  await emit(env, tx, "order_group.payment_attempt_failed", g.id, { failure_code: failureCode, payment_intent_id: i.id });
}

/** Late payment and the stock (or the credit) is gone: the money is owed back (README section 9). The outbox event is the single owner of the refund request: LateRefundConsumer calls the RefundPort (idempotent, retried). */
export async function recordLateRefund(env: Env, tx: Queryable, g: GroupRow, i: IntentRow): Promise<void> {
  const external = money(BigInt(i.amount_minor), g.currency);
  const { entryId } = await Ledger.post(tx, lateRefundDraft({ marketId: env.marketId, currency: g.currency, orderGroupId: g.id, occurredAt: env.now(), clearingOwner: clearingFor(i.provider, i.method, i.bnpl_provider).owner, external }));
  await moveIntent(env, tx, i, "late_capture");
  await moveGroup(env, tx, g, "late_payment_unavailable");
  await emit(env, tx, "order_group.late_payment_refund", g.id, { amount_minor: external.amountMinor.toString(), currency: g.currency, ledger_entry_id: entryId, apology: true, payment_intent_id: i.id, idempotency_key: `late_refund:${g.id}` });
}
