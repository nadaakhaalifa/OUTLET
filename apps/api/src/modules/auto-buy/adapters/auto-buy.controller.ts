import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import { moneyToWire, type MoneyWire } from "@outlet/validation";
import { z } from "zod";
import { AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { CancelAttempt, CancelMandate } from "../application/cancel";
import { CreateInputSchema, type CreateMandate } from "../application/create";
import type { ListMandates } from "../application/queries";
import { canCancelAttempt, CURRENT_MANDATE_VERSION, mandateTemplate, type TermsViolation } from "../domain/bridge";
import type { AttemptRecord, MandateRecord } from "../domain/ports";
import type { RunAutoBuySweep } from "../application/sweep";
import { CANCEL_AUTO_BUY, CANCEL_AUTO_BUY_ATTEMPT, CREATE_AUTO_BUY, LIST_AUTO_BUY, RUN_AUTO_BUY_SWEEP } from "./tokens";

const egp = (amount: bigint): MoneyWire => moneyToWire({ amount, currency: "EGP" });
const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms));

const TermsQuery = z.object({ locale: z.enum(["ar", "en"]).default("ar") }).strict();

const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();

const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};

const noStore = (res: ApiResponse): void => {
  res.setHeader("Cache-Control", "no-store");
};

const unprocessable = (code: string, title: string): ProblemError => new ProblemError(422, code.replace(/_/g, "-"), title, { code });

const POINTER: Readonly<Record<TermsViolation, string>> = {
  target_not_positive: "/body/target_price",
  target_not_below_current: "/body/target_price",
  max_below_target: "/body/max_price",
  expiry_not_in_future: "/body/expires_at",
  expiry_too_far: "/body/expires_at",
  size_invalid: "/body/size_label",
};

function attemptWire(a: AttemptRecord) {
  return {
    id: a.id,
    state: a.state,
    mode: a.mode,
    notice_sent_at: isoOrNull(a.noticeSentAtMs),
    cancel_deadline: isoOrNull(a.cancelDeadlineMs),
    cancellable: canCancelAttempt(a.state),
    failure_reason: a.failureReason,
    order_group_id: a.orderGroupId,
    created_at: iso(a.createdAtMs),
  };
}

/** The token reference and the device are never part of a response. */
function mandateWire(m: MandateRecord, latest: AttemptRecord | null, paused: boolean) {
  return {
    id: m.id,
    sku_id: m.skuId,
    size_label: m.sizeLabel,
    target_price: egp(m.targetPrice),
    max_price: egp(m.maxPrice),
    mode: m.mode,
    status: m.status,
    closed_reason: m.closedReason,
    paused: paused && m.status === "ARMED",
    payment_method: m.pspTokenRef === null ? null : ("saved_card" as const),
    expires_at: iso(m.expiresAtMs),
    accepted_at: iso(m.acceptedAtMs),
    terms_version: m.mandateVersion,
    latest_attempt: latest === null ? null : attemptWire(latest),
    created_at: iso(m.createdAtMs),
  };
}

/**
 * Every route is owner-only. Routes with an id look the object up by (id, caller): a rule that is
 * not the caller's is a 404 indistinguishable from a missing one (BOLA). Responses are `no-store`.
 * No route ever returns the PSP token reference.
 */
@Controller()
export class AutoBuyController {
  constructor(
    @Inject(CREATE_AUTO_BUY) private readonly createRule: CreateMandate,
    @Inject(LIST_AUTO_BUY) private readonly list: ListMandates,
    @Inject(CANCEL_AUTO_BUY) private readonly cancelRule: CancelMandate,
    @Inject(CANCEL_AUTO_BUY_ATTEMPT) private readonly cancelAttempt: CancelAttempt,
    @Inject(RUN_AUTO_BUY_SWEEP) private readonly sweep: RunAutoBuySweep,
  ) {}

  @Post("me/auto-buy")
  @HttpCode(201)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async create(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Body(new ZodPipe(CreateInputSchema)) b: z.infer<typeof CreateInputSchema>,
  ) {
    noStore(res);
    const p = principalOf(req);
    // Spec: biometric or passkey step-up at creation. A basic (OTP only) session is refused.
    if (p.actor.assurance !== "passkey") {
      throw new ProblemError(403, "step-up-required", "A passkey confirmation is required to create an auto-buy rule", { code: "step_up_required" });
    }
    const r = await this.createRule.execute({
      userId: p.actor.id,
      skuId: b.sku_id,
      sizeLabel: b.size_label,
      targetPrice: b.target_price.amount,
      maxPrice: b.max_price.amount,
      expiresAtMs: Date.parse(b.expires_at),
      mode: b.mode,
      pspTokenRef: b.payment_token_ref ?? null,
      locale: b.locale,
      acceptedTermsVersion: b.accepted_terms_version,
      deviceId: headerValue(req, "x-device-id") ?? p.claims.sid,
    });
    switch (r.kind) {
      case "created":
        return { ...mandateWire(r.mandate, null, false), terms: { version: r.mandate.mandateVersion, locale: r.mandate.mandateLocale, text: r.termsText } };
      case "disabled":
        throw Problems.notFound();
      case "plus_required":
        throw Problems.forbidden("plus_required");
      case "age_restricted":
        throw Problems.forbidden("age_restricted");
      case "risk_blocked":
        throw Problems.forbidden("risk_blocked");
      case "unattended_unavailable":
        throw unprocessable("unattended_unavailable", "Automatic purchase without confirmation is not available");
      case "sku_unavailable":
        throw unprocessable("sku_unavailable", "This item is not available");
      case "drop_sku_excluded":
        throw unprocessable("drop_sku_excluded", "Drop items cannot be bought automatically");
      case "size_invalid":
        throw unprocessable("size_invalid", "This size does not exist for the item");
      case "token_invalid":
        throw unprocessable("payment_token_invalid", "The saved card cannot be used");
      case "limit_reached":
        throw unprocessable("auto_buy_limit_reached", "You have reached the maximum number of active rules");
      case "duplicate_active":
        throw new ProblemError(409, "auto-buy-rule-exists", "An active rule already exists for this item", { code: "auto_buy_rule_exists" });
      case "terms_version_stale":
        throw new ProblemError(409, "terms-version-stale", "The mandate text changed; review and accept the current version", {
          code: "terms_version_stale",
          extensions: { current_version: r.current },
        });
      case "invalid":
        throw new ProblemError(422, "terms-invalid", "The rule terms are not valid", {
          code: "terms_invalid",
          errors: r.violations.map((v) => ({ pointer: POINTER[v], code: v })),
        });
    }
  }

  @Get("me/auto-buy")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async listRules(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Query(new ZodPipe(ListQuery, "/query")) q: z.infer<typeof ListQuery>,
  ) {
    noStore(res);
    const v = await this.list.execute(principalOf(req).actor.id, q.limit);
    return {
      paused: v.paused,
      server_time: iso(v.serverTimeMs),
      capabilities: { unattended_available: v.unattendedAvailable },
      items: v.items.map((i) => mandateWire(i.mandate, i.latest, v.paused)),
    };
  }

  /** The wording the shopper must see before consenting. Static per (version, locale); no subject data. */
  @Get("me/auto-buy/terms")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  terms(@Res({ passthrough: true }) res: ApiResponse, @Query(new ZodPipe(TermsQuery, "/query")) q: z.infer<typeof TermsQuery>) {
    noStore(res);
    const version = CURRENT_MANDATE_VERSION;
    const text = mandateTemplate(version, q.locale);
    if (text === null) throw Problems.notFound();
    return { version, locale: q.locale, text };
  }

  @Delete("me/auto-buy/:id")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  async remove(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse, @Param("id") id: string) {
    noStore(res);
    if (!z.uuid().safeParse(id).success) throw Problems.notFound();
    const r = await this.cancelRule.execute(principalOf(req).actor.id, id);
    switch (r.kind) {
      case "cancelled":
      case "already_cancelled":
        return { status: "cancelled" as const };
      case "closed":
        throw new ProblemError(409, "auto-buy-closed", "This rule is already closed", { code: "auto_buy_closed" });
      case "not_found":
        throw Problems.notFound();
    }
  }

  @Post("me/auto-buy/attempts/:id/cancel")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  async cancel(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse, @Param("id") id: string) {
    noStore(res);
    if (!z.uuid().safeParse(id).success) throw Problems.notFound();
    const r = await this.cancelAttempt.execute(principalOf(req).actor.id, id);
    switch (r.kind) {
      case "cancelled":
      case "already_cancelled":
        return { status: "cancelled" as const };
      case "not_cancellable":
        // After the charge claim the order exists (or the attempt is over): use normal order cancellation.
        throw new ProblemError(409, "attempt-not-cancellable", "This purchase can no longer be cancelled here; cancel the order instead", {
          code: "attempt_not_cancellable",
          extensions: { state: r.state },
        });
      case "not_found":
        throw Problems.notFound();
    }
  }
  /**
   * The shopper finished the SCA challenge for a charge the PSP asked to authenticate. The call is a
   * prompt to look up the outcome, never evidence of it: the answer comes from the PSP lookup by
   * idempotency key. Owner only (404 for anyone else's attempt).
   */
  @Post("me/auto-buy/attempts/:id/sca-complete")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  async scaComplete(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse, @Param("id") id: string) {
    noStore(res);
    if (!z.uuid().safeParse(id).success) throw Problems.notFound();
    const r = await this.sweep.completeSca(principalOf(req).actor.id, id);
    switch (r.kind) {
      case "purchased":
        return { status: "purchased" as const, order_group_id: r.orderGroupId };
      case "processing":
      case "under_review":
      case "failed":
        return { status: r.kind, order_group_id: null };
      case "not_found":
        throw Problems.notFound();
      case "not_awaiting_sca":
        throw new ProblemError(409, "attempt-not-awaiting-sca", "This purchase is not waiting for authentication", {
          code: "attempt_not_awaiting_sca",
          extensions: { state: r.state },
        });
      case "not_confirmed":
        throw new ProblemError(409, "sca-not-confirmed", "The bank has not confirmed the authentication yet", { code: "sca_not_confirmed" });
      case "unavailable":
        throw Problems.unavailable("auto_buy_unavailable");
    }
  }
}
