import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { dpoConsoleDenial } from "./access";
import { DomainError } from "@outlet/domain";
import { z } from "zod";
import { AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import type { AuditSink, Clock } from "../../../platform/ports";
import { ProblemError, Problems } from "../../../platform/problem";
import { AUDIT_SINK, CLOCK } from "../../../platform/tokens";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { BreachAction, BreachRegister, BreachResult, ListDsarQueue } from "../application/dsar";
import { BREACH_SEVERITIES } from "../domain/bridge";
import { BREACH_REGISTER, LIST_DSAR_QUEUE } from "./tokens";
import { breachWire, queueWire } from "./wire";

const IdParam = z.object({ id: z.uuid() }).strict();
const Bool = z.enum(["true", "false"]).transform((v) => v === "true");
const QueueQuery = z
  .object({
    kind: z.enum(["export", "delete"]).optional(),
    overdue: Bool.optional(),
    include_closed: Bool.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();
const BreachBody = z
  .object({
    detected_at: z.iso.datetime(),
    severity: z.enum(BREACH_SEVERITIES),
    summary: z.string().trim().min(1).max(2000),
    affected_count: z.number().int().min(0).max(1_000_000_000),
  })
  .strict();
const TriageBody = z.object({ decision: z.enum(["notify", "no_notification_required"]) }).strict();

/**
 * DPO console endpoints. Gate: admin audience (the guard), the `dpo` admin role, a live grant and a
 * passkey session, checked here because the policy rule set has no DSAR-queue resource yet.
 * Every allow and deny is written to the audit sink. Shoppers cannot reach this controller:
 * their buyer-audience token is rejected at the guard, and an admin without the dpo grant gets 403.
 */
@Controller("admin/privacy")
export class DpoPrivacyController {
  constructor(
    @Inject(LIST_DSAR_QUEUE) private readonly queue: ListDsarQueue,
    @Inject(BREACH_REGISTER) private readonly breaches: BreachRegister,
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async requireDpo(req: ApiRequest, action: "read" | "create" | "update", resourceId: string | null): Promise<void> {
    const actor = req.principal?.actor;
    if (actor === undefined) throw Problems.unauthenticated();
    const now = this.clock.nowMs();
    const reason = dpoConsoleDenial(actor, now);
    await this.audit.record({
      effect: reason === null ? "allow" : "deny",
      actorId: actor.id,
      action,
      resourceType: "pii_view",
      resourceId,
      ruleId: "privacy.dpo_console",
      reason: reason ?? "allowed",
      httpStatus: reason === null ? 200 : 403,
      approverIds: [],
      atMs: now,
    });
    if (reason !== null) throw Problems.forbidden(reason);
  }

  private unwrap(r: BreachResult) {
    switch (r.kind) {
      case "ok":
        return breachWire(r.view.entry, r.view.clocks);
      case "not_found":
        throw Problems.notFound();
      case "invalid_transition":
        throw new ProblemError(409, "invalid-transition", "That step is not possible for this breach", {
          code: "invalid_transition",
        });
      case "conflict":
        throw new ProblemError(409, "breach-conflict", "The breach changed; reload and retry", { code: "breach_conflict" });
    }
  }

  @Get("requests")
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async dsar(@Req() req: ApiRequest, @Query(new ZodPipe(QueueQuery, "/query")) q: z.infer<typeof QueueQuery>) {
    await this.requireDpo(req, "read", null);
    return queueWire(
      await this.queue.execute({
        ...(q.kind !== undefined ? { kind: q.kind } : {}),
        ...(q.overdue !== undefined ? { overdueOnly: q.overdue } : {}),
        ...(q.include_closed !== undefined ? { includeClosed: q.include_closed } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
      }),
    );
  }

  @Get("breaches")
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async list(@Req() req: ApiRequest) {
    await this.requireDpo(req, "read", null);
    const views = await this.breaches.list();
    return { items: views.map((v) => breachWire(v.entry, v.clocks)) };
  }

  @Post("breaches")
  @HttpCode(201)
  @AuthenticatedSelf("admin_api")
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  async record(@Req() req: ApiRequest, @Body(new ZodPipe(BreachBody)) body: z.infer<typeof BreachBody>) {
    await this.requireDpo(req, "create", null);
    try {
      const v = await this.breaches.record({
        detectedAtMs: Date.parse(body.detected_at),
        severity: body.severity,
        summary: body.summary,
        affectedCount: body.affected_count,
      });
      return breachWire(v.entry, v.clocks);
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      throw Problems.validation([{ pointer: "/body", code: "invalid_breach" }]);
    }
  }

  private step(action: BreachAction) {
    return async (req: ApiRequest, id: string, decision?: "notify" | "no_notification_required") => {
      await this.requireDpo(req, "update", id);
      return this.unwrap(await this.breaches.advance(id, action, decision));
    };
  }

  @Post("breaches/:id/triage")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  triage(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>,
    @Body(new ZodPipe(TriageBody)) body: z.infer<typeof TriageBody>,
  ) {
    return this.step("triage")(req, p.id, body.decision);
  }

  @Post("breaches/:id/pdpc-notified")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  pdpc(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    return this.step("notify_pdpc")(req, p.id);
  }

  @Post("breaches/:id/subjects-notified")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  subjects(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    return this.step("notify_subjects")(req, p.id);
  }

  @Post("breaches/:id/close")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  close(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    return this.step("close")(req, p.id);
  }
}
