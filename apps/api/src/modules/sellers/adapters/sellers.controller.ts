import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { SELLER_ENROL_SCOPE } from "@outlet/auth-core";
import { sha256Hex } from "@outlet/idempotency";
import { sellers } from "@outlet/domain";
import { z } from "zod";
import { SELLER_SESSIONS, type SellerSessions } from "../../auth";
import { AllowSellerEnrol, AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { ApplicationPatch, BrandApplicationService, Result } from "../application/service";
import type { Cursor } from "../domain/ports";
import { SELLERS_NOW, SELLERS_SERVICE } from "./tokens";
import { applicationWire, documentWire } from "./wire";

const Country = z.string().regex(/^[A-Z]{2}$/);
const IdParam = z.object({ id: z.uuid() }).strict();
const DocParam = z.object({ id: z.uuid(), documentId: z.uuid() }).strict();
const ReqQuery = z.object({ kind: z.enum(sellers.BRAND_KINDS), country: Country }).strict();
const ListQuery = z.object({ cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();
const CursorBody = z.object({ c: z.number().int().nonnegative().max(8.64e15), i: z.uuid() }).strict();

const CreateBody = z
  .object({ brand_kind: z.enum(sellers.BRAND_KINDS), country: Country, brand_name: z.string().min(2).max(80) })
  .strict();
const PatchBody = z
  .object({
    brand_name: z.string().min(2).max(80).optional(),
    legal_name: z.string().max(200).optional(),
    registration: z
      .object({
        commercial_register_no: z.string().max(40).optional(),
        tax_card_no: z.string().max(40).optional(),
        company_reg_no: z.string().max(40).optional(),
        company_reg_country: Country.optional(),
        vat_or_tax_id: z.string().max(40).optional(),
      })
      .strict()
      .optional(),
    trademark: z
      .object({
        register: z.enum(["WIPO", "EUIPO", "USPTO", "EGYPT_TMO", "OTHER_NATIONAL"]).optional(),
        number: z.string().max(40).optional(),
        owner_name: z.string().max(200).optional(),
      })
      .strict()
      .optional(),
    ownership_basis: z.enum(sellers.OWNERSHIP_BASES).optional(),
    website_domain: z.string().max(253).optional(),
    social_handles: z
      .object({ instagram: z.string().max(60).optional(), tiktok: z.string().max(60).optional(), facebook: z.string().max(120).optional() })
      .strict()
      .optional(),
    contact: z.object({ name: z.string().max(120).optional(), phone_e164: z.string().optional(), email: z.string().max(254).optional() }).strict().optional(),
    signatory: z.object({ full_name: z.string().max(200).optional(), national_id: z.string().max(30).optional(), date_of_birth: z.string().optional() }).strict().optional(),
    eta_registration: z.enum(["unknown", "registered", "not_registered"]).optional(),
    description_ar: z.string().max(1000).optional(),
    description_en: z.string().max(1000).optional(),
    acknowledgements: z
      .object({ seller_agreement_version: z.string().max(40).optional(), dpa_version: z.string().max(40).optional(), price_monitoring_consent: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "at least one property" });
const ResubmitBody = z.object({ note: z.string().max(1000).optional(), satisfied_item_codes: z.array(z.string().max(64)).max(50).optional() }).strict();
const AppealBody = z.object({ statement: z.string().min(20).max(2000) }).strict();
const DocBody = z
  .object({
    requirement_code: z.string().min(1).max(64),
    content_type: z.enum(sellers.DOCUMENT_CONTENT_TYPES),
    size_bytes: z.number().int().min(1).max(sellers.MAX_DOCUMENT_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    original_filename: z.string().max(120).optional(),
  })
  .strict();
const ConfirmBody = z.object({ etag: z.string().max(200).optional() }).strict();

const etagOf = (wire: unknown): string => `"${sha256Hex(JSON.stringify(wire)).slice(0, 32)}"`;
const matches = (header: string | undefined, etag: string): boolean =>
  header !== undefined && header.split(",").map((t) => t.trim()).some((t) => t === etag || t === `W/${etag}` || t === "*");

function decodeCursor(raw: string | undefined): Cursor | null {
  if (raw === undefined) return null;
  try {
    const p = CursorBody.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return { createdAtMs: p.c, id: p.i };
  } catch {
    throw Problems.validation([{ pointer: "/query/cursor", code: "invalid_cursor" }]);
  }
}
const encodeCursor = (c: Cursor): string => Buffer.from(JSON.stringify({ c: c.createdAtMs, i: c.id })).toString("base64url");

function principalOf(req: ApiRequest) {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
}
/** Enrolment token: phone OTP only, scope `seller:enrol`. */
const isEnrol = (req: ApiRequest): boolean => principalOf(req).claims.scope === SELLER_ENROL_SCOPE;
const STRONG = new Set(["passkey", "webauthn", "totp"]);
const amrStrong = (req: ApiRequest): boolean => !isEnrol(req) && principalOf(req).claims.amr.some((a) => STRONG.has(a));
const STRONG_FACTOR_MAX_AGE_SECONDS = 15 * 60;

/** Routes outside requirements/list/create/patch/documents/domain need a full seller session. */
function requireFullSession(req: ApiRequest): void {
  if (isEnrol(req)) throw Problems.forbidden("full_session_required");
}
const conflict = (slug: string, title: string, code: string) => new ProblemError(409, slug, title, { code });

function unwrap<T>(r: Result<T>): T {
  switch (r.kind) {
    case "ok":
      return r.value;
    case "not_found":
      throw Problems.notFound();
    case "not_editable":
      throw conflict("not-editable", "The application can no longer be edited", "not_editable");
    case "invalid":
      throw Problems.validation(r.violations);
    case "duplicate_active":
      throw conflict("duplicate-active-application", "You already have an active application for this brand", "duplicate_active_application");
    case "cooldown":
      throw new ProblemError(409, "reapply-cooldown", "You can reapply for this brand later", {
        code: "reapply_cooldown",
        extensions: { reapply_after: new Date(r.reapplyAfterMs).toISOString() },
      });
    case "conflict":
      throw conflict("application-conflict", "The application changed; reload and retry", "application_conflict");
    case "strong_factor_required":
      throw Problems.forbidden("strong_factor_required");
    case "incomplete":
      throw new ProblemError(422, "incomplete-application", "The application is not complete", {
        code: "incomplete_application",
        errors: r.missing.map((m) => ({ pointer: `/${m.code}`, code: m.kind })),
      });
    case "invalid_transition":
      throw conflict("invalid-transition", "That action is not possible in the application's status", "invalid_transition");
    case "rate_limited":
      throw Problems.rateLimited(r.retryAfterSeconds);
    case "upload_missing":
      throw conflict("upload-missing", "The file has not been uploaded yet", "upload_missing");
    case "invalid_content":
      throw new ProblemError(422, "invalid-document", "The uploaded file does not match what was declared", { code: r.code });
    case "not_applicable":
      throw conflict("not-applicable", "That is not possible right now", r.code);
  }
}

const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function toPatch(b: z.output<typeof PatchBody>): ApplicationPatch {
  return {
    brandName: b.brand_name,
    legalName: b.legal_name,
    registration: b.registration === undefined ? undefined : strip({
      commercialRegisterNo: b.registration.commercial_register_no,
      taxCardNo: b.registration.tax_card_no,
      companyRegNo: b.registration.company_reg_no,
      companyRegCountry: b.registration.company_reg_country,
      vatOrTaxId: b.registration.vat_or_tax_id,
    }),
    trademark: b.trademark === undefined ? undefined : strip({ register: b.trademark.register, number: b.trademark.number, ownerName: b.trademark.owner_name }),
    ownershipBasis: b.ownership_basis,
    websiteDomain: b.website_domain,
    socialHandles: b.social_handles === undefined ? undefined : (strip(b.social_handles) as Record<string, string>),
    contact: b.contact === undefined ? undefined : strip({ name: b.contact.name, phoneE164: b.contact.phone_e164, email: b.contact.email }),
    signatory: b.signatory === undefined ? undefined : strip({ fullName: b.signatory.full_name, nationalId: b.signatory.national_id, dateOfBirth: b.signatory.date_of_birth }),
    etaRegistration: b.eta_registration,
    descriptionAr: b.description_ar,
    descriptionEn: b.description_en,
    acknowledgements: b.acknowledgements === undefined ? undefined : strip({
      sellerAgreementVersion: b.acknowledgements.seller_agreement_version,
      dpaVersion: b.acknowledgements.dpa_version,
      priceMonitoringConsent: b.acknowledgements.price_monitoring_consent,
    }),
  };
}

/**
 * Applicant API. Authorization: seller_api audience token (policy guard, 401 otherwise); every object access is
 * scoped by the token subject in the repository (and by RLS), so another applicant's application or document is
 * a 404 indistinguishable from a missing one. Enrolment tokens may use requirements/list/create/get/patch/documents/
 * domain verification only; submit, resubmit, withdraw, appeal and the checklist need a full session, and submit
 * and resubmit additionally need a strong factor (passkey or TOTP) in the token's amr.
 */
@Controller("seller")
export class SellerApplicationsController {
  constructor(
    @Inject(SELLERS_SERVICE) private readonly svc: BrandApplicationService,
    @Inject(SELLERS_NOW) private readonly now: () => number,
    @Inject(ModuleRef) private readonly refs: ModuleRef,
  ) {}

  /**
   * Strong factor for submit and resubmit: the seller-auth module's session clock when composed (a passkey or TOTP
   * assertion within 15 minutes), otherwise the token's amr claim.
   */
  private sessionsOrNull(): SellerSessions | null {
    try {
      return this.refs.get<SellerSessions>(SELLER_SESSIONS, { strict: false });
    } catch {
      return null;
    }
  }

  private async strong(req: ApiRequest): Promise<boolean> {
    if (isEnrol(req)) return false;
    const sessions = this.sessionsOrNull();
    return sessions === null ? amrStrong(req) : sessions.assertRecentStrongFactor(principalOf(req).claims.sid, STRONG_FACTOR_MAX_AGE_SECONDS);
  }

  private async wire(req: ApiRequest, id: string) {
    const v = await this.svc.get(principalOf(req).actor.id, id);
    if (v === null) throw Problems.notFound();
    return applicationWire(v, this.svc.allowed(v, this.now()));
  }

  @Get("applications/requirements")
  @AllowSellerEnrol()
  @AuthenticatedSelf("seller_api")
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  requirements(@Res({ passthrough: true }) res: ApiResponse, @Req() req: ApiRequest, @Query(new ZodPipe(ReqQuery, "/query")) q: z.output<typeof ReqQuery>) {
    const wire = this.svc.requirements(q.kind, q.country);
    const etag = etagOf(wire);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, max-age=300");
    if (matches(headerValue(req, "if-none-match"), etag)) throw new ProblemError(304, "not-modified", "Not modified");
    return wire;
  }

  @Get("applications")
  @AllowSellerEnrol()
  @AuthenticatedSelf("seller_api")
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async list(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) q: z.output<typeof ListQuery>) {
    const page = await this.svc.list(principalOf(req).actor.id, decodeCursor(q.cursor), q.limit);
    const nowMs = this.now();
    return {
      items: page.items.map((v) => applicationWire(v, this.svc.allowed(v, nowMs))),
      page: { next_cursor: page.next === null ? null : encodeCursor(page.next), has_more: page.next !== null },
    };
  }

  @Post("applications")
  @AllowSellerEnrol()
  @HttpCode(201)
  @AuthenticatedSelf("seller_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 5, windowSeconds: 3600 }])
  async create(@Req() req: ApiRequest, @Body(new ZodPipe(CreateBody)) b: z.output<typeof CreateBody>) {
    const v = unwrap(await this.svc.create(principalOf(req).actor.id, { brandKind: b.brand_kind, country: b.country, brandName: b.brand_name }));
    return applicationWire(v, this.svc.allowed(v, this.now()));
  }

  @Get("applications/:id")
  @AllowSellerEnrol()
  @AuthenticatedSelf("seller_api")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async one(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    const wire = await this.wire(req, p.id);
    const etag = etagOf(wire);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, no-cache");
    if (matches(headerValue(req, "if-none-match"), etag)) throw new ProblemError(304, "not-modified", "Not modified");
    return wire;
  }

  @Patch("applications/:id")
  @AllowSellerEnrol()
  @AuthenticatedSelf("seller_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async update(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>, @Body(new ZodPipe(PatchBody)) b: z.output<typeof PatchBody>) {
    const v = unwrap(await this.svc.patch(principalOf(req).actor.id, p.id, toPatch(b)));
    return applicationWire(v, this.svc.allowed(v, this.now()));
  }

  @Post("applications/:id/submit")
  @HttpCode(200)
  @AuthenticatedSelf("seller_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 3600 }])
  async submit(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    requireFullSession(req);
    const v = unwrap(await this.svc.submit(principalOf(req).actor.id, p.id, await this.strong(req)));
    return applicationWire(v, this.svc.allowed(v, this.now()));
  }

  @Post("applications/:id/resubmit")
  @HttpCode(200)
  @AuthenticatedSelf("seller_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 3600 }])
  async resubmit(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>, @Body(new ZodPipe(ResubmitBody)) b: z.output<typeof ResubmitBody>) {
    requireFullSession(req);
    const v = unwrap(await this.svc.resubmit(principalOf(req).actor.id, p.id, await this.strong(req), new Set(b.satisfied_item_codes ?? [])));
    return applicationWire(v, this.svc.allowed(v, this.now()));
  }

  @Post("applications/:id/withdraw")
  @HttpCode(200)
  @AuthenticatedSelf("seller_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 3600 }])
  async withdraw(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    requireFullSession(req);
    const v = unwrap(await this.svc.withdraw(principalOf(req).actor.id, p.id));
    return applicationWire(v, this.svc.allowed(v, this.now()));
  }

  @Post("applications/:id/appeal")
  @HttpCode(200)
  @AuthenticatedSelf("seller_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 3600 }])
  async appeal(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>, @Body(new ZodPipe(AppealBody)) b: z.output<typeof AppealBody>) {
    requireFullSession(req);
    const v = unwrap(await this.svc.appeal(principalOf(req).actor.id, p.id, b.statement));
    return applicationWire(v, this.svc.allowed(v, this.now()));
  }

  @Post("applications/:id/documents")
  @AllowSellerEnrol()
  @HttpCode(201)
  @AuthenticatedSelf("seller_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 3600 }])
  async createDocument(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>, @Body(new ZodPipe(DocBody)) b: z.output<typeof DocBody>) {
    const r = unwrap(
      await this.svc.createDocument(principalOf(req).actor.id, p.id, {
        requirementCode: b.requirement_code,
        contentType: b.content_type,
        sizeBytes: b.size_bytes,
        sha256: b.sha256,
        ...(b.original_filename !== undefined ? { originalFilename: b.original_filename } : {}),
      }),
    );
    return {
      document_id: r.document.id,
      upload_url: r.upload.url,
      upload_method: r.upload.method,
      upload_headers: r.upload.headers,
      expires_at: new Date(r.upload.expiresAtMs).toISOString(),
    };
  }

  @Post("applications/:id/documents/:documentId/confirm")
  @AllowSellerEnrol()
  @HttpCode(200)
  @AuthenticatedSelf("seller_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 3600 }])
  async confirmDocument(@Req() req: ApiRequest, @Param(new ZodPipe(DocParam, "/params")) p: z.infer<typeof DocParam>, @Body(new ZodPipe(ConfirmBody)) _b: z.output<typeof ConfirmBody>) {
    const r = unwrap(await this.svc.confirmDocument(principalOf(req).actor.id, p.id, p.documentId));
    return documentWire(r.document, r.app.filenames.get(r.document.id) ?? null);
  }

  @Delete("applications/:id/documents/:documentId")
  @AllowSellerEnrol()
  @HttpCode(204)
  @AuthenticatedSelf("seller_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 3600 }])
  async deleteDocument(@Req() req: ApiRequest, @Param(new ZodPipe(DocParam, "/params")) p: z.infer<typeof DocParam>): Promise<void> {
    unwrap(await this.svc.deleteDocument(principalOf(req).actor.id, p.id, p.documentId));
  }

  @Get("onboarding-checklist")
  @AuthenticatedSelf("seller_api")
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async checklist(@Req() req: ApiRequest) {
    requireFullSession(req);
    const c = await this.svc.onboardingChecklist(principalOf(req).actor.id);
    if (c === null) throw Problems.notFound();
    return { store_id: c.storeId, items: c.items.map((i) => ({ code: i.code, done: i.done, required_for_publish: i.requiredForPublish })) };
  }
}
