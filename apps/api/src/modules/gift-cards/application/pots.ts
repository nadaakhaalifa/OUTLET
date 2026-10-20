import {
  checkAmount,
  checkContribution,
  closeOutcome,
  isPurchaseMethod,
  next,
  paidTotal,
  potMachine,
  refundPlan,
  requiredMinimumAge,
  requiresThreeDs,
  violatesWording,
  type DeliveryChannel,
  type GiftCardDesign,
  type PotState,
} from "../domain/bridge";
import type { CardRecord, ContributionRecord, OutboxDraft, PotRecord } from "../domain/ports";
import { constantTimeEqualHex, contactAad, enc, issueCard, messageAad, sha256Hex, type GiftCardDeps } from "./shared";

const MAX_POT_HORIZON_MS = 90 * 86_400_000;

export interface PotView {
  readonly id: string;
  readonly status: PotState;
  readonly target: bigint;
  readonly raised: bigint;
  readonly closesAtMs: number;
  readonly organiserNickname: string;
  readonly contributions: number;
}

const potEvent = (p: PotRecord, extra: OutboxDraft["payload"]): OutboxDraft => ({
  type: "gift_pot.closed",
  aggregateType: "gift_pot",
  aggregateId: p.id,
  payload: { pot_id: p.id, target: Number(p.target), currency: "EGP", ...extra },
});

async function viewOf(d: GiftCardDeps, p: PotRecord): Promise<PotView> {
  const cs = await d.store.listContributions(p.id);
  return {
    id: p.id,
    status: p.status,
    target: p.target,
    raised: paidTotal(cs),
    closesAtMs: p.closesAtMs,
    organiserNickname: p.organiserNickname,
    contributions: cs.filter((c) => c.status === "paid").length,
  };
}

export type CreatePotResult =
  | { readonly kind: "ok"; readonly pot: PotView; readonly shareToken: string | null; readonly replayed: boolean }
  | { readonly kind: "disabled" }
  | { readonly kind: "invalid_amount"; readonly reason: "below_min" | "above_max" | "not_whole_egp" }
  | { readonly kind: "invalid_closing_date" }
  | { readonly kind: "invalid_message" }
  | { readonly kind: "age_required"; readonly minimumAge: 21 };

export class CreateGiftPot {
  constructor(private readonly d: GiftCardDeps) {}

  async execute(i: {
    readonly userId: string;
    readonly idempotencyKey: string;
    readonly target: bigint;
    readonly closesAtMs: number;
    readonly nickname: string;
    readonly design: GiftCardDesign;
    readonly channel: DeliveryChannel;
    readonly contact: string | null;
    readonly message: string | null;
  }): Promise<CreatePotResult> {
    const d = this.d;
    if (!(await d.flags.salesEnabled())) return { kind: "disabled" };
    const a = checkAmount(i.target);
    if (!a.ok) return { kind: "invalid_amount", reason: a.reason };
    const nowMs = d.clock.nowMs();
    if (i.closesAtMs <= nowMs || i.closesAtMs > nowMs + MAX_POT_HORIZON_MS) return { kind: "invalid_closing_date" };
    if ((i.message !== null && violatesWording(i.message)) || violatesWording(i.nickname)) return { kind: "invalid_message" };
    if (requiredMinimumAge(i.target) === 21 && !(await d.age.meetsMinimumAge(i.userId, 21))) {
      return { kind: "age_required", minimumAge: 21 };
    }
    const potId = d.ids.uuidV7();
    const cardId = d.ids.uuidV7();
    const token = Buffer.from(d.random.bytes(16)).toString("hex"); // 128 bit
    const card: CardRecord = {
      id: cardId,
      purchaserId: i.userId,
      codeHash: null,
      codeKeyVersion: null,
      last4: null,
      amount: i.target,
      remaining: i.target,
      status: "POT_OPEN",
      scopeStoreId: null,
      expiresAtMs: null,
      design: i.design,
      recipientChannel: i.channel,
      recipientContactEnc: i.contact === null ? null : await d.cipher.encrypt(enc(i.contact), contactAad(cardId)),
      messageEnc: i.message === null ? null : await d.cipher.encrypt(enc(i.message), messageAad(cardId)),
      scheduledAtMs: null,
      potId,
      paymentIntentId: null,
      idempotencyKey: i.idempotencyKey,
      version: 1,
      createdAtMs: nowMs,
      issuedAtMs: null,
      deliveredAtMs: null,
    };
    const pot: PotRecord = {
      id: potId,
      organiserId: i.userId,
      organiserNickname: i.nickname,
      target: i.target,
      closesAtMs: i.closesAtMs,
      status: "OPEN",
      cardId,
      shareTokenHash: sha256Hex(token),
      version: 1,
      createdAtMs: nowMs,
      closedAtMs: null,
    };
    const r = await d.store.insertPot(pot, card, []);
    return {
      kind: "ok",
      pot: await viewOf(d, r.pot),
      shareToken: r.kind === "created" ? token : null,
      replayed: r.kind === "duplicate",
    };
  }
}

export type ContributeResult =
  | {
      readonly kind: "ok";
      readonly contributionId: string;
      readonly paymentIntentId: string | null;
      readonly clientAction: "redirect" | "native_sheet" | "none";
      readonly requiresThreeDs: boolean;
    }
  | { readonly kind: "disabled" }
  | { readonly kind: "not_found" }
  | { readonly kind: "closed" }
  | { readonly kind: "method_refused" }
  | { readonly kind: "invalid_amount"; readonly reason: "below_min" | "exceeds_target" | "not_whole_egp" };

export class ContributeToPot {
  constructor(private readonly d: GiftCardDeps) {}

  async execute(i: {
    readonly userId: string;
    readonly potId: string;
    readonly shareToken: string;
    readonly amount: bigint;
    readonly paymentMethod: string;
    readonly isNewCard: boolean;
    readonly idempotencyKey: string;
  }): Promise<ContributeResult> {
    const d = this.d;
    if (!(await d.flags.salesEnabled())) return { kind: "disabled" };
    const pot = await d.store.getPot(i.potId);
    // the share token is the proof of invitation; a wrong token is indistinguishable from no pot
    if (pot === null || !constantTimeEqualHex(sha256Hex(i.shareToken), pot.shareTokenHash)) return { kind: "not_found" };
    const nowMs = d.clock.nowMs();
    if (pot.status !== "OPEN" || nowMs >= pot.closesAtMs) return { kind: "closed" };
    if (!isPurchaseMethod(i.paymentMethod)) return { kind: "method_refused" };
    const cs = await d.store.listContributions(pot.id);
    const committed = cs.filter((c) => c.status === "paid" || c.status === "pending" || c.status === "pending_void").reduce((s, c) => s + c.amount, 0n);
    const ok = checkContribution(pot.target, committed, i.amount);
    if (!ok.ok) return { kind: "invalid_amount", reason: ok.reason };

    const record: ContributionRecord = {
      id: d.ids.uuidV7(),
      potId: pot.id,
      userId: i.userId,
      amount: i.amount,
      paymentIntentId: null,
      status: "pending",
      idempotencyKey: i.idempotencyKey,
      createdAtMs: nowMs,
    };
    const ins = await d.store.insertContribution(record);
    const c = ins.contribution;
    const three = requiresThreeDs(c.amount, i.isNewCard);
    if (c.paymentIntentId !== null) {
      return { kind: "ok", contributionId: c.id, paymentIntentId: c.paymentIntentId, clientAction: "none", requiresThreeDs: three };
    }
    const intent = await d.payments.create({
      referenceType: "gift_pot_contribution",
      referenceId: c.id,
      userId: i.userId,
      amount: c.amount,
      method: i.paymentMethod,
      requireThreeDs: three,
      idempotencyKey: `gift-pot-contribution:${c.id}`,
    });
    await d.store.updateContribution(c.id, { status: "pending", paymentIntentId: intent.paymentIntentId }, ["pending"]);
    return { kind: "ok", contributionId: c.id, paymentIntentId: intent.paymentIntentId, clientAction: intent.clientAction, requiresThreeDs: three };
  }
}

export type ConfirmContributionResult =
  | { readonly kind: "paid"; readonly closed: "funded" | "open" }
  | { readonly kind: "refunded_late" }
  | { readonly kind: "replayed" }
  | { readonly kind: "not_found" };

/** Contribution webhook. Money that arrives after the pot closed, or that overshoots, goes straight back. */
export class ConfirmContribution {
  constructor(
    private readonly d: GiftCardDeps,
    private readonly close: ClosePot,
  ) {}

  private async refundExcess(c: ContributionRecord, paymentIntentId: string): Promise<void> {
    let ok: boolean;
    try {
      ok = (await this.d.payments.refund({ paymentIntentId, amount: c.amount, idempotencyKey: `gift-pot-refund:${c.id}` })).ok;
    } catch {
      ok = false;
    }
    await this.d.store.updateContribution(c.id, { status: ok ? "refunded" : "refund_failed", paymentIntentId });
  }

  async execute(input: { readonly contributionId: string; readonly paymentIntentId: string }): Promise<ConfirmContributionResult> {
    const d = this.d;
    const c = await d.store.getContribution(input.contributionId);
    if (c === null) return { kind: "not_found" };
    if (c.status === "refund_failed") {
      // a replayed webhook retries the (idempotent) refund of money that must go back
      await this.refundExcess(c, input.paymentIntentId);
      return { kind: "refunded_late" };
    }
    // lock the pot row and decide overshoot / closed / apply in one atomic store step
    const r = await d.store.confirmContribution(c.id, input.paymentIntentId);
    switch (r.kind) {
      case "not_found":
        return { kind: "not_found" };
      case "replayed":
        return { kind: "replayed" };
      case "excess":
        await this.refundExcess(r.contribution, input.paymentIntentId);
        return { kind: "refunded_late" };
      case "applied": {
        const outcome = await this.close.execute(c.potId);
        return { kind: "paid", closed: outcome === "funded" ? "funded" : "open" };
      }
    }
  }
}

export type CloseOutcomeResult = "funded" | "unfunded" | "stay_open" | "not_found" | "conflict";

/** Closes a pot that is funded or past its date. Safe to call repeatedly (CAS on the pot version). */
export class ClosePot {
  constructor(private readonly d: GiftCardDeps) {}

  async execute(potId: string): Promise<CloseOutcomeResult> {
    const d = this.d;
    const pot = await d.store.getPot(potId);
    if (pot === null) return "not_found";
    if (pot.status !== "OPEN") return pot.status === "CLOSED_FUNDED" ? "funded" : "unfunded";
    const nowMs = d.clock.nowMs();
    const cs = await d.store.listContributions(pot.id);
    const outcome = closeOutcome({ target: pot.target, paid: paidTotal(cs), closesAtMs: pot.closesAtMs, nowMs });
    if (outcome === "stay_open") return "stay_open";
    const card = await d.store.getCard(pot.cardId);
    if (card === null) return "not_found";

    if (outcome === "funded") {
      const to = potMachine.transition(pot.status, "CLOSE_FUNDED");
      const r = await d.store.updatePot(pot.id, pot.version, { status: to, closedAtMs: nowMs }, null, [
        potEvent(pot, { outcome: "funded", raised: Number(paidTotal(cs)) }),
      ]);
      if (r.kind !== "ok") return "conflict";
      for (const c of cs.filter((x) => x.status === "pending")) await this.voidPending(c);
      // CLOSE_POT is guarded by potFunded; the card was created POT_OPEN with the full target as face value
      await issueCard(d, card, "CLOSE_POT");
      await d.audit.record({ action: "gift_pot.closed", actorId: null, targetId: pot.id, outcome: "ok", deviceHash: null, ipHash: null, atMs: nowMs });
      return "funded";
    }

    const to = potMachine.transition(pot.status, "CLOSE_UNFUNDED");
    const cancelled = next(card.status, "CANCEL_POT", { nowMs, expiresAtMs: null });
    const r = await d.store.updatePot(
      pot.id,
      pot.version,
      { status: to, closedAtMs: nowMs },
      { patch: { status: cancelled }, events: [] },
      [potEvent(pot, { outcome: "unfunded", raised: Number(paidTotal(cs)) })],
    );
    if (r.kind !== "ok") return "conflict";
    for (const c of cs.filter((x) => x.status === "pending")) await this.voidPending(c);
    await d.audit.record({ action: "gift_pot.closed", actorId: null, targetId: pot.id, outcome: "refused", deviceHash: null, ipHash: null, atMs: nowMs });
    return "unfunded";
  }

  /**
   * Cancels one unpaid contribution. It becomes `cancelled` only when the PSP confirms the void (or
   * no intent was ever created). A captured payment is refunded; an unknown result stays
   * `pending_void` for the reconciliation sweep, so a later success webhook is still honoured.
   */
  async voidPending(c: ContributionRecord): Promise<void> {
    const from = ["pending", "pending_void"] as const;
    if (c.paymentIntentId === null) {
      await this.d.store.updateContribution(c.id, { status: "cancelled" }, from);
      return;
    }
    let res: "cancelled" | "captured" | "unknown";
    try {
      res = await this.d.payments.cancel(c.paymentIntentId);
    } catch {
      res = "unknown";
    }
    if (res === "cancelled") {
      await this.d.store.updateContribution(c.id, { status: "cancelled" }, from);
    } else if (res === "captured") {
      let ok: boolean;
      try {
        ok = (await this.d.payments.refund({ paymentIntentId: c.paymentIntentId, amount: c.amount, idempotencyKey: `gift-pot-refund:${c.id}` })).ok;
      } catch {
        ok = false;
      }
      await this.d.store.updateContribution(c.id, { status: ok ? "refunded" : "refund_failed" }, from);
    } else {
      await this.d.store.updateContribution(c.id, { status: "pending_void" }, from);
    }
  }

  /** Reconciliation: retries the cancel of contributions whose void was not confirmed. */
  async resolveVoided(limit = 100): Promise<number> {
    let n = 0;
    for (const c of await this.d.store.listContributionsInStatus("pending_void", limit)) {
      await this.voidPending(c);
      n += 1;
    }
    return n;
  }
}

/** CLOSED_UNFUNDED -> REFUNDING -> REFUNDED. Every payer gets exactly their own payment back, to the original method. */
export class RefundUnfundedPot {
  constructor(private readonly d: GiftCardDeps) {}

  async execute(potId: string): Promise<{ readonly refunded: bigint; readonly done: boolean } | null> {
    const d = this.d;
    let pot = await d.store.getPot(potId);
    if (pot === null) return null;
    if (pot.status === "CLOSED_UNFUNDED") {
      const r = await d.store.updatePot(pot.id, pot.version, { status: potMachine.transition(pot.status, "START_REFUND") }, null, []);
      if (r.kind !== "ok") return null;
      pot = r.pot;
    }
    if (pot.status !== "REFUNDING") return { refunded: 0n, done: pot.status === "REFUNDED" };
    const plan = refundPlan(await d.store.listContributions(pot.id));
    let refunded = 0n;
    let failed = 0;
    for (const c of plan.refunds) {
      if (c.paymentIntentId === null) {
        failed += 1;
        continue;
      }
      let ok: boolean;
      try {
        ok = (await d.payments.refund({ paymentIntentId: c.paymentIntentId, amount: c.amount, idempotencyKey: `gift-pot-refund:${c.id}` })).ok;
      } catch {
        ok = false;
      }
      await d.store.updateContribution(c.id, { status: ok ? "refunded" : "refund_failed" });
      if (ok) refunded += c.amount;
      else failed += 1;
    }
    if (failed > 0) return { refunded, done: false };
    const r = await d.store.updatePot(pot.id, pot.version, { status: potMachine.transition(pot.status, "REFUND_DONE") }, null, []);
    return { refunded, done: r.kind === "ok" };
  }
}

export class CloseDuePots {
  constructor(
    private readonly d: GiftCardDeps,
    private readonly close: ClosePot,
    private readonly refund: RefundUnfundedPot,
  ) {}

  async execute(limit = 100): Promise<{ readonly closed: number; readonly refundedPots: number }> {
    const nowMs = this.d.clock.nowMs();
    let closed = 0;
    await this.close.resolveVoided(limit);
    for (const id of await this.d.store.listDuePots(nowMs, limit)) {
      const r = await this.close.execute(id);
      if (r === "funded" || r === "unfunded") closed += 1;
    }
    let refundedPots = 0;
    for (const state of ["CLOSED_UNFUNDED", "REFUNDING"] as const) {
      for (const id of await this.d.store.listPotsInState(state, limit)) {
        const r = await this.refund.execute(id);
        if (r?.done === true) refundedPots += 1;
      }
    }
    return { closed, refundedPots };
  }
}

/** Public, by share token. Exposes the target, the amount raised and the organiser's nickname only. */
export class GetSharedPot {
  constructor(private readonly d: GiftCardDeps) {}
  async execute(token: string): Promise<PotView | null> {
    const pot = await this.d.store.getPotByTokenHash(sha256Hex(token));
    return pot === null ? null : viewOf(this.d, pot);
  }
}

export class GetMyPot {
  constructor(private readonly d: GiftCardDeps) {}
  async execute(userId: string, potId: string): Promise<PotView | null> {
    const pot = await this.d.store.getPot(potId);
    return pot === null || pot.organiserId !== userId ? null : viewOf(this.d, pot);
  }
}
