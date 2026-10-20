import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { Authorize, AuthenticatedSelf, Idempotent, Public, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { PlaceCheckout, CommitResult } from "../application/commit";
import type { CancelCheckout, ConfirmCodOrder, GetCheckoutStatus, LifecycleResult } from "../application/lifecycle";
import type { HandlePaymentWebhook } from "../application/payment-events";
import type { QuoteCheckout } from "../application/quote";
import { CHECKOUT_METHODS } from "../domain/bridge";
import type { CodConfirmationPort } from "../domain/ports";
import {
  CHECKOUT_CANCEL,
  CHECKOUT_CONFIRM_COD,
  CHECKOUT_CONTEXT,
  CHECKOUT_PLACE,
  CHECKOUT_QUOTE,
  CHECKOUT_RESOLVER,
  CHECKOUT_STATUS,
  CHECKOUT_WEBHOOK,
} from "./tokens";
import { quoteWire, sagaWire } from "./wire";
import type { CheckoutContext } from "../application/context";

const Uuid = z.uuid();
const IdParam = z.object({ id: Uuid }).strict();
const ProviderParam = z.object({ provider: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/) }).strict();
const Code = z.string().trim().min(1).max(64);
const Piastres = z.string().regex(/^\d{1,15}$/);

const QuoteBody = z
  .object({
    method: z.enum(CHECKOUT_METHODS),
    address_id: Uuid.nullable().optional(),
    voucher_codes: z.array(Code).max(5).default([]),
    use_store_credit: z.boolean().default(true),
    price_lock: z.string().max(4096).nullable().optional(),
  })
  .strict();
const CommitBody = QuoteBody.extend({
  address_id: Uuid,
  expected_total: Piastres.nullable().optional(),
  admission_token: z.string().min(20).max(2048).nullable().optional(),
}).strict();
const ConfirmBody = z.object({ code: z.string().trim().min(4).max(12) }).strict();

const conflict = (slug: string, title: string, code: string, extensions?: Record<string, string | number | boolean | null>) =>
  new ProblemError(409, slug, title, { code, ...(extensions !== undefined ? { extensions } : {}) });

function principalOf(req: ApiRequest) {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
}

function requireKey(req: ApiRequest): string {
  const k = headerValue(req, "idempotency-key");
  if (k === undefined) throw Problems.invalidIdempotencyKey();
  return k;
}

function lifecycle(r: LifecycleResult) {
  switch (r.kind) {
    case "ok":
      return sagaWire(r.record);
    case "not_found":
      throw Problems.notFound();
    case "not_cancellable":
      throw conflict("not-cancellable", "The checkout can no longer be changed", "not_cancellable");
  }
}

/** Maps a commit outcome to the wire. Pure data in, problem or body out. */
function commitWire(r: CommitResult) {
  switch (r.kind) {
    case "ok":
      return { ...sagaWire(r.record, r.clientAction), state: r.state };
    case "app_attest_required":
      throw Problems.forbidden("app_attest_required");
    case "key_reuse":
      throw Problems.idempotencyKeyReuse();
    case "admission_required":
      throw conflict("admission-required", "This drop needs a waiting-room admission", "admission_required");
    case "admission_invalid":
      throw Problems.forbidden("admission_invalid");
    case "admission_used":
      throw conflict("admission-used", "This admission was already used", "admission_used");
    case "address_required":
      throw Problems.validation([{ pointer: "/body/address_id", code: "required" }]);
    case "address_not_found":
      throw Problems.notFound();
    case "address_not_covered":
      throw conflict("address-not-covered", "Delivery is not available at this address", "address_not_covered");
    case "bag_empty":
      throw conflict("bag-empty", "There is nothing available to buy in the bag", "bag_empty");
    case "method_unavailable":
      throw conflict("method-unavailable", "This payment method is not available for this order", "method_unavailable", {
        reason: r.reason,
      });
    case "price_changed":
      throw conflict("price-changed", "The price changed; review the new total", "price_changed", {
        expected_total: r.expected.toString(),
        actual_total: r.actual.toString(),
        delta: r.delta.toString(),
        price_lock: r.fresh.lockToken,
      });
    case "insufficient_stock":
      throw new ProblemError(409, "insufficient-stock", "Some items are no longer available in the requested quantity", {
        code: "insufficient_stock",
        errors: r.shortfalls.map((s) => ({ pointer: `/skus/${s.skuId}`, code: "insufficient_stock" })),
      });
    case "payment_unavailable":
      throw new ProblemError(502, "payment-unavailable", "The payment provider could not start this payment", {
        code: "payment_unavailable",
      });
    case "failed":
      throw conflict("checkout-failed", "The checkout could not be completed", "checkout_failed", { reason: r.reason });
  }
}

@Controller("checkout")
export class CheckoutController {
  constructor(
    @Inject(CHECKOUT_QUOTE) private readonly quote: QuoteCheckout,
    @Inject(CHECKOUT_PLACE) private readonly place: PlaceCheckout,
    @Inject(CHECKOUT_STATUS) private readonly status: GetCheckoutStatus,
    @Inject(CHECKOUT_CANCEL) private readonly cancelUc: CancelCheckout,
    @Inject(CHECKOUT_CONFIRM_COD) private readonly confirmUc: ConfirmCodOrder,
    @Inject(CHECKOUT_CONTEXT) private readonly ctx: CheckoutContext,
  ) {}

  /** Pure: no side effects (spec 7). Every fee is on this first render. */
  @Post("quote")
  @HttpCode(200)
  @AuthenticatedSelf("buyer_api")
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async quoteRoute(@Req() req: ApiRequest, @Body(new ZodPipe(QuoteBody)) body: z.infer<typeof QuoteBody>) {
    const r = await this.quote.execute({
      userId: principalOf(req).actor.id,
      deviceId: headerValue(req, "x-device-id") ?? null,
      method: body.method,
      addressId: body.address_id ?? null,
      codes: body.voucher_codes,
      useStoreCredit: body.use_store_credit,
      priceLock: body.price_lock ?? null,
    });
    switch (r.kind) {
      case "ok":
        return quoteWire(r);
      case "bag_empty":
        throw conflict("bag-empty", "There is nothing available to buy in the bag", "bag_empty");
      case "method_unavailable":
        throw conflict("method-unavailable", "This payment method is not available for this order", "method_unavailable", {
          reason: r.reason,
        });
      case "address_not_found":
        throw Problems.notFound();
      case "address_not_covered":
        throw conflict("address-not-covered", "Delivery is not available at this address", "address_not_covered");
    }
  }

  /** Commit. Rate limits per user, device and IP (API6); App Attest enforced by the flag in the use case. */
  @Post()
  @HttpCode(200)
  @AuthenticatedSelf("buyer_api")
  @Idempotent({ required: true })
  @RateLimit([
    { dimension: "user", limit: 5, windowSeconds: 60 },
    { dimension: "device", limit: 10, windowSeconds: 60 },
    { dimension: "ip", limit: 20, windowSeconds: 60 },
  ])
  async commit(@Req() req: ApiRequest, @Body(new ZodPipe(CommitBody)) body: z.infer<typeof CommitBody>) {
    const r = await this.place.execute({
      userId: principalOf(req).actor.id,
      deviceId: headerValue(req, "x-device-id") ?? null,
      idempotencyKey: requireKey(req),
      method: body.method,
      addressId: body.address_id,
      codes: body.voucher_codes,
      useStoreCredit: body.use_store_credit,
      priceLock: body.price_lock ?? null,
      expectedTotal: body.expected_total === undefined || body.expected_total === null ? null : BigInt(body.expected_total),
      appAttestAssertion: headerValue(req, "x-app-attest") ?? null,
      admissionToken: body.admission_token ?? null,
    });
    return commitWire(r);
  }

  @Get(":id")
  @Authorize({ action: "read", resourceType: "order", resolver: CHECKOUT_RESOLVER, idParam: "id" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async state(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>) {
    const rec = await this.status.execute({ orderGroupId: params.id, userId: principalOf(req).actor.id });
    if (rec === null) throw Problems.notFound();
    return sagaWire(rec);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @Authorize({ action: "update", resourceType: "order", resolver: CHECKOUT_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async cancel(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>) {
    return lifecycle(await this.cancelUc.execute({ orderGroupId: params.id, userId: principalOf(req).actor.id }));
  }

  @Post(":id/confirm-cod")
  @HttpCode(200)
  @Authorize({ action: "update", resourceType: "order", resolver: CHECKOUT_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 5, windowSeconds: 60 }])
  async confirmCod(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>,
    @Body(new ZodPipe(ConfirmBody)) body: z.infer<typeof ConfirmBody>,
  ) {
    const userId = principalOf(req).actor.id;
    const verified = await (this.ctx.codConfirmation as CodConfirmationPort).verify({
      userId,
      orderGroupId: params.id,
      code: body.code,
    });
    if (!verified) throw new ProblemError(422, "invalid-confirmation-code", "The confirmation code is not valid", { code: "invalid_confirmation_code" });
    return lifecycle(await this.confirmUc.execute({ orderGroupId: params.id, userId, confirmed: true }));
  }
}

/**
 * Provider events. Public by nature: authenticity is the provider adapter's HMAC over the RAW body,
 * a timestamp window, and dedup on the provider event id. Needs `rawBody: true` at app creation;
 * without it the route fails closed.
 */
@Controller("webhooks/checkout")
export class CheckoutWebhookController {
  constructor(@Inject(CHECKOUT_WEBHOOK) private readonly webhook: HandlePaymentWebhook) {}

  @Post(":provider")
  @HttpCode(200)
  @Public()
  @RateLimit([{ dimension: "ip", limit: 600, windowSeconds: 60 }])
  async receive(
    @Req() req: ApiRequest & { rawBody?: Buffer },
    @Param(new ZodPipe(ProviderParam, "/params")) params: z.infer<typeof ProviderParam>,
  ) {
    if (req.rawBody === undefined) throw Problems.unavailable("raw_body_unavailable");
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    const r = await this.webhook.execute({
      provider: params.provider,
      rawBody: req.rawBody.toString("utf8"),
      headers,
    });
    if (r.kind === "rejected") {
      if (r.reason === "unknown_provider") throw Problems.notFound();
      if (r.reason === "amount_mismatch") return { status: "recorded" }; // stored for Ops; the PSP must not retry
      throw new ProblemError(400, "webhook-rejected", "Webhook could not be verified", { code: r.reason });
    }
    return { status: "ok" };
  }
}
