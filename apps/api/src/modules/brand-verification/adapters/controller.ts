import { Body, Controller, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { Authorize, AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import { CONFLICT_OUTCOMES, EMAIL_LOCAL_PARTS } from "../domain/bridge";
import {
  MARK_STATUSES,
  type ApplicationOwnershipPort,
  type ApplicationSnapshot,
  type BrandVerificationPort,
  type ConflictRecord,
  type DomainVerificationView,
  type MarkStatus,
  type TrademarkEvidenceView,
  type TrademarkOffice,
} from "../domain/ports";
import { APPLICATION_OWNERSHIP, BRAND_VERIFICATION, BRAND_VERIFICATION_ADMIN_RESOLVER } from "./tokens";

const IdParam = z.object({ id: z.uuid() }).strict();
const StartBody = z.object({ method: z.enum(["dns_txt", "email"]), email_local_part: z.enum(EMAIL_LOCAL_PARTS).optional() }).strict();
const ConfirmBody = z.object({ code: z.string().regex(/^[0-9]{6}$/).optional() }).strict();
const SOURCES = ["WIPO", "EUIPO", "USPTO", "EGYPT_TMO", "OTHER_NATIONAL", "MANUAL"] as const;
const TrademarkBody = z
  .object({
    mode: z.enum(["auto", "manual"]),
    manual: z
      .object({
        id: z.uuid().optional(),
        source: z.enum(SOURCES),
        register_number: z.string().min(1).max(64),
        found: z.boolean(),
        owner_name: z.string().min(1).max(300).optional(),
        status: z.string().max(40).optional(),
        classes: z.array(z.number().int().min(1).max(45)).max(45).optional(),
        owner_matches_applicant: z.enum(["yes", "no", "unknown"]).optional(),
        retrieved_at: z.string().max(40).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((b) => (b.mode === "manual") === (b.manual !== undefined), { message: "manual is required exactly when mode is manual" });
const ConflictBody = z.object({ outcome: z.enum(CONFLICT_OUTCOMES), internal_note: z.string().min(1).max(4000) }).strict();

const SELLER_SCOPES = ["seller:enrol", "seller:kyc.write"];
const TM_ROLES = ["ops", "trust_safety", "super_admin"];
const CONFLICT_ROLES = ["trust_safety", "super_admin"];
const iso = (ms: number): string => new Date(ms).toISOString();

function principalOf(req: ApiRequest) {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
}
const problem = (status: number, slug: string, title: string, code: string, extensions?: Record<string, string | number | boolean | null>) =>
  new ProblemError(status, slug, title, { code, ...(extensions !== undefined ? { extensions } : {}) });

export function domainVerificationWire(v: DomainVerificationView) {
  return {
    method: v.method,
    domain: v.domain,
    status: v.status,
    ...(v.txtRecordName !== undefined ? { txt_record_name: v.txtRecordName } : {}),
    ...(v.txtRecordValue !== undefined ? { txt_record_value: v.txtRecordValue } : {}),
    ...(v.emailSentToMasked !== undefined ? { email_sent_to_masked: v.emailSentToMasked } : {}),
    expires_at: iso(v.expiresAtMs),
    verified_at: v.verifiedAtMs === null ? null : iso(v.verifiedAtMs),
  };
}

const OFFICE_TO_SOURCE: Record<TrademarkOffice, (typeof SOURCES)[number]> = {
  WIPO: "WIPO", EUIPO: "EUIPO", USPTO: "USPTO", "EGYPT-IP": "EGYPT_TMO", OTHER: "OTHER_NATIONAL",
};
const SOURCE_TO_OFFICE: Record<(typeof SOURCES)[number], TrademarkOffice> = {
  WIPO: "WIPO", EUIPO: "EUIPO", USPTO: "USPTO", EGYPT_TMO: "EGYPT-IP", OTHER_NATIONAL: "OTHER", MANUAL: "OTHER",
};
export function trademarkEvidenceWire(e: TrademarkEvidenceView) {
  return {
    id: e.id,
    source: e.source === "manual" ? "MANUAL" : OFFICE_TO_SOURCE[e.office],
    register_number: e.registerNumber,
    found: e.found,
    ...(e.ownerName !== null ? { owner_name: e.ownerName } : {}),
    ...(e.status !== null ? { status: e.status } : {}),
    classes: [...e.classes],
    owner_matches_applicant: e.ownerMatchesApplicant,
    retrieved_at: iso(e.retrievedAtMs),
  };
}

export function conflictWire(c: ConflictRecord) {
  return {
    conflict_id: c.id,
    status: c.status,
    outcome: c.outcome,
    winner_application_id: c.winnerApplicationId,
    application_ids: [...c.applicationIds],
    resolved_at: c.resolvedAtMs === null ? null : iso(c.resolvedAtMs),
  };
}

// --------------------------------------------------------------------------- seller

@Controller("seller/applications")
export class BrandDomainVerificationController {
  constructor(
    @Inject(BRAND_VERIFICATION) private readonly verification: BrandVerificationPort,
    @Inject(APPLICATION_OWNERSHIP) private readonly applications: ApplicationOwnershipPort,
  ) {}

  /** Token scope, then ownership. Unknown and foreign applications are both 404 (no enumeration). */
  private async owned(req: ApiRequest, id: string): Promise<ApplicationSnapshot> {
    const actor = principalOf(req).actor;
    if (!actor.tokenScopes.some((s) => SELLER_SCOPES.includes(s))) throw Problems.forbidden();
    const snap = await this.applications.find(id.toLowerCase());
    if (snap === null || snap.applicantId !== actor.id) throw Problems.notFound();
    return snap;
  }

  @Post(":id/domain-verification")
  @HttpCode(200)
  @AuthenticatedSelf("seller_api")
  @Idempotent({ required: true })
  @RateLimit([
    { dimension: "user", limit: 5, windowSeconds: 3600 },
    { dimension: "ip", limit: 30, windowSeconds: 3600 },
  ])
  async start(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>, @Body(new ZodPipe(StartBody)) body: z.infer<typeof StartBody>) {
    const snap = await this.owned(req, p.id);
    if (snap.websiteDomain === null) throw problem(422, "domain-not-set", "Set the website domain on the application first", "domain_not_set");
    const r = await this.verification.startDomainVerification({
      snapshot: snap,
      rawDomain: snap.websiteDomain,
      method: body.method,
      ...(body.email_local_part !== undefined ? { emailLocalPart: body.email_local_part } : {}),
    });
    switch (r.kind) {
      case "started":
        return domainVerificationWire(r.verification);
      case "invalid_domain":
        throw problem(422, "invalid-domain", "This website domain cannot be verified", "invalid_domain", { reason: r.reason });
      case "email_unavailable":
        throw new ProblemError(503, "email-unavailable", "The verification email could not be sent; try again later", { code: "email_unavailable", headers: { "Retry-After": "300" } });
      case "conflict":
        throw problem(409, "verification-conflict", "The verification changed; retry", "verification_conflict");
    }
  }

  @Post(":id/domain-verification/confirm")
  @HttpCode(200)
  @AuthenticatedSelf("seller_api")
  @Idempotent({ required: true })
  @RateLimit([
    { dimension: "user", limit: 20, windowSeconds: 3600 },
    { dimension: "challenge", limit: 10, windowSeconds: 3600 },
  ])
  async confirm(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>, @Body(new ZodPipe(ConfirmBody)) body: z.infer<typeof ConfirmBody>) {
    const snap = await this.owned(req, p.id);
    const r = await this.verification.confirmDomainVerification({ snapshot: snap, ...(body.code !== undefined ? { code: body.code } : {}) });
    switch (r.kind) {
      case "confirmed":
      case "pending":
        return domainVerificationWire(r.verification);
      case "not_started":
        throw problem(409, "verification-not-started", "Start the verification first", "verification_not_started");
      case "code_required":
        throw Problems.validation([{ pointer: "/body/code", code: "required" }]);
      case "wrong_code":
        throw problem(422, "invalid-code", "The code is not correct", "invalid_code", { attempts_remaining: r.attemptsRemaining });
      case "locked":
        throw problem(409, "challenge-locked", "Too many attempts; start the verification again", "challenge_locked");
      case "expired":
        throw problem(409, "challenge-expired", "The challenge expired; start the verification again", "challenge_expired");
      case "conflict":
        throw problem(409, "verification-conflict", "The verification changed; retry", "verification_conflict");
    }
  }
}

// --------------------------------------------------------------------------- admin

@Controller("admin/brand-applications")
export class BrandVerificationAdminController {
  constructor(
    @Inject(BRAND_VERIFICATION) private readonly verification: BrandVerificationPort,
    @Inject(APPLICATION_OWNERSHIP) private readonly applications: ApplicationOwnershipPort,
  ) {}

  private actorId(req: ApiRequest, roles: readonly string[]): string {
    const actor = principalOf(req).actor;
    if (!actor.grants.some((g) => g.kind === "admin" && roles.includes(g.role))) throw Problems.forbidden();
    return actor.id;
  }

  @Post(":id/trademark-lookup")
  @HttpCode(200)
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: BRAND_VERIFICATION_ADMIN_RESOLVER, idParam: "none" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async trademark(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>, @Body(new ZodPipe(TrademarkBody)) body: z.infer<typeof TrademarkBody>) {
    const actorId = this.actorId(req, TM_ROLES);
    const snap = await this.applications.find(p.id.toLowerCase());
    if (snap === null) throw Problems.notFound();
    const m = body.manual;
    const r = await this.verification.recordTrademarkLookup({
      snapshot: snap,
      mode: body.mode,
      actorId,
      ...(m === undefined
        ? {}
        : {
            manual: {
              office: SOURCE_TO_OFFICE[m.source],
              registerNumber: m.register_number,
              found: m.found,
              ...(m.owner_name !== undefined ? { ownerName: m.owner_name } : {}),
              ...(m.status !== undefined ? { status: ((MARK_STATUSES as readonly string[]).includes(m.status) ? m.status : "unknown") as MarkStatus } : {}),
              ...(m.classes !== undefined ? { classes: m.classes } : {}),
            },
          }),
    });
    if (r.kind === "no_trademark_claimed") throw problem(422, "no-trademark-claimed", "The application does not claim a trademark", "no_trademark_claimed");
    return trademarkEvidenceWire(r.evidence);
  }

  @Post(":id/conflict-resolution")
  @HttpCode(200)
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: BRAND_VERIFICATION_ADMIN_RESOLVER, idParam: "none" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async resolve(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>, @Body(new ZodPipe(ConflictBody)) body: z.infer<typeof ConflictBody>) {
    const actorId = this.actorId(req, CONFLICT_ROLES);
    const r = await this.verification.resolveConflict({ applicationId: p.id.toLowerCase(), outcome: body.outcome, actorId, internalNote: body.internal_note });
    switch (r.kind) {
      case "resolved":
      case "replayed":
        return conflictWire(r.conflict);
      case "not_found":
        throw Problems.notFound();
      case "already_resolved_differently":
        throw problem(409, "conflict-already-resolved", "This conflict was already resolved with a different outcome", "conflict_already_resolved");
    }
  }
}
