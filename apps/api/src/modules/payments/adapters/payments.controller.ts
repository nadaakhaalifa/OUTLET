import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { AuthenticatedSelf, Public, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type {
  DeleteSavedCard,
  ListPaymentMethods,
  ListSavedCards,
  ReceiveWebhook,
} from "../application/payments";
import { AvailabilityQuerySchema, IdParamSchema } from "../domain/schemas";
import { PAYMENT_DELETE_CARD, PAYMENT_LIST_CARDS, PAYMENT_LIST_METHODS, PAYMENT_RECEIVE_WEBHOOK } from "./tokens";

const ProviderParam = z.object({ provider: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/) }).strict();
const IdParam = z.object({ id: IdParamSchema }).strict();

function userIdOf(req: ApiRequest): string {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p.actor.id;
}

/** Express request with the raw bytes Nest keeps when the app is created with `rawBody: true`. */
type RawBodyRequest = ApiRequest & { readonly rawBody?: Buffer | Uint8Array };

function lowerHeaders(h: ApiRequest["headers"]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return out;
}

// --------------------------------------------------------------------------- webhooks

/**
 * `POST /v1/webhooks/{provider}`. Authenticated by the PSP's MAC, not by a user token. The handler
 * stores the raw event durably (outbox row in the same transaction) and answers 200; processing is
 * asynchronous. A rejected signature is still answered 200 after storing the evidence, so a
 * misconfigured or hostile sender cannot make a PSP retry-storm (spec 7).
 */
@Controller("webhooks")
export class PaymentWebhooksController {
  constructor(@Inject(PAYMENT_RECEIVE_WEBHOOK) private readonly receive: ReceiveWebhook) {}

  @Post(":provider")
  @HttpCode(200)
  @Public()
  @RateLimit([{ dimension: "ip", limit: 600, windowSeconds: 60 }], "open")
  async receiveWebhook(
    @Req() req: RawBodyRequest,
    @Param(new ZodPipe(ProviderParam, "/params")) params: z.infer<typeof ProviderParam>,
  ) {
    const raw = req.rawBody;
    // Without the raw bytes the MAC cannot be checked: answer 500 so the PSP retries, never store as authentic.
    if (raw === undefined) throw Problems.internal();
    const r = await this.receive.execute({
      provider: params.provider,
      rawBody: raw,
      headers: lowerHeaders(req.headers),
      ip: req.ip,
    });
    switch (r.kind) {
      case "unknown_provider":
        throw Problems.notFound();
      case "ip_denied":
        throw Problems.forbidden("ip_not_allowed");
      case "too_large":
        throw new ProblemError(413, "payload-too-large", "Request body too large", { code: "payload_too_large" });
      case "accepted":
        return { received: true };
    }
  }
}

// --------------------------------------------------------------------------- shopper

@Controller()
export class PaymentsController {
  constructor(
    @Inject(PAYMENT_LIST_METHODS) private readonly methods: ListPaymentMethods,
    @Inject(PAYMENT_LIST_CARDS) private readonly cards: ListSavedCards,
    @Inject(PAYMENT_DELETE_CARD) private readonly deleteCard: DeleteSavedCard,
  ) {}

  @Get("payments/methods")
  @AuthenticatedSelf("buyer_api")
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async availability(@Req() req: ApiRequest, @Query(new ZodPipe(AvailabilityQuerySchema, "/query")) q: z.output<typeof AvailabilityQuerySchema>) {
    userIdOf(req);
    const list = await this.methods.execute({ containsDropSku: q.contains_drop_sku === "true" });
    return {
      methods: list.map((m) => ({
        id: m.method,
        available: m.available,
        unavailable_reason: m.reason,
        payment_window_seconds: Math.floor(m.paymentWindowMs / 1000),
        reference_expires_in_seconds: m.referenceExpiresInMs === null ? null : Math.floor(m.referenceExpiresInMs / 1000),
        stock_pool: m.stockPool,
      })),
    };
  }

  @Get("me/payment-methods")
  @AuthenticatedSelf("buyer_api")
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async mine(@Req() req: ApiRequest) {
    const cards = await this.cards.execute(userIdOf(req));
    // Display data only: the PSP token never leaves the server.
    return {
      items: cards.map((c) => ({ id: c.id, brand: c.brand, last4: c.last4, exp_month: c.expMonth, exp_year: c.expYear })),
    };
  }

  @Delete("me/payment-methods/:id")
  @HttpCode(204)
  @AuthenticatedSelf("buyer_api")
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async remove(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>,
  ) {
    // Owner-scoped lookup: someone else's id is indistinguishable from an unknown one (404, API1).
    const r = await this.deleteCard.execute(userIdOf(req), params.id);
    if (r === "not_found") throw Problems.notFound();
    if (r === "provider_unavailable") throw Problems.unavailable("psp_unavailable");
  }
}
