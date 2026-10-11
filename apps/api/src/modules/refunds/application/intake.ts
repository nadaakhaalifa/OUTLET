import {
  buildEntry,
  money,
  orderRecognitionKeys,
  planRefundLegs,
  DEFAULT_REFUND_ROUTER_CONFIG,
  type OriginalTender,
  type RefundRouterConfig,
} from "../domain/bridge";
import {
  RefundIntentMessageSchema,
  type ClockPort,
  type IdPort,
  type RefundFactsPort,
  type RefundLegRecord,
  type RefundRecord,
  type RefundStore,
} from "../domain/ports";
import { toStoredEntry } from "./entry-codec";
import { RefundFactsUnavailableError, RefundIntakeConflictError } from "./errors";

export { RefundFactsUnavailableError, RefundIntakeConflictError };

export const RETURN_INTENT_CONSUMER = "refunds.return_intent";

export type IntakeResult =
  | { readonly kind: "created"; readonly refundId: string }
  | { readonly kind: "duplicate" }
  | { readonly kind: "exists" }
  | { readonly kind: "rejected"; readonly reason: string };

/**
 * Consumes `return.refund_intent` through the inbox (at-least-once, A2.7): a replay of the same
 * message id, or a re-publication under another id for the same return, creates nothing twice.
 * Facts that are not available yet throw, so the message is retried and never marked processed.
 */
export class IntakeRefundIntent {
  constructor(
    private readonly store: RefundStore,
    private readonly facts: RefundFactsPort,
    private readonly ids: IdPort,
    private readonly clock: ClockPort,
    private readonly routerConfig: RefundRouterConfig = DEFAULT_REFUND_ROUTER_CONFIG,
  ) {}

  async execute(raw: unknown): Promise<IntakeResult> {
    const parsed = RefundIntentMessageSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("refund intent message failed validation");
    }
    const { messageId, event } = parsed.data;
    const reject = async (reason: string): Promise<IntakeResult> => {
      const r = await this.store.reject({
        consumer: RETURN_INTENT_CONSUMER,
        messageId,
        returnId: event.returnId,
        reason,
      });
      return r === "duplicate" ? { kind: "duplicate" } : { kind: "rejected", reason };
    };

    // A re-publication of an intent that already produced a refund must stay "exists", never be
    // re-judged against capacity that its own refund has consumed.
    const committed = await this.store.committedForSellerOrder(event.sellerOrderId);
    if (committed.idempotencyKeys.has(event.idempotencyKey)) {
      const r = await this.store.acknowledgeExisting({ consumer: RETURN_INTENT_CONSUMER, messageId });
      return { kind: r };
    }

    const facts = await this.facts.forSellerOrder(event.sellerOrderId);
    if (facts === null) throw new RefundFactsUnavailableError(event.sellerOrderId);
    // The intent is data from another module: it must agree with the payment facts on who and where.
    if (facts.userId !== event.userId) return reject("owner_mismatch");
    if (facts.storeId !== event.storeId) return reject("store_mismatch");

    const a = event.allocation;
    const item = BigInt(a.itemTotal);
    const voucher = BigInt(a.voucherTotal);
    const fee = BigInt(a.deliveryFeeTotal);
    const net = BigInt(a.netTotal);
    if (item - voucher + fee !== net || net <= 0n) return reject("allocation_inconsistent");
    if (a.lines.reduce((s, l) => s + BigInt(l.netAmount), 0n) !== net) return reject("allocation_inconsistent");
    if (a.lines.reduce((s, l) => s + BigInt(l.itemAmount), 0n) !== item) return reject("allocation_inconsistent");

    // R-3: the delivery fee is capped by the fee the shopper paid, never taken from the intent.
    const feeLeft = facts.deliveryFee - facts.deliveryFeeRefundedBefore - committed.fee;
    if (fee > (feeLeft < 0n ? 0n : feeLeft)) return reject("allocation_inconsistent");

    // Capacity: what the facts say was refunded elsewhere, plus what this module already holds.
    const lineFacts = new Set(facts.lines.map((l) => l.orderLineId));
    if (a.lines.some((l) => !lineFacts.has(l.orderLineId))) return reject("unknown_line");
    const tenders: OriginalTender[] = facts.tenders.map((t) => ({
      ...t,
      refundedBefore: money(t.refundedBefore.amount + (committed.byTender.get(t.id) ?? 0n)),
    }));

    const refundId = this.ids.uuidV7();
    const nowMs = this.clock.nowMs();
    let legsPlan;
    try {
      legsPlan = planRefundLegs({
        userId: facts.userId,
        storeId: facts.storeId,
        commissionBps: facts.commissionBps,
        vatBps: facts.vatBps,
        lines: facts.lines.map((l) => ({
          lineId: l.orderLineId,
          gross: money(l.gross),
          refundedBefore: money(l.refundedBefore + (committed.byLine.get(l.orderLineId) ?? 0n)),
        })),
        items: a.lines.map((l) => ({ lineId: l.orderLineId, goods: money(BigInt(l.itemAmount)) })),
        platformVoucher: money(facts.platformVoucher),
        sellerVoucher: money(facts.sellerVoucher),
        shippingGross: money(fee),
        tenders,
        choice: { preference: event.refundPreference, cod: facts.choice.cod },
        config: this.routerConfig,
      });
    } catch {
      // Over a line's value, over what the tenders can still refund, unknown or repeated line.
      return reject("not_refundable");
    }
    // One allocation implementation: the returns module's figure must agree with the ledger plan.
    if (legsPlan.plan.total.amount !== net) return reject("allocation_mismatch");
    const routes = legsPlan.routes;

    const entry = buildEntry(
      { type: "refund", refundId, ...legsPlan.input },
      { id: this.ids.uuidV7(), occurredAt: new Date(nowMs) },
    );

    const tenderById = new Map(facts.tenders.map((t) => [t.id, t] as const));
    const legs: RefundLegRecord[] = routes.map((r, position) => {
      const t = tenderById.get(r.tenderId);
      return {
        id: this.ids.uuidV7(),
        refundId,
        position,
        tenderId: r.tenderId,
        method: r.method,
        channel: r.channel,
        amount: r.amount.amount,
        creditSub: r.creditSub,
        tender: {
          ...(t?.psp === undefined ? {} : { psp: t.psp }),
          ...(t?.provider === undefined ? {} : { provider: t.provider }),
          ...(t?.courier === undefined ? {} : { courier: t.courier }),
        },
        state: "REQUESTED",
        attempts: 0,
        nextAttemptAtMs: null,
        providerRef: null,
        failureCode: null,
        needsPayoutDetails: r.needsPayoutDetails,
        verify: r.verify,
        note: r.note,
      };
    });
    const refund: RefundRecord = {
      id: refundId,
      userId: facts.userId,
      storeId: facts.storeId,
      sellerOrderId: event.sellerOrderId,
      returnId: event.returnId,
      source: "return",
      idempotencyKey: event.idempotencyKey,
      status: "REQUESTED",
      amount: net,
      itemTotal: item,
      voucherTotal: voucher,
      deliveryFeeTotal: fee,
      lines: a.lines.map((l) => ({
        orderLineId: l.orderLineId,
        qty: l.qty,
        itemAmount: BigInt(l.itemAmount),
        voucherShare: BigInt(l.voucherShare),
        deliveryFeeShare: BigInt(l.deliveryFeeShare),
        netAmount: BigInt(l.netAmount),
      })),
      entry: toStoredEntry(entry, orderRecognitionKeys(facts.orderGroupId)),
      ledgerPostedAtMs: null,
      returnReceivedAtMs: facts.returnReceivedAtMs ?? event.occurredAtMs,
      requestedAtMs: nowMs,
      initiatedAtMs: null,
      completedAtMs: null,
      legs,
      version: 0,
    };
    const out = await this.store.intake({
      consumer: RETURN_INTENT_CONSUMER,
      messageId,
      refund,
      expectedCommitted: committed.count,
    });
    if (out === "stale") throw new RefundIntakeConflictError(event.sellerOrderId);
    return out === "created" ? { kind: "created", refundId } : { kind: out };
  }
}
