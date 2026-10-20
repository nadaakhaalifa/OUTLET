import {
  GIFT_CARD_LIMITS,
  canVoid,
  checkAmount,
  isPurchaseMethod,
  next,
  requiredMinimumAge,
  requiresThreeDs,
  violatesWording,
  type DeliveryChannel,
  type GiftCardDesign,
} from "../domain/bridge";
import type { CardRecord, CardView } from "../domain/ports";
import {
  cardEvent,
  cardView,
  contactAad,
  enc,
  issueCard,
  markDelivered,
  messageAad,
  type GiftCardDeps,
  type IssueResult,
} from "./shared";

export interface PurchaseInput {
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly amount: bigint;
  readonly design: GiftCardDesign;
  readonly channel: DeliveryChannel;
  readonly contact: string | null;
  readonly message: string | null;
  readonly scheduledAtMs: number | null;
  readonly scopeStoreId: string | null;
  readonly paymentMethod: string;
  readonly isNewCard: boolean;
}

export type PurchaseResult =
  | {
      readonly kind: "ok";
      readonly card: CardView;
      readonly paymentIntentId: string | null;
      readonly clientAction: "redirect" | "native_sheet" | "none";
      readonly requiresThreeDs: boolean;
      readonly replayed: boolean;
    }
  | { readonly kind: "disabled" }
  | { readonly kind: "method_refused" }
  | { readonly kind: "invalid_amount"; readonly reason: "below_min" | "above_max" | "not_whole_egp" }
  | { readonly kind: "invalid_message" }
  | { readonly kind: "invalid_schedule" }
  | { readonly kind: "age_required"; readonly minimumAge: 21 };

const MAX_SCHEDULE_AHEAD_MS = 366 * 86_400_000;

/** Step 1 of the issue saga: validate, record PENDING_PAYMENT, open the PSP intent. No code exists yet. */
export class PurchaseGiftCard {
  constructor(private readonly d: GiftCardDeps) {}

  async execute(i: PurchaseInput): Promise<PurchaseResult> {
    const d = this.d;
    if (!(await d.flags.salesEnabled())) return { kind: "disabled" };
    if (!isPurchaseMethod(i.paymentMethod)) return { kind: "method_refused" };
    const a = checkAmount(i.amount);
    if (!a.ok) return { kind: "invalid_amount", reason: a.reason };
    if (i.message !== null && (i.message.length > GIFT_CARD_LIMITS.maxMessageChars || violatesWording(i.message))) {
      return { kind: "invalid_message" };
    }
    const nowMs = d.clock.nowMs();
    if (i.scheduledAtMs !== null && (i.scheduledAtMs <= nowMs || i.scheduledAtMs > nowMs + MAX_SCHEDULE_AHEAD_MS)) {
      return { kind: "invalid_schedule" };
    }
    if (requiredMinimumAge(i.amount) === 21 && !(await d.age.meetsMinimumAge(i.userId, 21))) {
      return { kind: "age_required", minimumAge: 21 };
    }

    const id = d.ids.uuidV7();
    const record: CardRecord = {
      id,
      purchaserId: i.userId,
      codeHash: null,
      codeKeyVersion: null,
      last4: null,
      amount: i.amount,
      remaining: i.amount,
      status: "PENDING_PAYMENT",
      scopeStoreId: i.scopeStoreId,
      expiresAtMs: null,
      design: i.design,
      recipientChannel: i.channel,
      recipientContactEnc: i.contact === null ? null : await d.cipher.encrypt(enc(i.contact), contactAad(id)),
      messageEnc: i.message === null ? null : await d.cipher.encrypt(enc(i.message), messageAad(id)),
      scheduledAtMs: i.scheduledAtMs,
      potId: null,
      paymentIntentId: null,
      idempotencyKey: i.idempotencyKey,
      version: 1,
      createdAtMs: nowMs,
      issuedAtMs: null,
      deliveredAtMs: null,
    };
    const ins = await d.store.insertCard(record, []);
    let card = ins.card;
    const three = requiresThreeDs(card.amount, i.isNewCard);
    if (card.paymentIntentId !== null) {
      return { kind: "ok", card: cardView(card), paymentIntentId: card.paymentIntentId, clientAction: "none", requiresThreeDs: three, replayed: true };
    }
    const intent = await d.payments.create({
      referenceType: "gift_card",
      referenceId: card.id,
      userId: i.userId,
      amount: card.amount,
      method: i.paymentMethod,
      requireThreeDs: three,
      idempotencyKey: `gift-card:${card.id}`,
    });
    const upd = await d.store.updateCard(card.id, card.version, { paymentIntentId: intent.paymentIntentId }, []);
    if (upd.kind === "ok") card = upd.card;
    return {
      kind: "ok",
      card: cardView(card),
      paymentIntentId: intent.paymentIntentId,
      clientAction: intent.clientAction,
      requiresThreeDs: three,
      replayed: ins.kind === "duplicate",
    };
  }
}

/** Step 2: payment webhook (or checkout consumer). Idempotent; never gated by the sales switch because money moved. */
export class IssueOnPayment {
  constructor(private readonly d: GiftCardDeps) {}

  async execute(input: { readonly cardId: string; readonly paymentIntentId: string }): Promise<IssueResult | { readonly kind: "intent_mismatch" }> {
    const card = await this.d.store.getCard(input.cardId);
    if (card === null) return { kind: "not_found" };
    if (card.paymentIntentId !== null && card.paymentIntentId !== input.paymentIntentId) return { kind: "intent_mismatch" };
    if (card.status !== "PENDING_PAYMENT") return { kind: "replayed", card };
    return issueCard(this.d, card, "PAYMENT_SUCCEEDED");
  }
}

/** Payment failed or timed out: PENDING_PAYMENT -> CANCELLED (compensation: the intent is voided). */
export class CancelUnpaidCard {
  constructor(private readonly d: GiftCardDeps) {}

  async execute(cardId: string): Promise<"cancelled" | "not_found" | "not_pending"> {
    const card = await this.d.store.getCard(cardId);
    if (card === null) return "not_found";
    if (card.status !== "PENDING_PAYMENT") return "not_pending";
    if (card.paymentIntentId !== null) await this.d.payments.cancel(card.paymentIntentId);
    const to = next(card.status, "PAYMENT_FAILED", { nowMs: this.d.clock.nowMs(), expiresAtMs: null });
    await this.d.store.updateCard(card.id, card.version, { status: to }, []);
    return "cancelled";
  }
}

/** Delivery provider callback for a scheduled send. */
export class ConfirmDelivered {
  constructor(private readonly d: GiftCardDeps) {}
  async execute(cardId: string): Promise<CardView | null> {
    const c = await this.d.store.getCard(cardId);
    return c === null ? null : cardView(await markDelivered(this.d, c));
  }
}

export type VoidResult =
  | { readonly kind: "ok"; readonly card: CardView; readonly refundedAmount: bigint; readonly refund: "completed" | "pending" }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_voidable" }
  | { readonly kind: "conflict" };

/** Purchaser voids before DELIVERED. Only what is still unredeemed is refunded, to the original method. */
export class VoidGiftCard {
  constructor(private readonly d: GiftCardDeps) {}

  async execute(input: { readonly userId: string; readonly cardId: string }): Promise<VoidResult> {
    const d = this.d;
    const card = await d.store.getCard(input.cardId);
    if (card === null || card.purchaserId !== input.userId) return { kind: "not_found" };
    if (!canVoid(card.status)) return { kind: "not_voidable" };
    const nowMs = d.clock.nowMs();
    const to = next(card.status, "VOID", { nowMs, expiresAtMs: card.expiresAtMs });
    const r = await d.store.updateCard(card.id, card.version, { status: to }, [
      cardEvent(card, "gift_card.voided", { refund_amount: Number(card.remaining), payment_intent_id: card.paymentIntentId }),
    ]);
    if (r.kind === "not_found") return { kind: "not_found" };
    if (r.kind === "conflict") return { kind: "conflict" };
    await d.audit.record({ action: "gift_card.voided", actorId: input.userId, targetId: card.id, outcome: "ok", deviceHash: null, ipHash: null, atMs: nowMs });
    let refund: "completed" | "pending" = "pending";
    if (card.paymentIntentId !== null && card.remaining > 0n) {
      try {
        refund = (await d.payments.refund({ paymentIntentId: card.paymentIntentId, amount: card.remaining, idempotencyKey: `gift-card-void:${card.id}` })).ok
          ? "completed"
          : "pending";
      } catch {
        refund = "pending";
      }
    }
    return { kind: "ok", card: cardView(r.card), refundedAmount: card.remaining, refund };
  }
}

export class ListMyGiftCards {
  constructor(private readonly d: GiftCardDeps) {}
  async execute(userId: string, limit = 50): Promise<readonly CardView[]> {
    return (await this.d.store.listByPurchaser(userId, limit)).map(cardView);
  }
}

export class ExpireGiftCards {
  constructor(private readonly d: GiftCardDeps) {}

  /** Idempotent sweeper. The unredeemed remainder is reported, never posted as breakage before VR-F1-04. */
  async execute(limit = 200): Promise<number> {
    const d = this.d;
    const nowMs = d.clock.nowMs();
    let n = 0;
    for (const id of await d.store.listExpirable(nowMs, limit)) {
      const c = await d.store.getCard(id);
      if (c === null || c.expiresAtMs === null || c.expiresAtMs > nowMs) continue;
      if (c.status !== "ISSUED" && c.status !== "DELIVERED") continue;
      const to = next(c.status, "EXPIRE", { nowMs, expiresAtMs: c.expiresAtMs });
      const r = await d.store.updateCard(c.id, c.version, { status: to }, [cardEvent(c, "gift_card.expired", { forfeited: Number(c.remaining) })]);
      if (r.kind === "ok") {
        n += 1;
        await d.audit.record({ action: "gift_card.expired", actorId: null, targetId: c.id, outcome: "n/a", deviceHash: null, ipHash: null, atMs: nowMs });
      }
    }
    return n;
  }
}
