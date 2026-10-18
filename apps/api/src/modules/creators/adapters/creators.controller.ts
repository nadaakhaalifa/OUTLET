import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import { z } from "zod";
import { AuthenticatedSelf, Idempotent, Public, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import { LINK_TARGET_TYPES, PAYOUT_PREFS, CREATOR_STATUSES, type UaClass } from "../domain/bridge";
import type { ApplyAsCreator, DecideCreator, SetPayoutPreference } from "../application/accounts";
import type { GetCreatorDashboard, ListMyCommissions } from "../application/commissions";
import type { CreateLink, DisableLink, GetPublicCreator, ListLinks, LookCommands, RecordClick } from "../application/links";
import type { VoidAttribution } from "../application/links";
import type { CreatorPayoutCommands, ListCreatorPayouts, PayoutResult } from "../application/payouts";
import type { CreatorIdentityPort, CreatorStore } from "../domain/ports";
import { CreatorAdminAccess } from "./access";
import { clickIpHash } from "./click-hash";
import { INSTALL_TOKEN_TTL_MS, issueInstallToken, signedDeviceHash, unsignedDeviceHash, verifyInstallToken } from "./install-token";
import { CLOCK } from "../../../platform/tokens";
import type { Clock } from "../../../platform/ports";
import {
  APPLY_AS_CREATOR,
  CREATE_LINK,
  CREATOR_IDENTITY,
  CREATOR_OPTIONS,
  CREATOR_PAYOUT_COMMANDS,
  CREATOR_STORE,
  DECIDE_CREATOR,
  DISABLE_LINK,
  GET_CREATOR_DASHBOARD,
  GET_PUBLIC_CREATOR,
  LIST_CREATOR_PAYOUTS,
  LIST_LINKS,
  LIST_MY_COMMISSIONS,
  LOOK_COMMANDS,
  RECORD_CLICK,
  SET_PAYOUT_PREFERENCE,
  VOID_ATTRIBUTION,
} from "./tokens";
import { accountWire, adminAccountWire, adminPayoutWire, commissionWire, dashboardWire, linkWire, lookWire, payoutWire } from "./wire";
import type { CreatorRuntimeOptions } from "../application/shared";

const IdParam = z.object({ id: z.uuid() }).strict();
const LinkParam = z.object({ linkId: z.uuid() }).strict();
const LookParam = z.object({ lookId: z.uuid() }).strict();
const HandleParam = z.object({ handle: z.string().regex(/^[a-z][a-z0-9_]{2,29}$/) }).strict();

const ApplySchema = z
  .object({
    handle: z.string().min(3).max(30),
    display_name: z.string().min(1).max(60),
    legal_name: z.string().min(2).max(120),
    national_id: z.string().min(8).max(32),
    payout_iban: z.string().min(15).max(34).nullable().default(null),
    payout_account_name: z.string().min(2).max(120).nullable().default(null),
    // VERIFY BEFORE LAUNCH (VR-P3-03): tax form fields, final shape pending Tax counsel.
    tax_id: z.string().min(3).max(32).nullable().default(null),
    tax_form: z.string().min(1).max(2000).nullable().default(null),
    accept_terms_version: z.number().int().min(1),
  })
  .strict();
const LinkSchema = z.object({ target_type: z.enum(LINK_TARGET_TYPES), target_id: z.uuid() }).strict();
const LookCreateSchema = z
  .object({ title: z.string().min(1).max(80), product_ids: z.array(z.uuid()).min(1).max(12) })
  .strict();
const LookUpdateSchema = z
  .object({ title: z.string().min(1).max(80).optional(), product_ids: z.array(z.uuid()).min(1).max(12).optional() })
  .strict();
const PrefSchema = z.object({ preference: z.enum(PAYOUT_PREFS) }).strict();
const CommissionsQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(50).default(20), before: z.iso.datetime().optional() })
  .strict();
const ClickSchema = z
  .object({ slug: z.string().regex(/^[A-Za-z0-9_-]{10,40}$/), device_id: z.string().min(8).max(128) })
  .strict();
const InstallTokenSchema = z.object({ device_id: z.string().min(8).max(128) }).strict();
const AdminListQuery = z.object({ status: z.enum(CREATOR_STATUSES).default("APPLIED"), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();
const DecisionSchema = z
  .object({ action: z.enum(["approve", "reject", "needs_info", "suspend", "reinstate"]), reason: z.string().min(1).max(200).nullable().default(null) })
  .strict();
/** Manual voids carry one of the fraud reason codes; free text is not accepted (audit-friendly). */
const VoidSchema = z.object({ reason: z.enum(["self_purchase", "same_device", "shared_payment", "shared_address", "cluster"]) }).strict();
const TakedownSchema = z.object({ reason: z.string().min(1).max(200) }).strict();
const PayoutCreateSchema = z.object({ creator_id: z.uuid() }).strict();
const OutcomeSchema = z
  .object({
    outcome: z.enum(["settled", "rejected"]),
    provider_ref: z.string().min(1).max(128).nullable().default(null),
    reason: z.string().min(1).max(128).nullable().default(null),
  })
  .strict();
const PayoutListQuery = z
  .object({
    status: z.enum(["SCHEDULED", "ON_HOLD", "APPROVED", "SENT", "SETTLED", "FAILED", "CANCELLED"]).optional(),
    creator_id: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

function principalOf(req: ApiRequest) {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
}
const userIdOf = (req: ApiRequest): string => principalOf(req).actor.id;
const conflict = (slug: string, title: string, code: string) => new ProblemError(409, slug, title, { code });

const BOT_UA = /bot|crawl|spider|slurp|curl\/|wget|python-requests|httpclient|axios|node-fetch|go-http|java\//i;
const HEADLESS_UA = /headless|puppeteer|playwright|phantom|selenium/i;

/** Click user agent class. No UA at all is treated as a bot (spec: no session, headless user agent). */
export function classifyUserAgent(ua: string | undefined): UaClass {
  if (ua === undefined || ua.trim() === "") return "bot";
  if (HEADLESS_UA.test(ua)) return "headless";
  if (BOT_UA.test(ua)) return "bot";
  return /OutletApp\//.test(ua) ? "app" : "browser";
}

// --------------------------------------------------------------------------- public + creator self

@Controller()
export class CreatorsController {
  constructor(
    @Inject(CREATOR_OPTIONS) private readonly opts: CreatorRuntimeOptions,
    @Inject(APPLY_AS_CREATOR) private readonly apply: ApplyAsCreator,
    @Inject(GET_CREATOR_DASHBOARD) private readonly dashboard: GetCreatorDashboard,
    @Inject(CREATE_LINK) private readonly createLink: CreateLink,
    @Inject(LIST_LINKS) private readonly listLinks: ListLinks,
    @Inject(DISABLE_LINK) private readonly disableLink: DisableLink,
    @Inject(LOOK_COMMANDS) private readonly looks: LookCommands,
    @Inject(LIST_MY_COMMISSIONS) private readonly commissions: ListMyCommissions,
    @Inject(LIST_CREATOR_PAYOUTS) private readonly payouts: ListCreatorPayouts,
    @Inject(SET_PAYOUT_PREFERENCE) private readonly setPref: SetPayoutPreference,
    @Inject(RECORD_CLICK) private readonly click: RecordClick,
    @Inject(GET_PUBLIC_CREATOR) private readonly publicCreator: GetPublicCreator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CREATOR_IDENTITY) private readonly identity: CreatorIdentityPort,
  ) {}

  /** Keyed by the token subject: there is no creator id in the URL, so no BOLA surface. */
  @Post("creator/apply")
  @HttpCode(201)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([
    { dimension: "user", limit: 5, windowSeconds: 3600 },
    { dimension: "ip", limit: 20, windowSeconds: 3600 },
  ])
  async applyRoute(@Req() req: ApiRequest, @Body(new ZodPipe(ApplySchema)) b: z.infer<typeof ApplySchema>) {
    const r = await this.apply.execute(userIdOf(req), {
      handle: b.handle,
      displayName: b.display_name,
      legalName: b.legal_name,
      nationalId: b.national_id,
      payoutIban: b.payout_iban,
      payoutName: b.payout_account_name,
      taxId: b.tax_id,
      taxForm: b.tax_form,
      acceptTermsVersion: b.accept_terms_version,
    });
    switch (r.kind) {
      case "applied":
      case "already_applied":
        return accountWire(r.account);
      case "ineligible":
        throw new ProblemError(422, "creator-ineligible", "You cannot apply as a creator", {
          code: "creator_ineligible",
          extensions: { reason: r.reason },
        });
      case "handle_taken":
        throw conflict("handle-taken", "That handle is not available", "handle_taken");
      case "conflict":
        throw conflict("application-conflict", "The application could not be accepted", "application_conflict");
      case "unavailable":
        throw Problems.unavailable("creator_program_unavailable");
    }
  }

  @Get("creator/dashboard")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async dashboardRoute(@Req() req: ApiRequest) {
    const d = await this.dashboard.execute(userIdOf(req));
    if (d === null) throw Problems.notFound();
    return dashboardWire(d);
  }

  @Post("creator/links")
  @HttpCode(201)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 3600 }])
  async createLinkRoute(@Req() req: ApiRequest, @Body(new ZodPipe(LinkSchema)) b: z.infer<typeof LinkSchema>) {
    const r = await this.createLink.execute(userIdOf(req), b.target_type, b.target_id);
    switch (r.kind) {
      case "created":
      case "exists":
        return linkWire(r.link, this.opts.linkBase);
      case "no_account":
        throw Problems.notFound();
      case "not_eligible":
        throw Problems.forbidden("creator_not_active");
      case "target_not_found":
        throw Problems.notFound();
      case "seller_conflict":
        throw new ProblemError(422, "seller-conflict", "You cannot link your own store", { code: "seller_conflict" });
      case "unavailable":
        throw Problems.unavailable("creator_program_unavailable");
    }
  }

  @Get("creator/links")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async listLinksRoute(@Req() req: ApiRequest) {
    const links = await this.listLinks.execute(userIdOf(req));
    if (links === null) throw Problems.notFound();
    return { items: links.map((l) => linkWire(l, this.opts.linkBase)) };
  }

  /** Another creator's link id answers exactly like a missing one. */
  @Delete("creator/links/:linkId")
  @HttpCode(204)
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async disableLinkRoute(@Req() req: ApiRequest, @Param(new ZodPipe(LinkParam, "/params")) p: z.infer<typeof LinkParam>) {
    if (!(await this.disableLink.execute(userIdOf(req), p.linkId))) throw Problems.notFound();
  }

  private lookOr404<T extends { kind: string }>(r: T): T {
    switch (r.kind) {
      case "not_found":
      case "no_account":
        throw Problems.notFound();
      case "not_eligible":
        throw Problems.forbidden("creator_not_active");
      case "unknown_products":
        throw new ProblemError(422, "unknown-products", "A look can only contain real catalog items", { code: "unknown_products" });
      case "invalid_state":
        throw conflict("invalid-state", "That look cannot change in its current state", "invalid_state");
      case "unavailable":
        throw Problems.unavailable("creator_program_unavailable");
      default:
        return r;
    }
  }

  @Post("creator/looks")
  @HttpCode(201)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 3600 }])
  async createLook(@Req() req: ApiRequest, @Body(new ZodPipe(LookCreateSchema)) b: z.infer<typeof LookCreateSchema>) {
    const r = this.lookOr404(await this.looks.create(userIdOf(req), { title: b.title, productIds: b.product_ids }));
    return r.kind === "ok" ? lookWire(r.look) : Problems.notFound();
  }

  @Get("creator/looks")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async listLooks(@Req() req: ApiRequest) {
    const l = await this.looks.list(userIdOf(req));
    if (l === null) throw Problems.notFound();
    return { items: l.map(lookWire) };
  }

  @Patch("creator/looks/:lookId")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async updateLook(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(LookParam, "/params")) p: z.infer<typeof LookParam>,
    @Body(new ZodPipe(LookUpdateSchema)) b: z.infer<typeof LookUpdateSchema>,
  ) {
    const r = this.lookOr404(
      await this.looks.update(userIdOf(req), p.lookId, {
        ...(b.title !== undefined ? { title: b.title } : {}),
        ...(b.product_ids !== undefined ? { productIds: b.product_ids } : {}),
      }),
    );
    return r.kind === "ok" ? lookWire(r.look) : Problems.notFound();
  }

  @Post("creator/looks/:lookId/publish")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 3600 }])
  async publishLook(@Req() req: ApiRequest, @Param(new ZodPipe(LookParam, "/params")) p: z.infer<typeof LookParam>) {
    const r = this.lookOr404(await this.looks.publish(userIdOf(req), p.lookId));
    return r.kind === "ok" ? lookWire(r.look) : Problems.notFound();
  }

  @Delete("creator/looks/:lookId")
  @HttpCode(204)
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async archiveLook(@Req() req: ApiRequest, @Param(new ZodPipe(LookParam, "/params")) p: z.infer<typeof LookParam>) {
    this.lookOr404(await this.looks.archive(userIdOf(req), p.lookId));
  }

  @Get("creator/commissions")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async commissionsRoute(@Req() req: ApiRequest, @Query(new ZodPipe(CommissionsQuery, "/query")) q: z.output<typeof CommissionsQuery>) {
    const before = q.before === undefined ? null : Date.parse(q.before);
    const rows = await this.commissions.execute(userIdOf(req), q.limit + 1, before);
    if (rows === null) throw Problems.notFound();
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(commissionWire),
      page: {
        next_before: rows.length > q.limit && last !== undefined ? new Date(last.closedAtMs).toISOString() : null,
        has_more: rows.length > q.limit,
      },
    };
  }

  @Get("creator/payouts")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async myPayouts(@Req() req: ApiRequest) {
    const rows = await this.payouts.forCreator(userIdOf(req), 50);
    if (rows === null) throw Problems.notFound();
    return { items: rows.map(payoutWire) };
  }

  @Post("creator/payout-preference")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 3600 }])
  async payoutPreference(@Req() req: ApiRequest, @Body(new ZodPipe(PrefSchema)) b: z.infer<typeof PrefSchema>) {
    if (!(await this.setPref.execute(userIdOf(req), b.preference))) throw Problems.notFound();
    return { payout_preference: b.preference };
  }

  /**
   * Public, no PII: handle, display name and published looks of an ACTIVE creator. Unknown,
   * suspended and applied creators are all 404.
   */
  @Get("c/:handle")
  @Public()
  @RateLimit([{ dimension: "ip", limit: 120, windowSeconds: 60 }])
  async publicProfile(@Param(new ZodPipe(HandleParam, "/params")) p: z.infer<typeof HandleParam>) {
    const v = await this.publicCreator.execute(p.handle);
    if (v === null) throw Problems.notFound();
    return {
      handle: v.handle,
      display_name: v.displayName,
      disclosure_key: "creator.affiliate_disclosure",
      looks: v.looks.map((l) => ({ id: l.id, title: l.title, product_ids: l.productIds })),
    };
  }

  /**
   * Mints the install token a client must present on `POST /v1/affiliate/clicks` for the click to be
   * eligible for commission attribution. Authenticated sessions only; the token is bound to the device
   * id the session sends (`x-device-id`, or the body for web) and lives 15 minutes.
   */
  @Post("affiliate/install-tokens")
  @HttpCode(201)
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 3600 }])
  async installToken(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse, @Body(new ZodPipe(InstallTokenSchema)) b: z.infer<typeof InstallTokenSchema>) {
    res.setHeader("Cache-Control", "no-store");
    const userId = userIdOf(req);
    const deviceId = headerValue(req, "x-device-id") ?? b.device_id;
    // A-1: the token can only be minted for a device registered to the caller. A foreign or unknown
    // device id answers exactly like a missing resource (no oracle on whose device it is).
    const me = await this.identity.profile(userId);
    const own = signedDeviceHash(this.opts.clickSalt, deviceId);
    if (me === null || !me.deviceHashes.includes(own)) throw Problems.notFound();
    const t = issueInstallToken({ salt: this.opts.clickSalt, deviceId, nowMs: this.clock.nowMs(), ttlMs: INSTALL_TOKEN_TTL_MS });
    return { install_token: t.token, expires_at: new Date(t.expiresAtMs).toISOString() };
  }

  /**
   * Public click ingest. Always 202 so it is not a way to probe which slugs exist; attribution is
   * decided later at order time from the buyer's own devices, never from this response.
   *
   * A click carrying a valid install token for THIS device id is stored under the device's click hash
   * and can attribute. Every other click (absent, forged, expired or another device's token) is still
   * stored and counted, under a domain-separated hash that never matches a buyer, so it can never be
   * the attributed click.
   */
  @Post("affiliate/clicks")
  @HttpCode(202)
  @Public()
  @RateLimit([
    { dimension: "ip", limit: 120, windowSeconds: 60 },
    { dimension: "device", limit: 60, windowSeconds: 60 },
  ])
  async recordClick(@Req() req: ApiRequest, @Body(new ZodPipe(ClickSchema)) b: z.infer<typeof ClickSchema>) {
    // The header is the channel the platform rate limiter already keys on; prefer it over the body.
    const deviceId = headerValue(req, "x-device-id") ?? b.device_id;
    const verdict = verifyInstallToken({
      salt: this.opts.clickSalt,
      token: headerValue(req, "x-install-token"),
      deviceId,
      nowMs: this.clock.nowMs(),
    });
    const r = await this.click.execute({
      slug: b.slug,
      deviceHash: verdict === "valid" ? signedDeviceHash(this.opts.clickSalt, deviceId) : unsignedDeviceHash(this.opts.clickSalt, deviceId),
      ipHash: clickIpHash(this.opts.clickSalt, req.ip ?? "unknown"),
      uaClass: classifyUserAgent(headerValue(req, "user-agent")),
    });
    return r.kind === "recorded" ? { target_type: r.targetType, target_id: r.targetId } : { target_type: null, target_id: null };
  }
}

// --------------------------------------------------------------------------- admin

function payoutOr(r: PayoutResult) {
  switch (r.kind) {
    case "ok":
      return adminPayoutWire(r.payout);
    case "not_found":
      throw Problems.notFound();
    case "disabled":
      throw Problems.unavailable("creator_payouts_disabled");
    case "provider_unconfigured":
      throw Problems.unavailable("creator_payout_provider_unconfigured");
    case "approval_required":
      throw new ProblemError(403, "dual-approval-required", "A different approver must approve this amount first", { code: "dual_approval_required" });
    case "invalid_transition":
      throw conflict("invalid-transition", "That action is not possible for this payout's status", "invalid_transition");
    case "conflict":
      throw conflict("payout-conflict", "The payout changed; reload and retry", "payout_conflict");
    case "open_exists":
      throw conflict("open-payout-exists", "This creator already has an open payout", "open_payout_exists");
    case "held":
      throw conflict("payout-held", "The payout was put on hold", "payout_held");
    case "ineligible":
      throw new ProblemError(422, "creator-not-payable", "This creator cannot be paid", { code: "creator_not_payable", extensions: { reason: r.reason } });
    case "credit_preference":
      throw new ProblemError(422, "credit-preference", "This creator chose store credit", { code: "credit_preference" });
    case "nothing_payable":
      throw new ProblemError(422, "nothing-payable", "Nothing is payable", { code: "nothing_payable" });
    case "negative_balance":
      throw new ProblemError(422, "negative-balance", "The creator balance is negative", { code: "negative_balance" });
    case "below_minimum":
      throw new ProblemError(422, "below-minimum", "Below the minimum payout", { code: "below_minimum" });
  }
}

@Controller("admin")
export class CreatorsAdminController {
  constructor(
    @Inject(CreatorAdminAccess) private readonly access: CreatorAdminAccess,
    @Inject(CREATOR_STORE) private readonly store: CreatorStore,
    @Inject(DECIDE_CREATOR) private readonly decide: DecideCreator,
    @Inject(LOOK_COMMANDS) private readonly looks: LookCommands,
    @Inject(CREATOR_PAYOUT_COMMANDS) private readonly payouts: CreatorPayoutCommands,
    @Inject(LIST_CREATOR_PAYOUTS) private readonly list: ListCreatorPayouts,
    @Inject(VOID_ATTRIBUTION) private readonly voidAttribution: VoidAttribution,
  ) {}

  /**
   * A-3 caller of VoidAttribution (ADR-0037): trust and safety (or super admin) voids a creator
   * attribution found fraudulent after accrual or payout. `:id` is the order group id. The role gate
   * records the policy decision in the audit sink BEFORE the action runs; the use case voids and plans
   * the full clawback in one store transaction and the poster posts the idempotent reversing entries
   * through the existing ledger port. A paid commission leaves an explicit negative payable.
   */
  @Post("creators/attributions/:id/void")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async voidAttributionRoute(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>,
    @Body(new ZodPipe(VoidSchema)) b: z.infer<typeof VoidSchema>,
  ) {
    await this.access.voidAttribution(principalOf(req).actor, p.id);
    const r = await this.voidAttribution.execute({ orderGroupId: p.id, reason: b.reason });
    switch (r.kind) {
      case "not_found":
        throw Problems.notFound();
      case "already_voided":
        return { status: "already_voided", commissions_affected: 0, clawed_back: "0" };
      case "voided":
        return { status: "voided", commissions_affected: r.commissionsAffected, clawed_back: r.clawedBack.toString() };
    }
  }

  @Get("creators")
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async creators(@Req() req: ApiRequest, @Query(new ZodPipe(AdminListQuery, "/query")) q: z.output<typeof AdminListQuery>) {
    await this.access.trustSafety(principalOf(req).actor);
    const rows = await this.store.listByStatus(q.status, q.limit);
    return { items: rows.map(adminAccountWire) };
  }

  @Post("creators/:id/decision")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async decision(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>,
    @Body(new ZodPipe(DecisionSchema)) b: z.infer<typeof DecisionSchema>,
  ) {
    const actor = principalOf(req).actor;
    await this.access.review(actor);
    const r = await this.decide.execute({ creatorId: p.id, action: b.action, reason: b.reason, reviewerId: actor.id });
    switch (r.kind) {
      case "ok":
        return adminAccountWire(r.account);
      case "not_found":
        throw Problems.notFound();
      case "invalid_state":
        throw conflict("invalid-state", "That decision is not possible for this creator's status", "invalid_state");
      case "ineligible":
        throw new ProblemError(422, "creator-ineligible", "The creator is not eligible", { code: "creator_ineligible", extensions: { reason: r.reason } });
      case "evidence_required":
        throw new ProblemError(422, "review-evidence-required", "Approval records the review evidence in `reason`", { code: "review_evidence_required" });
    }
  }

  @Post("creator-looks/:id/takedown")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async takedown(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>,
    @Body(new ZodPipe(TakedownSchema)) b: z.infer<typeof TakedownSchema>,
  ) {
    await this.access.review(principalOf(req).actor);
    const r = await this.looks.takedown(p.id, b.reason);
    if (r.kind !== "ok") throw Problems.notFound();
    return lookWire(r.look);
  }

  @Get("creator-payouts")
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async payoutList(@Req() req: ApiRequest, @Query(new ZodPipe(PayoutListQuery, "/query")) q: z.output<typeof PayoutListQuery>) {
    await this.access.require(principalOf(req).actor, "payout");
    const rows = await this.list.forAdmin({
      ...(q.creator_id !== undefined ? { creatorId: q.creator_id } : {}),
      ...(q.status !== undefined ? { state: q.status } : {}),
      limit: q.limit,
    });
    return { items: rows.map(adminPayoutWire) };
  }

  @Post("creator-payouts")
  @HttpCode(201)
  @AuthenticatedSelf("admin_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async createPayout(@Req() req: ApiRequest, @Body(new ZodPipe(PayoutCreateSchema)) b: z.infer<typeof PayoutCreateSchema>) {
    const actor = principalOf(req).actor;
    await this.access.finance(actor);
    return payoutOr(await this.payouts.create({ creatorId: b.creator_id, requestedBy: actor.id }));
  }

  @Post("creator-payouts/:id/approve")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async approvePayout(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    const actor = principalOf(req).actor;
    await this.access.finance(actor);
    return payoutOr(await this.payouts.approve({ payoutId: p.id, approverId: actor.id }));
  }

  @Post("creator-payouts/:id/send")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async sendPayout(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    await this.access.finance(principalOf(req).actor);
    return payoutOr(await this.payouts.send({ payoutId: p.id }));
  }

  @Post("creator-payouts/:id/outcome")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async payoutOutcome(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>,
    @Body(new ZodPipe(OutcomeSchema)) b: z.infer<typeof OutcomeSchema>,
  ) {
    await this.access.finance(principalOf(req).actor);
    return payoutOr(await this.payouts.recordOutcome({ payoutId: p.id, outcome: b.outcome, providerRef: b.provider_ref, reason: b.reason }));
  }

  @Post("creator-payouts/:id/cancel")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async cancelPayout(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    await this.access.finance(principalOf(req).actor);
    return payoutOr(await this.payouts.cancel({ payoutId: p.id }));
  }
}
