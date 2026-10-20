import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from "@nestjs/common";
import { MoneySchema, moneyToWire, type MoneyWire } from "@outlet/validation";
import { z } from "zod";
import { Authorize, AuthenticatedSelf, Idempotent, Public, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import { sha256Hex } from "../application/shared";
import type { ListMyGiftCards, PurchaseGiftCard, VoidGiftCard } from "../application/purchase";
import type { RedeemGiftCard } from "../application/redeem";
import type { ContributeToPot, CreateGiftPot, GetMyPot, GetSharedPot, PotView } from "../application/pots";
import { DELIVERY_CHANNELS, GIFT_CARD_DESIGNS, PURCHASE_PAYMENT_METHODS } from "../domain/bridge";
import type { CardView } from "../domain/ports";
import {
  CARD_RESOLVER,
  CONTRIBUTE_TO_POT,
  CREATE_GIFT_POT,
  GET_MY_POT,
  GET_SHARED_POT,
  LIST_MY_GIFT_CARDS,
  POT_RESOLVER,
  PURCHASE_GIFT_CARD,
  REDEEM_GIFT_CARD,
  VOID_GIFT_CARD,
} from "./tokens";

const egp = (amount: bigint): MoneyWire => moneyToWire({ amount, currency: "EGP" });
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

const Egp = MoneySchema.refine((m) => m.currency === "EGP", { message: "currency must be EGP" });
const IdParam = z.object({ id: z.uuid() }).strict();
const TokenParam = z.object({ token: z.string().regex(/^[0-9a-f]{32}$/) }).strict();
const Contact = z.string().min(3).max(254);
const Message = z.string().min(1).max(500);

const PurchaseBody = z
  .object({
    amount: Egp,
    design: z.enum(GIFT_CARD_DESIGNS),
    channel: z.enum(DELIVERY_CHANNELS),
    recipient_contact: Contact.optional(),
    message: Message.optional(),
    scheduled_at: z.iso.datetime({ offset: true }).optional(),
    scope_store_id: z.uuid().optional(),
    payment_method: z.enum(PURCHASE_PAYMENT_METHODS),
    is_new_card: z.boolean().default(true),
  })
  .strict();
const RedeemBody = z.object({ code: z.string().min(16).max(40), amount: Egp.optional() }).strict();
const PotBody = z
  .object({
    target: Egp,
    closes_at: z.iso.datetime({ offset: true }),
    organiser_nickname: z.string().min(1).max(40),
    design: z.enum(GIFT_CARD_DESIGNS),
    channel: z.enum(DELIVERY_CHANNELS),
    recipient_contact: Contact.optional(),
    message: Message.optional(),
  })
  .strict();
const ContributeBody = z
  .object({
    share_token: z.string().regex(/^[0-9a-f]{32}$/),
    amount: Egp,
    payment_method: z.enum(PURCHASE_PAYMENT_METHODS),
    is_new_card: z.boolean().default(true),
  })
  .strict();

const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};
const requireKey = (req: ApiRequest): string => {
  const k = headerValue(req, "idempotency-key");
  if (k === undefined) throw Problems.invalidIdempotencyKey();
  return k;
};
const problem = (status: number, slug: string, title: string, code: string) => new ProblemError(status, slug, title, { code });
const disabled = (): ProblemError => Problems.unavailable("feature_disabled");
const noStore = (res: ApiResponse): void => res.setHeader("Cache-Control", "no-store");

export function cardWire(c: CardView) {
  return {
    id: c.id,
    status: c.status,
    amount: egp(c.amount),
    remaining: egp(c.remaining),
    redemption: c.redemption,
    last4: c.last4,
    expires_at: iso(c.expiresAtMs),
    design: c.design,
    scope_store_id: c.scopeStoreId,
    pot_id: c.potId,
    created_at: iso(c.createdAtMs),
  };
}

export function potWire(p: PotView) {
  return {
    id: p.id,
    status: p.status,
    target: egp(p.target),
    raised: egp(p.raised),
    closes_at: iso(p.closesAtMs),
    organiser_nickname: p.organiserNickname,
    contributions: p.contributions,
  };
}

const amountViolation = (field: string, code: string) => Problems.validation([{ pointer: `/body/${field}`, code }]);

/** Device identity for throttling: the attested device id header, else the network address. Stored hashed only. */
const deviceOf = (req: ApiRequest): { deviceHash: string; ipHash: string } => {
  const ip = req.ip ?? "unknown";
  const device = headerValue(req, "x-device-id") ?? `ip:${ip}`;
  return { deviceHash: sha256Hex(`gift-card-device:${device}`), ipHash: sha256Hex(`gift-card-ip:${ip}`) };
};

@Controller()
export class GiftCardsController {
  constructor(
    @Inject(PURCHASE_GIFT_CARD) private readonly purchase: PurchaseGiftCard,
    @Inject(REDEEM_GIFT_CARD) private readonly redeem: RedeemGiftCard,
    @Inject(VOID_GIFT_CARD) private readonly voidCard: VoidGiftCard,
    @Inject(LIST_MY_GIFT_CARDS) private readonly list: ListMyGiftCards,
    @Inject(CREATE_GIFT_POT) private readonly createPot: CreateGiftPot,
    @Inject(CONTRIBUTE_TO_POT) private readonly contribute: ContributeToPot,
    @Inject(GET_SHARED_POT) private readonly sharedPot: GetSharedPot,
    @Inject(GET_MY_POT) private readonly myPot: GetMyPot,
  ) {}

  @Post("gift-cards")
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 5, windowSeconds: 3600 }])
  async buy(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse, @Body(new ZodPipe(PurchaseBody)) b: z.output<typeof PurchaseBody>) {
    noStore(res);
    const r = await this.purchase.execute({
      userId: principalOf(req).actor.id,
      idempotencyKey: requireKey(req),
      amount: b.amount.amount,
      design: b.design,
      channel: b.channel,
      contact: b.recipient_contact ?? null,
      message: b.message ?? null,
      scheduledAtMs: b.scheduled_at === undefined ? null : Date.parse(b.scheduled_at),
      scopeStoreId: b.scope_store_id ?? null,
      paymentMethod: b.payment_method,
      isNewCard: b.is_new_card,
    });
    switch (r.kind) {
      case "ok":
        return {
          card: cardWire(r.card),
          payment: { intent_id: r.paymentIntentId, client_action: r.clientAction, requires_3ds: r.requiresThreeDs },
        };
      case "disabled":
        throw disabled();
      case "method_refused":
        throw problem(422, "payment-method-refused", "That payment method cannot buy a gift card", "payment_method_refused");
      case "invalid_amount":
        throw amountViolation("amount", r.reason);
      case "invalid_message":
        throw amountViolation("message", "message_not_allowed");
      case "invalid_schedule":
        throw amountViolation("scheduled_at", "invalid_schedule");
      case "age_required":
        throw problem(403, "age-requirement", "This purchase requires an account holder aged 21 or over", "age_requirement");
    }
  }

  @Post("gift-cards/redeem")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 3600 }])
  async redeemCode(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse, @Body(new ZodPipe(RedeemBody)) b: z.output<typeof RedeemBody>) {
    noStore(res);
    const r = await this.redeem.execute({
      userId: principalOf(req).actor.id,
      rawCode: b.code,
      amount: b.amount === undefined ? null : b.amount.amount,
      ...deviceOf(req),
    });
    switch (r.kind) {
      case "ok":
        return {
          redeemed: egp(r.redeemed),
          credit: { sub_balance: "gift_card", journal_entry_id: r.journalEntryId },
          card: cardWire(r.card),
        };
      case "disabled":
        throw disabled();
      case "throttled":
        throw Problems.rateLimited(r.retryAfterMs / 1000);
      case "invalid_code":
        throw problem(404, "invalid-code", "That code is not valid", "invalid_code");
      case "already_redeemed":
        throw problem(409, "already-redeemed", "That gift card has already been used in full", "already_redeemed");
      case "unavailable":
        throw problem(409, "card-unavailable", "That gift card can no longer be used", "card_unavailable");
      case "exceeds_balance":
        throw problem(422, "exceeds-balance", "The amount is more than the remaining balance", "exceeds_balance");
      case "invalid_amount":
        throw amountViolation("amount", "invalid_amount");
      case "credit_unavailable":
        throw Problems.unavailable("credit_unavailable");
      case "processing":
        // outcome unknown: the card debit is durable and the credit resumes under the same key
        return { status: "processing", redemption_id: r.redemptionId };
    }
  }

  @Get("me/gift-cards")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async mine(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    noStore(res);
    const cards = await this.list.execute(principalOf(req).actor.id);
    return { items: cards.map(cardWire) };
  }

  @Post("gift-cards/:id/void")
  @HttpCode(200)
  @Authorize({ action: "update", resourceType: "gift_card", resolver: CARD_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 3600 }])
  async voidOne(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    const r = await this.voidCard.execute({ userId: principalOf(req).actor.id, cardId: p.id });
    switch (r.kind) {
      case "ok":
        return { card: cardWire(r.card), refund: { amount: egp(r.refundedAmount), status: r.refund } };
      case "not_found":
        throw Problems.notFound();
      case "not_voidable":
        throw problem(409, "not-voidable", "That gift card can no longer be voided", "not_voidable");
      case "conflict":
        throw problem(409, "card-conflict", "The gift card changed; reload and retry", "card_conflict");
    }
  }

  @Post("gift-pots")
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 3600 }])
  async openPot(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse, @Body(new ZodPipe(PotBody)) b: z.output<typeof PotBody>) {
    noStore(res);
    const r = await this.createPot.execute({
      userId: principalOf(req).actor.id,
      idempotencyKey: requireKey(req),
      target: b.target.amount,
      closesAtMs: Date.parse(b.closes_at),
      nickname: b.organiser_nickname,
      design: b.design,
      channel: b.channel,
      contact: b.recipient_contact ?? null,
      message: b.message ?? null,
    });
    switch (r.kind) {
      case "ok":
        return { pot: potWire(r.pot), share_token: r.shareToken };
      case "disabled":
        throw disabled();
      case "invalid_amount":
        throw amountViolation("target", r.reason);
      case "invalid_closing_date":
        throw amountViolation("closes_at", "invalid_closing_date");
      case "invalid_message":
        throw amountViolation("message", "message_not_allowed");
      case "age_required":
        throw problem(403, "age-requirement", "This purchase requires an account holder aged 21 or over", "age_requirement");
    }
  }

  @Get("gift-pots/:id")
  @Authorize({ action: "read", resourceType: "gift_card", resolver: POT_RESOLVER, idParam: "id" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async pot(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    noStore(res);
    const v = await this.myPot.execute(principalOf(req).actor.id, p.id);
    if (v === null) throw Problems.notFound();
    return potWire(v);
  }

  @Post("gift-pots/:id/contribute")
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 3600 }])
  async give(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>,
    @Body(new ZodPipe(ContributeBody)) b: z.output<typeof ContributeBody>,
  ) {
    noStore(res);
    const r = await this.contribute.execute({
      userId: principalOf(req).actor.id,
      potId: p.id,
      shareToken: b.share_token,
      amount: b.amount.amount,
      paymentMethod: b.payment_method,
      isNewCard: b.is_new_card,
      idempotencyKey: requireKey(req),
    });
    switch (r.kind) {
      case "ok":
        return {
          contribution_id: r.contributionId,
          payment: { intent_id: r.paymentIntentId, client_action: r.clientAction, requires_3ds: r.requiresThreeDs },
        };
      case "disabled":
        throw disabled();
      case "not_found":
        throw Problems.notFound();
      case "closed":
        throw problem(409, "pot-closed", "This gift pot is closed", "pot_closed");
      case "method_refused":
        throw problem(422, "payment-method-refused", "That payment method cannot be used for a gift", "payment_method_refused");
      case "invalid_amount":
        throw amountViolation("amount", r.reason);
    }
  }

  @Get("shared/gift-pots/:token")
  @Public()
  @RateLimit([{ dimension: "ip", limit: 20, windowSeconds: 60 }])
  async shared(@Res({ passthrough: true }) res: ApiResponse, @Param(new ZodPipe(TokenParam, "/params")) p: z.infer<typeof TokenParam>) {
    res.setHeader("Cache-Control", "no-store");
    const v = await this.sharedPot.execute(p.token);
    if (v === null) throw Problems.notFound();
    return potWire(v);
  }
}
