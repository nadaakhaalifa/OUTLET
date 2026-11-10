import { withDbContext, narrowContext } from "@outlet/db";
import type { Queryable } from "@outlet/db";
import type { ClaimResult } from "@outlet/inventory";
import { money } from "@outlet/money";
import { isExternal } from "../domain/methods.js";
import { CheckoutError } from "../domain/errors.js";
import type { NormalizedPaymentEvent, WebhookInput } from "../ports.js";
import { makeEnv } from "./env.js";
import type { Env, WorkerDeps } from "./env.js";
import { sha256Bytes, sha256Hex } from "./hash.js";
import { settleVouchers } from "./promotions-glue.js";
import { compensate, recordAttemptFailed, recordLateRefund, recordPaid } from "./settlement.js";
import { lockGroup, lockIntentOfGroup } from "./order-ops.js";
import type { IntentRow } from "./order-ops.js";

export type WebhookOutcome =
  | { readonly outcome: "rejected"; readonly reason: string }
  | { readonly outcome: "duplicate" }
  | { readonly outcome: "processed" | "ignored"; readonly detail: string };

/** Work that must follow the commit: the stock publish, and the voucher settlement (VoucherService has its own transaction). */
interface After { readonly claim: ClaimResult | null; readonly vouchers?: { readonly kind: "confirm" | "release"; readonly userId: string; readonly groupId: string } }
interface ProcessResult { readonly result: WebhookOutcome; readonly after: After }
interface RawRow { id: string; processing_status: "received" | "processed" | "ignored" | "failed" | "rejected" }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AAD = "payment_events_raw.body_ct";
const iso = (d: Date): string => d.toISOString();

/**
 * Worker job payments.webhook (README sections 2, 8, 9). Raw bytes are verified BEFORE parsing, stored encrypted with their sha256 and
 * deduplicated by UNIQUE (market, provider, event id); the money effects (claim, ledger entry, statuses, outbox) are ONE transaction.
 * A webhook is processed even when the method's kill switch is engaged: the money already moved.
 */
export class WebhookProcessor {
  private readonly env: Env;
  constructor(private readonly d: WorkerDeps) {
    this.env = makeEnv(d);
  }

  private inWorkerTx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.d.client, { kind: "worker", marketId: this.env.marketId, job: "payments.webhook" }, fn);
  }

  async handle(input: WebhookInput): Promise<WebhookOutcome> {
    const env = this.env;
    const verified = env.provider.verifyWebhook(input);
    const bodyHash = sha256Bytes(input.rawBody);
    const eventId = verified.ok ? verified.event.providerEventId : `unverified:${bodyHash.toString("hex")}`;
    const ct = await this.d.cipher.encrypt(input.rawBody, AAD);

    // txA: store the raw event first, good signature or bad
    const raw = await this.inWorkerTx(async (tx) => {
      const status = verified.ok ? "received" : "rejected";
      const ins = await tx.query<RawRow>(
        `INSERT INTO payment_events_raw (id, market_id, provider, provider_event_id, event_type, signature_ok, body_ct, body_sha256, processing_status, failure_reason, received_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz)
         ON CONFLICT (market_id, provider, provider_event_id) DO NOTHING RETURNING id, processing_status`,
        [env.newId(), env.marketId, env.provider.provider, eventId, verified.ok ? verified.event.type : "unverified", verified.ok, ct, bodyHash, status, verified.ok ? null : verified.reason, iso(input.receivedAt)],
      );
      const row = ins.rows[0] ?? (await tx.query<RawRow>("SELECT id, processing_status FROM payment_events_raw WHERE market_id = $1 AND provider = $2 AND provider_event_id = $3", [env.marketId, env.provider.provider, eventId])).rows[0];
      if (row === undefined) throw new Error("raw webhook row missing after insert");
      return { ...row, fresh: ins.rows[0] !== undefined };
    });
    if (!verified.ok) return { outcome: "rejected", reason: verified.reason };
    if (!raw.fresh && (raw.processing_status === "processed" || raw.processing_status === "ignored" || raw.processing_status === "rejected")) return { outcome: "duplicate" };

    // txB: lock the raw row, resolve and check the intent, apply the effects, mark the row. All or nothing.
    let done: ProcessResult;
    try {
      done = await this.inWorkerTx(async (tx) => this.process(tx, raw.id, verified.event));
    } catch (e) {
      await this.inWorkerTx((tx) => tx.query("UPDATE payment_events_raw SET processing_status = 'failed', failure_reason = $2 WHERE id = $1", [raw.id, (e instanceof Error ? e.name : "error").slice(0, 100)]));
      throw e;
    }
    const { result, after } = done;
    if (after.claim !== null) await env.reservations.publish(after.claim);
    if (after.vouchers !== undefined) await settleVouchers(env, after.vouchers.kind, after.vouchers.userId, after.vouchers.groupId);
    return result;
  }

  private async process(tx: Queryable, rawId: string, ev: NormalizedPaymentEvent): Promise<ProcessResult> {
    const env = this.env;
    const none: After = { claim: null };
    const locked = (await tx.query<RawRow>("SELECT id, processing_status FROM payment_events_raw WHERE id = $1 FOR UPDATE", [rawId])).rows[0];
    if (locked === undefined) throw new Error("raw webhook row vanished");
    if (locked.processing_status === "processed" || locked.processing_status === "ignored") return { result: { outcome: "duplicate" }, after: none };
    const mark = async (status: "processed" | "ignored" | "rejected", reason: string | null, intentId: string | null): Promise<void> => {
      await tx.query("UPDATE payment_events_raw SET processing_status = $2, failure_reason = $3, payment_intent_id = $4, processed_at = $5::timestamptz WHERE id = $1", [rawId, status, reason, intentId, iso(env.now())]);
    };
    const reject = async (reason: string, intent: IntentRow | null, extra: Record<string, string> = {}): Promise<{ result: WebhookOutcome; after: After }> => {
      await mark("rejected", reason, intent?.id ?? null);
      await env.outbox.append(tx, { id: env.newId(), type: "payment.webhook_rejected", aggregateType: "payment_event", aggregateId: rawId, marketId: env.marketId, occurredAt: iso(env.now()), visibility: "internal", payload: { reason, provider: env.provider.provider, intent_id: intent?.id ?? null, ...extra } });
      return { result: { outcome: "rejected", reason }, after: none };
    };

    const ref = ev.merchantReference;
    const intent = ref !== null && UUID.test(ref) ? (await tx.query<IntentRow>("SELECT id, order_group_id, user_id, provider, provider_ref, method, bnpl_provider, amount_minor, currency, status, client_action FROM payment_intents WHERE id = $1", [ref])).rows[0] : undefined;
    if (intent === undefined) return reject("intent_not_found", null);
    if (intent.provider !== env.provider.provider) return reject("provider_mismatch", intent);
    if (ev.type === "payment.succeeded" && (ev.amount.currency !== intent.currency || ev.amount.amountMinor !== BigInt(intent.amount_minor))) return reject("amount_mismatch", intent);
    if (ev.type === "payment.failed" && ev.amount.currency !== intent.currency) return reject("currency_mismatch", intent);

    // narrow, then act: from here the normal user policies apply to the order's owner
    await narrowContext(tx, { userId: intent.user_id });
    if (ev.type !== "payment.succeeded" && ev.type !== "payment.failed") {
      await mark("ignored", ev.type, intent.id);
      return { result: { outcome: "ignored", detail: ev.type }, after: none };
    }
    const g = await lockGroup(tx, intent.order_group_id);
    const i = await lockIntentOfGroup(tx, intent.order_group_id);
    // C2: a capture whose provider reference differs from the intent's. On a settled group it is a possible DOUBLE CAPTURE (finance/security
    // event, listed by the reconciliation job); on an unsettled one the reference does not belong to this intent. Neither changes state.
    if (ev.type === "payment.succeeded" && ev.providerRef.length > 0 && i.provider_ref !== null && ev.providerRef !== i.provider_ref) {
      const ctx = { groupId: g.id, providerRef: ev.providerRef };
      const settled = g.status !== "PENDING_PAYMENT" && g.status !== "PAYMENT_FAILED" && g.status !== "EXPIRED" && g.status !== "AWAITING_COD_CONFIRMATION";
      return reject(settled ? "duplicate_capture" : "provider_ref_mismatch", i, ctx);
    }
    // only a capture back-fills the reference: Paymob reports a new transaction id per attempt, and a declined attempt must not pin the intent to it (V41)
    if (ev.type === "payment.succeeded" && ev.providerRef.length > 0 && i.provider_ref === null) await tx.query("UPDATE payment_intents SET provider_ref = $2 WHERE id = $1", [i.id, ev.providerRef]);

    if (ev.type === "payment.failed") {
      if (g.status === "PENDING_PAYMENT" && isExternal(i.method)) {
        await recordAttemptFailed(env, tx, g, i, ev.failureCode ?? "failed");
        await mark("processed", null, i.id);
        return { result: { outcome: "processed", detail: "payment_attempt_failed" }, after: none };
      }
      const did = g.status === "PENDING_PAYMENT" ? await compensate(env, tx, g, i, "failed", ev.failureCode ?? "failed") : false;
      await mark(did ? "processed" : "ignored", did ? null : `failed_after_${g.status.toLowerCase()}`, i.id);
      return { result: did ? { outcome: "processed", detail: "payment_failed" } : { outcome: "ignored", detail: "failure_after_settlement" }, after: did && BigInt(g.discount_minor) > 0n ? { claim: null, vouchers: { kind: "release", userId: g.user_id, groupId: g.id } } : none };
    }

    // payment.succeeded
    if (g.reservation_id === null) throw new CheckoutError("invalid-state", "order group has no reservation");
    if (g.status === "PENDING_PAYMENT") {
      const claim = await env.reservations.claimIn(tx, g.reservation_id);
      if (claim.outcome === "unavailable") {
        // the stock is gone even though the window is open (late claim of a lapsed reservation): compensate, then owe the money back
        await compensate(env, tx, g, i, "expired", null);
        const g2 = await lockGroup(tx, g.id);
        const i2 = await lockIntentOfGroup(tx, g.id);
        await recordLateRefund(env, tx, g2, i2);
        await mark("processed", "late_refund", i.id);
        return { result: { outcome: "processed", detail: "late_refund" }, after: BigInt(g.discount_minor) > 0n ? { claim: null, vouchers: { kind: "release", userId: g.user_id, groupId: g.id } } : none };
      }
      await recordPaid(env, tx, g, i, { late: false });
      await mark("processed", null, i.id);
      return { result: { outcome: "processed", detail: "paid" }, after: BigInt(g.discount_minor) > 0n ? { claim, vouchers: { kind: "confirm", userId: g.user_id, groupId: g.id } } : { claim } };
    }
    if (g.status === "PAYMENT_FAILED" || g.status === "EXPIRED") {
      const credit = BigInt(g.store_credit_minor);
      let claim: ClaimResult | null = null;
      await tx.query("SAVEPOINT late_pay");
      try {
        if (credit > 0n) await env.credit.hold(tx, { userId: g.user_id, marketId: env.marketId, orderGroupId: g.id, amount: money(credit, g.currency), expiresAt: new Date(env.now().getTime() + 60_000) });
        const c = await env.reservations.claimIn(tx, g.reservation_id);
        if (c.outcome !== "unavailable") claim = c;
      } catch (e) {
        // credit gone, or the reservation was explicitly released (terminal: nothing left to claim): both mean refund
        const code = typeof e === "object" && e !== null && "code" in e ? e.code : null;
        if (code !== "credit-insufficient" && code !== "invalid_transition") throw e;
      }
      if (claim === null) {
        await tx.query("ROLLBACK TO SAVEPOINT late_pay");
        await tx.query("RELEASE SAVEPOINT late_pay");
        await recordLateRefund(env, tx, g, i);
        await mark("processed", "late_refund", i.id);
        return { result: { outcome: "processed", detail: "late_refund" }, after: none };
      }
      await tx.query("RELEASE SAVEPOINT late_pay");
      await recordPaid(env, tx, g, i, { late: true });
      await mark("processed", null, i.id);
      return { result: { outcome: "processed", detail: "late_paid" }, after: BigInt(g.discount_minor) > 0n ? { claim, vouchers: { kind: "confirm", userId: g.user_id, groupId: g.id } } : { claim } };
    }
    if (g.status === "CANCELLED" && i.status === "CANCELLED") {
      // H1: the shopper cancelled the unpaid group (intent voided) and the PSP captured anyway. Never re-claim the stock: the money is owed
      // back through the late-refund path (ledger entry + order_group.late_payment_refund, owned by LateRefundConsumer). A group cancelled
      // AFTER payment has a CAPTURED intent and falls through to `ignored` (its refunds come from the cancellation saga).
      await recordLateRefund(env, tx, g, i);
      await mark("processed", "late_refund_after_cancel", i.id);
      return { result: { outcome: "processed", detail: "late_refund" }, after: none };
    }
    await mark("ignored", `succeeded_after_${g.status.toLowerCase()}`, i.id);
    return { result: { outcome: "ignored", detail: "already_settled" }, after: none };
  }
}

export const rawBodyHash = (body: Uint8Array): string => sha256Hex(body);
