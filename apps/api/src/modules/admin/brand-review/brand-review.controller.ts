import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { ResourceType } from "@outlet/policy";
import { z } from "zod";
import { AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "../../../platform/http-types";
import type { AuditSink, Clock } from "../../../platform/ports";
import { ProblemError, Problems } from "../../../platform/problem";
import { AUDIT_SINK, CLOCK } from "../../../platform/tokens";
import { ZodPipe } from "../../../platform/zod.pipe";
import { ADMIN_STORE } from "../adapters/tokens";
import { brandReviewGateDenial, computeAccess, type AdminAccess } from "../domain/access";
import type { AdminStore } from "../domain/ports";
import type { ApplicationDetail, Outcome } from "./application";
import type { BrandReview } from "./application";
import {
  BRAND_DECISIONS,
  BRAND_KINDS,
  BRAND_REASON_CODES,
  BRAND_REVIEW_ROLES,
  BRAND_STATUSES,
  DOCUMENT_READ_REASONS,
  type BrandApplicationRecord,
  type RequestedItem,
} from "./domain";
import { BRAND_REVIEW } from "./tokens";

const IdParam = z.object({ id: z.uuid() }).strict();
const DocParam = z.object({ id: z.uuid(), document_id: z.uuid() }).strict();
const ListQuery = z
  .object({
    status: z.enum(BRAND_STATUSES).optional(),
    kind: z.enum(BRAND_KINDS).optional(),
    country: z.string().regex(/^[A-Z]{2}$/).optional(),
    assignee: z.enum(["me", "unassigned", "any"]).optional(),
    sla_breached: z.enum(["true", "false"]).optional(),
    appeal: z.enum(["true", "false"]).optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .strict();
const RequestedItemBody = z
  .object({
    code: z.string().min(1).max(80),
    kind: z.enum(["document", "field", "domain_verification", "clarification"]),
    message_ar: z.string().trim().min(1).max(500),
    message_en: z.string().trim().min(1).max(500),
  })
  .strict();
const DecisionBody = z
  .object({
    decision: z.enum(BRAND_DECISIONS),
    reason_code: z.enum(BRAND_REASON_CODES),
    public_message_ar: z.string().max(1000).optional(),
    public_message_en: z.string().max(1000).optional(),
    requested_items: z.array(RequestedItemBody).max(20).optional(),
    internal_note: z.string().max(4000).optional(),
    reapply_after_days: z.number().int().min(0).max(365).optional(),
    slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(60).optional(),
  })
  .strict();
const CosignBody = z.object({ internal_note: z.string().trim().min(1).max(4000) }).strict();
const ReadBody = z.object({ reason_code: z.enum(DOCUMENT_READ_REASONS) }).strict();

const conflict = (code: string) => new ProblemError(409, code.replaceAll("_", "-"), "The request conflicts with the current state", { code });
const iso = (ms: number): string => new Date(ms).toISOString();
const rl = [{ dimension: "user", limit: 120, windowSeconds: 60 }] as const;
const idem = { required: true } as const;

const listItem = (r: BrandApplicationRecord, breached: boolean) => ({
  id: r.id,
  brand_name: r.brandName,
  brand_kind: r.brandKind,
  country: r.country,
  status: r.status,
  assignee_id: r.assigneeId,
  submitted_at: iso(r.submittedAtMs),
  decision_due_at: iso(r.decisionDueAtMs),
  sla_breached: breached,
  appeal: r.appeal,
  high_risk_country: r.highRiskCountry,
  ...(r.riskScore === null ? {} : { risk_score: r.riskScore }),
});

const itemWire = (i: RequestedItem) => ({ code: i.code, kind: i.kind, message_ar: i.messageAr, message_en: i.messageEn });

function detailWire(d: ApplicationDetail) {
  const r = d.record;
  return {
    application: {
      id: r.id,
      status: r.status,
      brand_kind: r.brandKind,
      country: r.country,
      brand_name: r.brandName,
      documents: d.documents.map((x) => ({
        id: x.id,
        requirement_code: x.requirementCode,
        content_type: x.contentType,
        size_bytes: x.sizeBytes,
        scan_status: x.scanStatus,
        upload_status: x.uploadStatus,
      })),
      requested_items: r.requestedItems.map(itemWire),
      decision:
        r.decision === null
          ? null
          : {
              decision: r.decision.decision,
              reason_code: r.decision.reasonCode,
              message_ar: r.decision.messageAr,
              message_en: r.decision.messageEn,
              decided_at: iso(r.decision.decidedAtMs),
            },
      decision_due_at: iso(r.decisionDueAtMs),
      store_id: r.storeId,
      allowed_actions: [] as string[],
      appeal_used: r.appeal,
      submitted_at: iso(r.submittedAtMs),
      created_at: iso(r.createdAtMs),
      updated_at: iso(r.updatedAtMs),
    },
    assignee_id: r.assigneeId,
    decision_due_at: iso(r.decisionDueAtMs),
    sla_breached: d.slaBreached,
    pending_cosign: r.pendingCosign !== null,
    high_risk_country: r.highRiskCountry,
    ...(r.provisioningFailure === null ? {} : { provisioning_failure: r.provisioningFailure }),
    auto_checks: d.autoChecks.map((c) => ({ code: c.code, result: c.result, ...(c.detail === null ? {} : { detail: c.detail }), ran_at: iso(c.ranAtMs) })),
    trademark_evidence: [] as string[],
    duplicate_claim_application_ids: r.duplicateClaimApplicationIds,
    internal_notes: r.internalNotes.map((n) => ({ admin_id: n.adminId, note: n.note, at: iso(n.atMs) })),
    history: r.history.map((h) => ({
      at: iso(h.atMs),
      actor_type: h.actorType,
      event: h.event,
      ...(h.fromStatus === null ? {} : { from_status: h.fromStatus }),
      ...(h.toStatus === null ? {} : { to_status: h.toStatus }),
    })),
  };
}

const etag = (r: BrandApplicationRecord): string => `"v${r.version}"`;
function ifMatchVersion(req: ApiRequest): number | undefined {
  const raw = headerValue(req, "if-match");
  if (raw === undefined) return undefined;
  const m = /^"?v(\d{1,9})"?$/.exec(raw.trim());
  if (m === null) throw Problems.validation([{ pointer: "/headers/if-match", code: "invalid" }]);
  return Number(m[1]);
}

/**
 * Brand application review (contract "Admin" table). Gate on every route: admin audience (guard)
 * -> passkey -> role ops/trust_safety from standing grants or a live elevation. Missing role is a
 * bare 403, unknown id is 404. Every mutation writes the hash-chained admin audit row.
 */
@Controller("admin/brand-applications")
export class BrandReviewController {
  constructor(
    @Inject(BRAND_REVIEW) private readonly review: BrandReview,
    @Inject(ADMIN_STORE) private readonly store: AdminStore,
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async gate(req: ApiRequest, routeId: string, action: "read" | "update" | "approve" | "create", resourceId: string | null = null) {
    const actor = req.principal?.actor;
    if (actor === undefined) throw Problems.unauthenticated();
    const now = this.clock.nowMs();
    const access = computeAccess(actor, await this.store.liveElevations(actor.id, now), now);
    const reason = brandReviewGateDenial(access, BRAND_REVIEW_ROLES);
    try {
      await this.audit.record({
        effect: reason === null ? "allow" : "deny",
        actorId: actor.id,
        action,
        resourceType: "admin_console" satisfies ResourceType,
        resourceId,
        ruleId: `admin.brand_review.${routeId}`,
        reason: reason ?? "allowed",
        httpStatus: reason === null ? 200 : 403,
        approverIds: [],
        atMs: now,
      });
    } catch {
      if (reason === null) throw Problems.unavailable("audit_unavailable");
    }
    if (reason !== null) throw Problems.forbidden(reason);
    return { access, meta: { access, requestId: req.ctx?.requestId ?? null } };
  }

  private unwrap<T>(r: Outcome<T>): T {
    if (r.kind === "ok") return r.value;
    switch (r.kind) {
      case "not_found":
        throw Problems.notFound();
      case "invalid":
        throw Problems.validation(r.problems);
      case "elevation_required":
        throw Problems.forbidden("elevation_required");
      case "invalid_transition":
        throw conflict("invalid_transition");
      case "provisioning_unavailable":
        throw Problems.unavailable("provisioning_unavailable");
      default:
        throw conflict(r.kind);
    }
  }

  private async fresh(id: string): Promise<ApplicationDetail> {
    const d = await this.review.detail(id);
    if (d === null) throw Problems.notFound();
    return d;
  }

  /** Audit-failure on a mutation is a closed 503 (the state change already committed; see spec). */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ProblemError) throw e;
      throw Problems.unavailable("audit_unavailable");
    }
  }

  @Get()
  @AuthenticatedSelf("admin_api")
  @RateLimit(rl)
  async list(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) q: z.infer<typeof ListQuery>) {
    const { access } = await this.gate(req, "list", "read");
    const now = this.clock.nowMs();
    const page = await this.review.list(
      {
        adminId: access.actorId,
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(q.kind !== undefined ? { kind: q.kind } : {}),
        ...(q.country !== undefined ? { country: q.country } : {}),
        ...(q.assignee !== undefined ? { assignee: q.assignee } : {}),
        ...(q.appeal !== undefined ? { appeal: q.appeal === "true" } : {}),
        ...(q.sla_breached === "true" ? { slaBreachedAtMs: now } : {}),
      },
      q.cursor ?? null,
      q.limit,
    );
    return {
      items: page.items.map((r) => listItem(r, this.review.isSlaBreached(r))),
      page: { next_cursor: page.nextCursor, has_more: page.nextCursor !== null },
    };
  }

  @Get(":id")
  @AuthenticatedSelf("admin_api")
  @RateLimit(rl)
  async get(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>,
    @Res({ passthrough: true }) res: ApiResponse,
  ) {
    await this.gate(req, "read", "read", p.id);
    const d = await this.fresh(p.id);
    res.setHeader("ETag", etag(d.record));
    res.setHeader("Cache-Control", "private, no-store");
    return detailWire(d);
  }

  @Post(":id/claim")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @Idempotent(idem)
  @RateLimit(rl)
  async claim(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    const { meta } = await this.gate(req, "claim", "update", p.id);
    await this.guarded(async () => this.unwrap(await this.review.claim(meta, p.id)));
    return detailWire(await this.fresh(p.id));
  }

  @Post(":id/release")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @Idempotent(idem)
  @RateLimit(rl)
  async release(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    const { access, meta } = await this.gate(req, "release", "update", p.id);
    await this.guarded(async () => this.unwrap(await this.review.release(meta, p.id, access.effective.includes("super_admin"))));
    return detailWire(await this.fresh(p.id));
  }

  @Post(":id/decision")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @Idempotent(idem)
  @RateLimit(rl)
  async decide(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>,
    @Body(new ZodPipe(DecisionBody)) b: z.infer<typeof DecisionBody>,
  ) {
    const { meta } = await this.gate(req, "decide", "approve", p.id);
    const expectedVersion = ifMatchVersion(req);
    await this.guarded(async () =>
      this.unwrap(
        await this.review.decide(meta, p.id, {
          decision: b.decision,
          reasonCode: b.reason_code,
          publicMessageAr: b.public_message_ar,
          publicMessageEn: b.public_message_en,
          requestedItems: b.requested_items?.map((i) => ({ code: i.code, kind: i.kind, messageAr: i.message_ar, messageEn: i.message_en })),
          internalNote: b.internal_note,
          reapplyAfterDays: b.reapply_after_days,
          slug: b.slug,
          expectedVersion,
        }),
      ),
    );
    return detailWire(await this.fresh(p.id));
  }

  @Post(":id/cosign")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @Idempotent(idem)
  @RateLimit(rl)
  async cosign(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>,
    @Body(new ZodPipe(CosignBody)) b: z.infer<typeof CosignBody>,
  ) {
    const { access, meta } = await this.gate(req, "cosign", "approve", p.id);
    const expectedVersion = ifMatchVersion(req);
    await this.guarded(async () => this.unwrap(await this.review.cosign(meta, p.id, b.internal_note, elevatedReviewer(access), expectedVersion)));
    return detailWire(await this.fresh(p.id));
  }

  @Post(":id/retry-provisioning")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @Idempotent(idem)
  @RateLimit(rl)
  async retryProvisioning(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    const { meta } = await this.gate(req, "retry_provisioning", "update", p.id);
    await this.guarded(async () => this.unwrap(await this.review.retryProvisioning(meta, p.id)));
    return detailWire(await this.fresh(p.id));
  }

  @Post(":id/documents/:document_id/read-url")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @Idempotent(idem)
  @RateLimit(rl)
  async readUrl(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(DocParam, "/params")) p: z.infer<typeof DocParam>,
    @Body(new ZodPipe(ReadBody)) b: z.infer<typeof ReadBody>,
    @Res({ passthrough: true }) res: ApiResponse,
  ) {
    const { meta } = await this.gate(req, "read_url", "read", p.document_id);
    const r = await this.guarded(async () => this.unwrap(await this.review.documentReadUrl(meta, p.id, p.document_id, b.reason_code)));
    res.setHeader("Cache-Control", "no-store");
    return { url: r.url, expires_at: iso(r.expiresAtMs) };
  }
}

/** ops/trust_safety held through a live JIT elevation (effective but not standing). */
function elevatedReviewer(a: AdminAccess): boolean {
  return a.effective.some((r) => (BRAND_REVIEW_ROLES as readonly string[]).includes(r) && !a.standing.includes(r));
}
