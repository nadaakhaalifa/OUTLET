import { normalizeCode } from "../domain/bridge";
import { StoreCreditRejectedError, type CardRecord, type CardView, type RedemptionRecord } from "../domain/ports";
import { cardEvent, cardView, findCardByCode, type GiftCardDeps } from "./shared";

export interface RedeemInput {
  readonly userId: string;
  readonly rawCode: string;
  /** Piastres; null redeems the whole remaining balance. */
  readonly amount: bigint | null;
  readonly deviceHash: string;
  readonly ipHash: string;
}

export type RedeemResult =
  | {
      readonly kind: "ok";
      readonly redeemed: bigint;
      readonly card: CardView;
      readonly journalEntryId: string;
    }
  | { readonly kind: "disabled" }
  | { readonly kind: "throttled"; readonly retryAfterMs: number; readonly scope: "account" | "device" | "ip" }
  /** Wrong format, unknown code and a hash that matches nothing are indistinguishable on purpose. */
  | { readonly kind: "invalid_code" }
  | { readonly kind: "already_redeemed" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "exceeds_balance"; readonly remaining: bigint }
  | { readonly kind: "invalid_amount" }
  /** Definite refusal by store credit; the card balance was restored exactly once. */
  | { readonly kind: "credit_unavailable" }
  /** Outcome unknown: the redemption stays PENDING and converges by resume with the same key. */
  | { readonly kind: "processing"; readonly redemptionId: string };

export type SettleOutcome =
  | { readonly kind: "completed"; readonly journalEntryId: string }
  | { readonly kind: "reversed" }
  | { readonly kind: "pending" };

export const redemptionKey = (redemptionId: string): string => `gift-card-redemption:${redemptionId}`;

/**
 * Two-phase settle of a PENDING redemption (the debit on the card is already durable). Calls the
 * idempotent credit with the redemption's own key. Reverses the card ONLY on a typed definite
 * rejection; a timeout or any unknown error leaves it pending so a retry converges to one credit.
 */
export async function settleRedemption(d: GiftCardDeps, red: RedemptionRecord, card: CardRecord): Promise<SettleOutcome> {
  let journalEntryId: string;
  try {
    const posted = await d.storeCredit.creditGiftCard({
      userId: red.userId,
      cardId: red.cardId,
      amount: red.amount,
      expiresAtMs: card.expiresAtMs ?? d.clock.nowMs(),
      scopeStoreId: card.scopeStoreId,
      idempotencyKey: redemptionKey(red.id),
    });
    journalEntryId = posted.journalEntryId;
  } catch (e) {
    if (e instanceof StoreCreditRejectedError) {
      await d.store.reverseRedemption(red.id);
      return { kind: "reversed" };
    }
    return { kind: "pending" };
  }
  try {
    await d.store.completeRedemption(red.id, journalEntryId, d.clock.nowMs(), [
      cardEvent(card, "gift_card.redeemed", {
        redemption_id: red.id,
        redeemed: Number(red.amount),
        remaining: Number(card.remaining),
        full: card.remaining === 0n,
      }),
    ]);
  } catch {
    return { kind: "pending" };
  }
  return { kind: "completed", journalEntryId };
}

/** Resume sweeper: re-calls the credit with the same key for redemptions stuck PENDING. */
export class ResumePendingRedemptions {
  constructor(private readonly d: GiftCardDeps) {}

  async execute(input: { readonly minAgeMs?: number; readonly limit?: number } = {}): Promise<{
    readonly completed: number;
    readonly reversed: number;
    readonly stillPending: number;
  }> {
    const d = this.d;
    const cutoff = d.clock.nowMs() - (input.minAgeMs ?? 30_000);
    let completed = 0;
    let reversed = 0;
    let stillPending = 0;
    for (const red of await d.store.listPendingRedemptions(cutoff, input.limit ?? 100)) {
      const card = await d.store.getCard(red.cardId);
      if (card === null) {
        stillPending += 1;
        continue;
      }
      const r = await settleRedemption(d, red, card);
      if (r.kind === "completed") completed += 1;
      else if (r.kind === "reversed") reversed += 1;
      else stillPending += 1;
    }
    return { completed, reversed, stillPending };
  }
}



/**
 * Redemption: atomic throttle admit -> lookup by HMAC -> row-locked decrement recorded PENDING with
 * its key BEFORE crediting -> idempotent credit -> complete. The card is reversed only on a typed
 * definite rejection; an unknown outcome stays PENDING and is resumed under the same key, so the
 * shopper can never hold both the credit and the card balance. No code is ever written.
 */
export class RedeemGiftCard {
  constructor(private readonly d: GiftCardDeps) {}

  private async audit(i: RedeemInput, outcome: "ok" | "wrong" | "throttled", targetId: string | null, nowMs: number): Promise<void> {
    await this.d.audit.record({
      action: "gift_card.redeem_attempt",
      actorId: i.userId,
      targetId,
      outcome,
      deviceHash: i.deviceHash,
      ipHash: i.ipHash,
      atMs: nowMs,
    });
  }

  async execute(i: RedeemInput): Promise<RedeemResult> {
    const d = this.d;
    if (!(await d.flags.redemptionEnabled())) return { kind: "disabled" };
    const nowMs = d.clock.nowMs();
    const attemptId = d.ids.uuidV7();
    const admit = await d.store.admitAttempt({
      id: attemptId,
      accountId: i.userId,
      deviceHash: i.deviceHash,
      ipHash: i.ipHash,
      atMs: nowMs,
    });
    if (!admit.allowed) {
      await this.audit(i, "throttled", null, nowMs);
      return { kind: "throttled", retryAfterMs: admit.retryAfterMs, scope: admit.scope };
    }
    const wrong = async (targetId: string | null): Promise<void> => {
      await d.store.finalizeAttempt(attemptId, "wrong");
      await d.audit.record({
        action: "gift_card.redeem_attempt",
        actorId: i.userId,
        targetId,
        outcome: "wrong",
        deviceHash: i.deviceHash,
        ipHash: i.ipHash,
        atMs: nowMs,
      });
    };
    const right = async (cardId: string): Promise<void> => {
      await d.store.finalizeAttempt(attemptId, "ok");
      await d.audit.record({
        action: "gift_card.redeem_attempt",
        actorId: i.userId,
        targetId: cardId,
        outcome: "ok",
        deviceHash: i.deviceHash,
        ipHash: i.ipHash,
        atMs: nowMs,
      });
    };
    if (i.amount !== null && i.amount <= 0n) {
      await d.store.finalizeAttempt(attemptId, "ok");
      return { kind: "invalid_amount" };
    }

    const canonical = normalizeCode(i.rawCode);
    const card = canonical === null ? null : await findCardByCode(d, canonical);
    if (card === null) {
      await wrong(null);
      return { kind: "invalid_code" };
    }

    const begin = await d.store.beginRedemption({
      cardId: card.id,
      userId: i.userId,
      requested: i.amount,
      redemptionId: d.ids.uuidV7(),
      nowMs,
    });
    switch (begin.kind) {
      case "not_found":
        await wrong(null);
        return { kind: "invalid_code" };
      case "empty":
        await wrong(card.id);
        return { kind: "already_redeemed" };
      case "unavailable":
        await wrong(card.id);
        return { kind: begin.status === "REDEEMED" ? "already_redeemed" : "unavailable" };
      case "exceeds_balance":
        await right(card.id);
        return { kind: "exceeds_balance", remaining: begin.remaining };
      case "ok":
        break;
    }

    await right(card.id);
    const { redemption } = begin;
    const settled = await settleRedemption(d, redemption, begin.card);
    if (settled.kind === "reversed") return { kind: "credit_unavailable" };
    if (settled.kind === "pending") return { kind: "processing", redemptionId: redemption.id };
    await d.audit.record({
      action: "gift_card.redeemed",
      actorId: i.userId,
      targetId: card.id,
      outcome: "ok",
      deviceHash: i.deviceHash,
      ipHash: i.ipHash,
      atMs: nowMs,
    });
    return { kind: "ok", redeemed: redemption.amount, card: cardView(begin.card), journalEntryId: settled.journalEntryId };
  }
}
