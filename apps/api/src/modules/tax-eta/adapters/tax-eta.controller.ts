import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { AuthenticatedSelf, Authorize, Idempotent, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest } from "../../../platform/http-types";
import type { AuditSink, Clock } from "../../../platform/ports";
import { ProblemError, Problems } from "../../../platform/problem";
import { AUDIT_SINK, CLOCK } from "../../../platform/tokens";
import { ZodPipe } from "../../../platform/zod.pipe";
import type {
  ChangeExemption,
  GetAdminDocument,
  GetSellerInvoice,
  ListAdminDocuments,
  ListExemptionAudit,
  ListSellerInvoices,
  ListTaxCategories,
  RequeueDeadLetter,
  RunDailyReconciliation,
} from "../application/tax";
import { DOCUMENT_KINDS, DomainError, SUBMISSION_STATES } from "../domain/bridge";
import {
  CHANGE_EXEMPTION,
  GET_ADMIN_DOCUMENT,
  GET_SELLER_INVOICE,
  LIST_ADMIN_DOCUMENTS,
  LIST_EXEMPTION_AUDIT,
  LIST_SELLER_INVOICES,
  LIST_TAX_CATEGORIES,
  REQUEUE_DEAD_LETTER,
  RUN_DAILY_RECONCILIATION,
  TAX_STORE_INVOICE_RESOLVER,
  TAX_STORE_LIST_RESOLVER,
} from "./tokens";
import { storeIdsOf } from "./resolvers";
import { adminDocumentWire, auditWire, categoryWire, reconciliationWire, sellerInvoiceWire } from "./wire";

const CodeParam = z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/) }).strict();
const DocParam = z.object({ documentId: z.uuid() }).strict();
const DateIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const ExemptionBody = z
  .object({
    exemption: z
      .object({
        reason_ar: z.string().trim().min(1).max(500),
        reason_en: z.string().trim().min(1).max(500),
        legal_basis: z.string().trim().min(1).max(500),
        effective_from: z.iso.datetime(),
        effective_to: z.iso.datetime().nullable(),
      })
      .strict(),
    reason: z.string().trim().min(3).max(500),
    expected_version: z.number().int().min(0),
  })
  .strict();
const ClearBody = z.object({ reason: z.string().trim().min(3).max(500), expected_version: z.number().int().min(0) }).strict();
const ListQuery = z.object({ cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();
const AdminListQuery = ListQuery.extend({ state: z.enum(SUBMISSION_STATES).optional(), kind: z.enum(DOCUMENT_KINDS).optional() }).strict();
const AuditQuery = z.object({ code: CodeParam.shape.code.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();
const ReconQuery = z.object({ date: DateIso }).strict();

const READERS = ["finance", "ops", "super_admin"] as const;
const WRITERS = ["finance", "super_admin"] as const;

function principalOf(req: ApiRequest) {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
}

const conflict = () =>
  new ProblemError(409, "tax-config-conflict", "The tax category changed; reload and retry", { code: "tax_config_conflict" });

/**
 * Admin tax console and the seller invoice list.
 *
 * Admin gate: admin audience (guard), a live admin grant with a permitted role, and a passkey
 * session, checked here because the policy rule set has no tax resource types yet (reported as an
 * integration need). Every allow and deny goes to the audit sink. Shoppers and sellers cannot reach
 * /admin/tax (wrong audience, 401/403); a finance admin cannot reach /seller/invoices.
 *
 * Seller routes use the existing `store_payout` resource (owner, manager, finance roles; store
 * scope): another store's invoice is a 404, never a 403.
 */
@Controller()
export class TaxEtaController {
  constructor(
    @Inject(LIST_TAX_CATEGORIES) private readonly categories: ListTaxCategories,
    @Inject(CHANGE_EXEMPTION) private readonly change: ChangeExemption,
    @Inject(LIST_EXEMPTION_AUDIT) private readonly auditList: ListExemptionAudit,
    @Inject(LIST_ADMIN_DOCUMENTS) private readonly adminDocs: ListAdminDocuments,
    @Inject(GET_ADMIN_DOCUMENT) private readonly adminDoc: GetAdminDocument,
    @Inject(RUN_DAILY_RECONCILIATION) private readonly recon: RunDailyReconciliation,
    @Inject(REQUEUE_DEAD_LETTER) private readonly requeue: RequeueDeadLetter,
    @Inject(LIST_SELLER_INVOICES) private readonly sellerList: ListSellerInvoices,
    @Inject(GET_SELLER_INVOICE) private readonly sellerOne: GetSellerInvoice,
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async requireAdmin(
    req: ApiRequest,
    roles: readonly string[],
    action: "read" | "create" | "update",
    resourceId: string | null,
  ): Promise<string> {
    const actor = principalOf(req).actor;
    const now = this.clock.nowMs();
    const hasRole = actor.grants.some(
      (g) => g.kind === "admin" && roles.includes(g.role) && (g.expiresAtMs === undefined || g.expiresAtMs > now),
    );
    const reason = !hasRole ? "missing_role" : actor.assurance !== "passkey" ? "passkey_required" : null;
    await this.audit.record({
      effect: reason === null ? "allow" : "deny",
      actorId: actor.id,
      action,
      resourceType: "admin_console",
      resourceId,
      ruleId: "tax_eta.admin",
      reason: reason ?? "allowed",
      httpStatus: reason === null ? 200 : 403,
      approverIds: [],
      atMs: now,
    });
    if (reason !== null) throw Problems.forbidden(reason);
    return actor.id;
  }

  // ---- admin ------------------------------------------------------------------------------

  @Get("admin/tax/categories")
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async listCategories(@Req() req: ApiRequest) {
    await this.requireAdmin(req, READERS, "read", null);
    return { items: (await this.categories.execute()).map(categoryWire) };
  }

  @Put("admin/tax/categories/:code/exemption")
  @AuthenticatedSelf("admin_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  async setExemption(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(CodeParam, "/params")) p: z.infer<typeof CodeParam>,
    @Body(new ZodPipe(ExemptionBody)) body: z.infer<typeof ExemptionBody>,
  ) {
    if (headerValue(req, "idempotency-key") === undefined) throw Problems.invalidIdempotencyKey();
    const actorId = await this.requireAdmin(req, WRITERS, "update", p.code);
    const r = await this.change.execute({
      code: p.code,
      actorId,
      expectedVersion: body.expected_version,
      change: {
        kind: "set",
        reason: body.reason,
        exemption: {
          reasonAr: body.exemption.reason_ar,
          reasonEn: body.exemption.reason_en,
          legalBasis: body.exemption.legal_basis,
          effectiveFromMs: Date.parse(body.exemption.effective_from),
          effectiveToMs: body.exemption.effective_to === null ? null : Date.parse(body.exemption.effective_to),
        },
      },
    });
    return this.unwrap(r);
  }

  @Post("admin/tax/categories/:code/exemption/clear")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  async clearExemption(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(CodeParam, "/params")) p: z.infer<typeof CodeParam>,
    @Body(new ZodPipe(ClearBody)) body: z.infer<typeof ClearBody>,
  ) {
    if (headerValue(req, "idempotency-key") === undefined) throw Problems.invalidIdempotencyKey();
    const actorId = await this.requireAdmin(req, WRITERS, "update", p.code);
    const r = await this.change.execute({
      code: p.code,
      actorId,
      expectedVersion: body.expected_version,
      change: { kind: "clear", reason: body.reason },
    });
    return this.unwrap(r);
  }

  private unwrap(r: Awaited<ReturnType<ChangeExemption["execute"]>>) {
    switch (r.kind) {
      case "ok":
        return categoryWire(r.category);
      case "not_found":
        throw Problems.notFound();
      case "conflict":
        throw conflict();
      case "invalid":
        throw new ProblemError(422, "tax-exemption-invalid", "The exemption is not valid", { code: "tax_exemption_invalid", detail: r.message });
    }
  }

  @Get("admin/tax/exemption-audit")
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async exemptionAudit(@Req() req: ApiRequest, @Query(new ZodPipe(AuditQuery, "/query")) q: z.infer<typeof AuditQuery>) {
    await this.requireAdmin(req, READERS, "read", null);
    return { items: (await this.auditList.execute(q.code ?? null, q.limit)).map(auditWire) };
  }

  @Get("admin/tax/documents")
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async documents(@Req() req: ApiRequest, @Query(new ZodPipe(AdminListQuery, "/query")) q: z.infer<typeof AdminListQuery>) {
    await this.requireAdmin(req, READERS, "read", null);
    const r = await this.adminDocs.execute(
      { ...(q.state === undefined ? {} : { state: q.state }), ...(q.kind === undefined ? {} : { kind: q.kind }) },
      q.cursor ?? null,
      q.limit,
    );
    if (r.kind === "invalid_cursor") throw Problems.validation([{ pointer: "/query/cursor", code: "invalid" }]);
    return {
      items: r.page.items.map(adminDocumentWire),
      page: { next_cursor: r.page.nextCursor, has_more: r.page.nextCursor !== null },
    };
  }

  @Get("admin/tax/documents/:documentId")
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async document(@Req() req: ApiRequest, @Param(new ZodPipe(DocParam, "/params")) p: z.infer<typeof DocParam>) {
    await this.requireAdmin(req, READERS, "read", p.documentId);
    const d = await this.adminDoc.execute(p.documentId.toLowerCase());
    if (d === null) throw Problems.notFound();
    return adminDocumentWire(d);
  }

  @Get("admin/tax/reconciliation")
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async reconciliation(@Req() req: ApiRequest, @Query(new ZodPipe(ReconQuery, "/query")) q: z.infer<typeof ReconQuery>) {
    await this.requireAdmin(req, READERS, "read", null);
    try {
      return reconciliationWire(await this.recon.execute(q.date));
    } catch (e) {
      if (e instanceof DomainError) throw Problems.validation([{ pointer: "/query/date", code: "invalid" }]);
      throw e;
    }
  }

  @Post("admin/tax/submissions/:documentId/requeue")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  async requeueDeadLetter(@Req() req: ApiRequest, @Param(new ZodPipe(DocParam, "/params")) p: z.infer<typeof DocParam>) {
    if (headerValue(req, "idempotency-key") === undefined) throw Problems.invalidIdempotencyKey();
    await this.requireAdmin(req, WRITERS, "update", p.documentId);
    const r = await this.requeue.execute(p.documentId.toLowerCase());
    switch (r) {
      case "ok": {
        const d = await this.adminDoc.execute(p.documentId.toLowerCase());
        if (d === null) throw Problems.notFound();
        return adminDocumentWire(d);
      }
      case "not_found":
        throw Problems.notFound();
      case "invalid_state":
        throw new ProblemError(409, "invalid-transition", "Only dead-lettered submissions can be requeued", { code: "invalid_transition" });
      case "conflict":
        throw new ProblemError(409, "submission-conflict", "The submission changed; reload and retry", { code: "submission_conflict" });
    }
  }

  // ---- seller -----------------------------------------------------------------------------

  @Get("seller/invoices")
  @Authorize({
    audience: "seller_api",
    action: "read",
    resourceType: "store_payout",
    resolver: TAX_STORE_LIST_RESOLVER,
    idParam: "none",
  })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async invoices(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) q: z.infer<typeof ListQuery>) {
    const r = await this.sellerList.execute(storeIdsOf(principalOf(req).actor), q.cursor ?? null, q.limit);
    if (r.kind === "invalid_cursor") throw Problems.validation([{ pointer: "/query/cursor", code: "invalid" }]);
    return {
      items: r.page.items.map(sellerInvoiceWire),
      page: { next_cursor: r.page.nextCursor, has_more: r.page.nextCursor !== null },
    };
  }

  @Get("seller/invoices/:documentId")
  @Authorize({
    audience: "seller_api",
    action: "read",
    resourceType: "store_payout",
    resolver: TAX_STORE_INVOICE_RESOLVER,
    idParam: "documentId",
  })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async invoice(@Req() req: ApiRequest, @Param(new ZodPipe(DocParam, "/params")) p: z.infer<typeof DocParam>) {
    const d = await this.sellerOne.execute(storeIdsOf(principalOf(req).actor), p.documentId.toLowerCase());
    if (d === null) throw Problems.notFound();
    return sellerInvoiceWire(d);
  }
}
