import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { Authorize, Idempotent, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import { decodeClickCursor, type DecideInvalidClick, type ListInvalidClicks } from "../application/click-review";
import { CLICK_REVIEW_DECISIONS, type ClickRecord } from "../domain/ports";
import { ADS_ADMIN_RESOLVER, DECIDE_INVALID_CLICK, LIST_INVALID_CLICKS } from "./tokens";

const ROLES = ["marketing", "ops", "trust_safety", "super_admin"] as const;
const ListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(50),
    cursor: z.string().min(8).max(200).regex(/^[A-Za-z0-9_-]+$/).optional(),
  })
  .strict();
const IdParam = z.object({ id: z.uuid() }).strict();
const DecisionBody = z
  .object({ decision: z.enum(CLICK_REVIEW_DECISIONS), reason_code: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/) })
  .strict();

const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};
const clickWire = (c: ClickRecord) => ({
  id: c.id,
  campaign_id: c.campaignId,
  store_id: c.storeId,
  product_id: c.productId,
  reason: c.invalidReason,
  occurred_at: new Date(c.atMs).toISOString(),
});

@Controller()
export class AdsClickReviewController {
  constructor(
    @Inject(LIST_INVALID_CLICKS) private readonly list: ListInvalidClicks,
    @Inject(DECIDE_INVALID_CLICK) private readonly decide: DecideInvalidClick,
  ) {}

  private actorId(req: ApiRequest): string {
    const actor = principalOf(req).actor;
    if (!actor.grants.some((g) => g.kind === "admin" && (ROLES as readonly string[]).includes(g.role))) throw Problems.forbidden();
    return actor.id;
  }

  @Get("admin/ads/invalid-clicks")
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: ADS_ADMIN_RESOLVER, idParam: "none" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async queue(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) q: z.output<typeof ListQuery>) {
    this.actorId(req);
    const after = q.cursor === undefined ? null : decodeClickCursor(q.cursor);
    if (q.cursor !== undefined && after === null) throw Problems.validation([{ pointer: "/query/cursor", code: "invalid_cursor" }]);
    const page = await this.list.execute(q.limit, after);
    return { items: page.items.map(clickWire), next_cursor: page.nextCursor };
  }

  @Post("admin/ads/invalid-clicks/:id/decision")
  @HttpCode(200)
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: ADS_ADMIN_RESOLVER, idParam: "none" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async decision(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>, @Body(new ZodPipe(DecisionBody)) b: z.infer<typeof DecisionBody>) {
    const actorId = this.actorId(req);
    const r = await this.decide.execute({ clickId: p.id.toLowerCase(), decision: b.decision, reasonCode: b.reason_code, actorId });
    switch (r.kind) {
      case "decided":
      case "replayed":
        return { click_id: r.review.clickId, decision: r.review.decision, reason_code: r.review.reasonCode, decided_at: new Date(r.review.decidedAtMs).toISOString(), replayed: r.kind === "replayed" };
      case "not_found":
        throw Problems.notFound();
      case "conflict":
        throw new ProblemError(409, "click-already-reviewed", "This click already has a different decision", { code: "already_reviewed" });
      case "not_reviewable":
        throw new ProblemError(409, "click-not-reviewable", "Only unreviewed invalid clicks with a fraud reason can be reviewed", { code: "not_reviewable" });
    }
  }
}
