import { createHash } from "node:crypto";
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { moneyToWire } from "@outlet/validation";
import { z } from "zod";
import { AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { ManualReviewQueue } from "../application/ops";
import type { Clock } from "../domain/ports";
import type { AttemptRecord, OpsAuditPort } from "../domain/ports";
import { AutoBuyOpsAccess } from "./ops-access";
import { AUTO_BUY_OPS_AUDIT, MANUAL_REVIEW_QUEUE } from "./tokens";
import { CLOCK } from "../../../platform/tokens";

const IdParam = z.object({ id: z.uuid() }).strict();
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();
const ResolveBody = z
  .object({
    resolution: z.enum(["confirm_purchased", "confirm_not_charged"]),
    /** Required for confirm_purchased unless the PSP lookup itself already answers `placed`. */
    order_group_id: z.uuid().optional(),
    /** Pointer to the PSP record (settlement line, dashboard reference). Not free text. */
    psp_reference: z.string().regex(/^[A-Za-z0-9._:-]{4,40}$/),
    /** What was checked at the PSP. Only its digest and length are stored (audit diff). */
    evidence_note: z.string().trim().min(10).max(1000),
  })
  .strict();

const iso = (ms: number): string => new Date(ms).toISOString();

function itemWire(a: AttemptRecord) {
  return {
    id: a.id,
    mandate_id: a.mandateId,
    user_id: a.userId,
    mode: a.mode,
    state: a.state,
    reason: a.failureReason,
    trigger_price: moneyToWire({ amount: a.triggerPrice, currency: "EGP" }),
    charge_price: a.chargePrice === null ? null : moneyToWire({ amount: a.chargePrice, currency: "EGP" }),
    charge_started_at: a.chargeStartedAtMs === null ? null : iso(a.chargeStartedAtMs),
    created_at: iso(a.createdAtMs),
    updated_at: iso(a.updatedAtMs),
  };
}

/**
 * Operator queue for auto-buy attempts the sweep could not settle (MANUAL_REVIEW). Ops, finance and
 * super admin only; the policy decision and the hash-chained audit entry are written BEFORE the
 * action, and a failed audit write fails the request. This module has no dual-approval record: a
 * resolution moves no money (it records what the PSP already shows), so it is guarded by the
 * evidence cross-check in `ManualReviewQueue` instead.
 */
@Controller("admin")
export class AutoBuyOpsController {
  constructor(
    @Inject(AutoBuyOpsAccess) private readonly access: AutoBuyOpsAccess,
    @Inject(MANUAL_REVIEW_QUEUE) private readonly queue: ManualReviewQueue,
    @Inject(AUTO_BUY_OPS_AUDIT) private readonly audit: OpsAuditPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get("auto-buy/manual-review")
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async list(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) q: z.output<typeof ListQuery>) {
    const actor = this.actor(req);
    await this.access.require(actor);
    await this.appendAudit({
      action: "auto_buy.manual_review.list",
      actorId: actor.id,
      targetType: "auto_buy_attempt",
      targetId: null,
      reasonCode: "ops_queue_view",
      diff: { limit: q.limit },
      req,
    });
    const rows = await this.queue.list(q.limit);
    return { items: rows.map(itemWire) };
  }

  @Post("auto-buy/manual-review/:id/resolve")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async resolve(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>,
    @Body(new ZodPipe(ResolveBody)) b: z.infer<typeof ResolveBody>,
  ) {
    const actor = this.actor(req);
    await this.access.require(actor);
    // Audit first: a failed write fails the action (closed).
    await this.appendAudit({
      action: "auto_buy.manual_review.resolve",
      actorId: actor.id,
      targetType: "auto_buy_attempt",
      targetId: p.id,
      reasonCode: "psp_evidence",
      diff: {
        resolution: b.resolution,
        psp_reference: b.psp_reference,
        order_group_supplied: b.order_group_id !== undefined,
        evidence_sha256: createHash("sha256").update(b.evidence_note).digest("hex"),
        evidence_length: b.evidence_note.length,
      },
      req,
    });
    const r = await this.queue.resolve({
      attemptId: p.id,
      resolution: b.resolution,
      orderGroupId: b.order_group_id ?? null,
      pspReference: b.psp_reference,
      resolverId: actor.id,
    });
    switch (r.kind) {
      case "resolved":
        return { id: r.attempt.id, status: r.outcome, state: r.attempt.state, order_group_id: r.attempt.orderGroupId };
      case "not_found":
        throw Problems.notFound();
      case "not_in_review":
        throw new ProblemError(409, "attempt-not-in-review", "This attempt is not waiting for manual review", { code: "attempt_not_in_review", extensions: { state: r.state } });
      case "order_group_required":
        throw new ProblemError(422, "order-group-required", "An order group id is required to confirm a purchase", { code: "order_group_required" });
      case "evidence_conflict":
        throw new ProblemError(409, "evidence-conflict", "The payment provider's current answer contradicts this resolution", { code: "evidence_conflict" });
    }
  }

  private actor(req: ApiRequest) {
    const p = req.principal;
    if (p === null || p === undefined) throw Problems.unauthenticated();
    return p.actor;
  }

  private async appendAudit(e: {
    action: string;
    actorId: string;
    targetType: string;
    targetId: string | null;
    reasonCode: string;
    diff: Readonly<Record<string, string | number | boolean | null>>;
    req: ApiRequest;
  }): Promise<void> {
    try {
      await this.audit.append({
        action: e.action,
        actorId: e.actorId,
        targetType: e.targetType,
        targetId: e.targetId,
        reasonCode: e.reasonCode,
        diff: e.diff,
        requestId: headerValue(e.req, "x-request-id") ?? null,
        atMs: this.clock.nowMs(),
      });
    } catch {
      throw Problems.unavailable("audit_unavailable");
    }
  }
}
