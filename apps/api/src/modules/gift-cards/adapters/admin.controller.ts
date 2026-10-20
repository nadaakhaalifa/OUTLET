import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { moneyToWire } from "@outlet/validation";
import { z } from "zod";
import { Authorize, Idempotent, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { AdminVoidGiftCard, ListAdminPots, ListThrottleEvents } from "../application/admin";
import { encodeCursor, KeysetCursor } from "./cursor";
import { cardWire } from "./gift-cards.controller";
import { ADMIN_VOID_GIFT_CARD, GIFT_CARD_ADMIN_RESOLVER, LIST_ADMIN_POTS, LIST_THROTTLE_EVENTS } from "./tokens";

const VOID_ROLES = ["finance", "trust_safety", "super_admin"] as const;
const READ_ROLES = ["finance", "ops", "trust_safety", "super_admin"] as const;
const IdParam = z.object({ id: z.uuid() }).strict();
const VoidBody = z.object({ reason_code: z.string().min(1).max(64), approval_id: z.uuid().optional() }).strict();
const PageQuery = z
  .object({ cursor: KeysetCursor.optional(), limit: z.coerce.number().int().min(1).max(50).default(50) })
  .strict();

const iso = (ms: number): string => new Date(ms).toISOString();
const egp = (amount: bigint) => moneyToWire({ amount, currency: "EGP" });
const problem = (status: number, slug: string, title: string, code: string) => new ProblemError(status, slug, title, { code });

@Controller()
export class GiftCardsAdminController {
  constructor(
    @Inject(ADMIN_VOID_GIFT_CARD) private readonly voidCard: AdminVoidGiftCard,
    @Inject(LIST_ADMIN_POTS) private readonly pots: ListAdminPots,
    @Inject(LIST_THROTTLE_EVENTS) private readonly throttle: ListThrottleEvents,
  ) {}

  private role(req: ApiRequest, allowed: readonly string[]): string {
    const p = req.principal;
    if (p === null || p === undefined) throw Problems.unauthenticated();
    if (!p.actor.grants.some((g) => g.kind === "admin" && allowed.includes(g.role))) throw Problems.forbidden();
    return p.actor.id;
  }

  @Post("admin/gift-cards/:id/void")
  @HttpCode(200)
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: GIFT_CARD_ADMIN_RESOLVER, idParam: "none" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  async adminVoid(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>,
    @Body(new ZodPipe(VoidBody)) b: z.infer<typeof VoidBody>,
  ) {
    const actorId = this.role(req, VOID_ROLES);
    const r = await this.voidCard.execute({ actorId, cardId: p.id.toLowerCase(), reasonCode: b.reason_code, approvalId: b.approval_id?.toLowerCase() ?? null });
    switch (r.kind) {
      case "ok":
        return { card: cardWire(r.card), refunded_amount: egp(r.refundedAmount), refund: r.refund, replayed: r.replayed };
      case "not_found":
        throw Problems.notFound();
      case "not_voidable":
        throw problem(409, "not-voidable", "This card can no longer be voided", "not_voidable");
      case "conflict":
        throw problem(409, "conflict", "The card changed, reload and retry", "conflict");
      case "approval_required":
        throw problem(422, "approval-required", "A second admin approval covering this card and amount is required", "approval_required");
      case "invalid_reason":
        throw Problems.validation([{ pointer: "/body/reason_code", code: "invalid_reason_code" }]);
    }
  }

  @Get("admin/gift-cards/pots")
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: GIFT_CARD_ADMIN_RESOLVER, idParam: "none" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async adminPots(@Req() req: ApiRequest, @Query(new ZodPipe(PageQuery, "/query")) q: z.output<typeof PageQuery>) {
    this.role(req, READ_ROLES);
    const r = await this.pots.execute(q.cursor ?? null, q.limit);
    return {
      items: r.rows.map((x) => ({
        id: x.pot.id,
        status: x.pot.status,
        target: egp(x.pot.target),
        paid: egp(x.paid),
        pending: egp(x.pending),
        refunded: egp(x.refunded),
        refund_failed_count: x.refundFailedCount,
        reconciled: x.discrepancy === null,
        discrepancy: x.discrepancy,
        closes_at: iso(x.pot.closesAtMs),
        created_at: iso(x.pot.createdAtMs),
      })),
      next_cursor: encodeCursor(r.next),
    };
  }

  @Get("admin/gift-cards/throttle-events")
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: GIFT_CARD_ADMIN_RESOLVER, idParam: "none" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async adminThrottle(@Req() req: ApiRequest, @Query(new ZodPipe(PageQuery, "/query")) q: z.output<typeof PageQuery>) {
    this.role(req, READ_ROLES);
    const r = await this.throttle.execute(q.cursor ?? null, q.limit);
    return {
      items: r.rows.map((a) => ({ id: a.id, account_id: a.accountId, device_ref: a.deviceHash.slice(0, 12), ip_ref: a.ipHash.slice(0, 12), at: iso(a.atMs) })),
      next_cursor: encodeCursor(r.next),
    };
  }
}
