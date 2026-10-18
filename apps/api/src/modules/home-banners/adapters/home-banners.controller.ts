import { createHash } from "node:crypto";
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import { z } from "zod";
import { Authorize, AuthenticatedSelf, Idempotent, Public, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { assertGuestBrowsingEnabled, assertPublicReadEnabled, PUBLIC_CACHE, respondPublic, type PublicReadGate } from "../../../platform/public-read";
import { ZodPipe } from "../../../platform/zod.pipe";
import type {
  ChangeBannerStatus,
  CreateBanner,
  DeleteBanner,
  GetBannerAdmin,
  ListActiveBanners,
  ListBannersAdmin,
  Outcome,
  PreviewBanners,
  UpdateBanner,
  BannerPatch,
} from "../application/banners";
import { ART_VARIANTS, LIMITS, MAX_PRICE_PIASTRES, type BannerCta, type BannerDraft } from "../domain/banner";
import type { BannerImageUrlPort } from "../domain/ports";
import type { Clock } from "../../../platform/ports";
import { CLOCK, GUEST_BROWSING_GATE, PUBLIC_READ_GATE } from "../../../platform/tokens";
import {
  CHANGE_HOME_BANNER_STATUS,
  CREATE_HOME_BANNER,
  DELETE_HOME_BANNER,
  GET_HOME_BANNER_ADMIN,
  HOME_BANNER_ADMIN_RESOLVER,
  HOME_BANNER_IMAGES,
  LIST_ACTIVE_HOME_BANNERS,
  LIST_HOME_BANNERS_ADMIN,
  PREVIEW_HOME_BANNERS,
  UPDATE_HOME_BANNER,
} from "./tokens";
import { adminWire, publicWire } from "./wire";

const ADMIN_ROLES = ["marketing", "ops", "super_admin"] as const;
const IdParam = z.object({ id: z.uuid() }).strict();
const Bilingual = z.object({ ar: z.string().min(1).max(LIMITS.title), en: z.string().min(1).max(LIMITS.title).optional() }).strict();
const BilingualSub = z.object({ ar: z.string().min(1).max(LIMITS.subtitle), en: z.string().min(1).max(LIMITS.subtitle).optional() }).strict();
const Piastres = z.number().int().min(0).max(Number(MAX_PRICE_PIASTRES));
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Cta = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["drop", "store", "voucher"]), target_id: Id }).strict(),
  z.object({ kind: z.literal("category"), target_id: Id, price_min: Piastres.optional(), price_max: Piastres.optional() }).strict(),
  z.object({ kind: z.literal("search"), query: z.string().min(1).max(LIMITS.query), price_min: Piastres.optional(), price_max: Piastres.optional() }).strict(),
]);
const Instant = z.iso.datetime({ offset: true });
const ImageKey = z.string().min(10).max(200);
const SponsorRef = z.string().min(3).max(LIMITS.sponsorRef);

const CreateBody = z
  .object({
    title: Bilingual,
    subtitle: BilingualSub.optional(),
    image_key: ImageKey.optional(),
    art_variant: z.enum(ART_VARIANTS).optional(),
    priority: z.number().int().min(0).max(LIMITS.priority).default(100),
    starts_at: Instant,
    ends_at: Instant,
    sponsored: z.boolean().default(false),
    sponsor_ref: SponsorRef.optional(),
    cta: Cta,
  })
  .strict();
const PatchBody = z
  .object({
    title: Bilingual.optional(),
    subtitle: BilingualSub.nullable().optional(),
    image_key: ImageKey.nullable().optional(),
    art_variant: z.enum(ART_VARIANTS).nullable().optional(),
    priority: z.number().int().min(0).max(LIMITS.priority).optional(),
    starts_at: Instant.optional(),
    ends_at: Instant.optional(),
    sponsored: z.boolean().optional(),
    sponsor_ref: SponsorRef.nullable().optional(),
    cta: Cta.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "empty patch" });
const PreviewQuery = z.object({ at: Instant.optional() }).strict();

type CtaIn = z.output<typeof Cta>;
const big = (n: number | undefined): bigint | null => (n === undefined ? null : BigInt(n));
function ctaOf(c: CtaIn): BannerCta {
  if (c.kind === "category") return { kind: "category", targetId: c.target_id, priceMin: big(c.price_min), priceMax: big(c.price_max) };
  if (c.kind === "search") return { kind: "search", query: c.query, priceMin: big(c.price_min), priceMax: big(c.price_max) };
  return { kind: c.kind, targetId: c.target_id };
}

const rl = (limit: number, windowSeconds = 60) => [{ dimension: "user", limit, windowSeconds }] as const;
const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};
const conflict = (code: string) => new ProblemError(409, code.replaceAll("_", "-"), "The request conflicts with the current state", { code });
const sha = (v: unknown): string => `"${createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32)}"`;

function unwrap<T>(r: Outcome<T>): T {
  switch (r.kind) {
    case "ok":
      return r.value;
    case "not_found":
      throw Problems.notFound();
    case "invalid":
      throw Problems.validation(r.problems.map((p) => ({ pointer: p.pointer, code: p.code })));
    case "conflict":
      throw conflict(r.code);
    case "audit_unavailable":
      throw Problems.unavailable("audit_unavailable");
  }
}

/** Shopper Home carousel. Public-safe projection only; the SERVER clock decides what is live. */
@Controller("home/banners")
export class HomeBannersController {
  constructor(
    @Inject(LIST_ACTIVE_HOME_BANNERS) private readonly active: ListActiveBanners,
    @Inject(HOME_BANNER_IMAGES) private readonly images: BannerImageUrlPort,
  ) {}

  @Get()
  @AuthenticatedSelf("buyer_api")
  @RateLimit(rl(120))
  async list(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    const r = await this.active.execute();
    const items = r.items.map((b) => publicWire(b, this.images, r.serverTimeMs));
    const etag = sha(items);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, max-age=30");
    const inm = headerValue(req, "if-none-match");
    if (inm !== undefined && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag || t.trim() === "*")) {
      throw new ProblemError(304, "not-modified", "Not modified");
    }
    return { items, server_time: new Date(r.serverTimeMs).toISOString() };
  }
}

/**
 * Guest Home carousel (ADR-0055 G-4): the same public-safe projection and server-clock rule as the shopper read,
 * served to anyone, identical for every caller and CDN-cacheable. No `server_time` member (it would change the
 * ETag every second); the HTTP Date header carries the server clock. Dark behind `flag.guest_browsing`.
 */
@Controller("public/home/banners")
export class PublicHomeBannersController {
  constructor(
    @Inject(GUEST_BROWSING_GATE) private readonly guest: PublicReadGate,
    @Inject(PUBLIC_READ_GATE) private readonly gate: PublicReadGate,
    @Inject(LIST_ACTIVE_HOME_BANNERS) private readonly active: ListActiveBanners,
    @Inject(HOME_BANNER_IMAGES) private readonly images: BannerImageUrlPort,
  ) {}

  @Get()
  @Public()
  @RateLimit([
    { dimension: "device", limit: 60, windowSeconds: 60 },
    { dimension: "ip", limit: 240, windowSeconds: 60 },
  ])
  async list(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    await assertGuestBrowsingEnabled(this.guest);
    await assertPublicReadEnabled(this.gate);
    const r = await this.active.execute();
    return respondPublic(req, res, { items: r.items.map((b) => publicWire(b, this.images, r.serverTimeMs)) }, PUBLIC_CACHE.banners);
  }
}

@Controller("admin/home-banners")
export class HomeBannersAdminController {
  constructor(
    @Inject(CREATE_HOME_BANNER) private readonly create: CreateBanner,
    @Inject(UPDATE_HOME_BANNER) private readonly update: UpdateBanner,
    @Inject(CHANGE_HOME_BANNER_STATUS) private readonly change: ChangeBannerStatus,
    @Inject(DELETE_HOME_BANNER) private readonly remove: DeleteBanner,
    @Inject(LIST_HOME_BANNERS_ADMIN) private readonly list: ListBannersAdmin,
    @Inject(GET_HOME_BANNER_ADMIN) private readonly get: GetBannerAdmin,
    @Inject(PREVIEW_HOME_BANNERS) private readonly preview: PreviewBanners,
    @Inject(HOME_BANNER_IMAGES) private readonly images: BannerImageUrlPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Policy already required an admin grant with a passkey; this narrows to the marketing/ops roles. */
  private actor(req: ApiRequest): { actorId: string; requestId: string | null } {
    const actor = principalOf(req).actor;
    const ok = actor.grants.some((g) => g.kind === "admin" && (ADMIN_ROLES as readonly string[]).includes(g.role));
    if (!ok) throw Problems.forbidden();
    return { actorId: actor.id, requestId: req.ctx?.requestId ?? null };
  }

  private wire(v: Parameters<typeof adminWire>[0]) {
    return adminWire(v, this.images, this.clock.nowMs());
  }

  private async view(id: string) {
    const v = await this.get.execute(id);
    if (v === null) throw Problems.notFound();
    return v;
  }

  @Get()
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: HOME_BANNER_ADMIN_RESOLVER, idParam: "none" })
  @RateLimit(rl(60))
  async index(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    this.actor(req);
    res.setHeader("Cache-Control", "private, no-store");
    return { items: (await this.list.execute()).map((v) => this.wire(v)), server_time: new Date(this.clock.nowMs()).toISOString() };
  }

  @Get("preview")
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: HOME_BANNER_ADMIN_RESOLVER, idParam: "none" })
  @RateLimit(rl(60))
  async previewRoute(@Req() req: ApiRequest, @Query(new ZodPipe(PreviewQuery, "/query")) q: z.output<typeof PreviewQuery>, @Res({ passthrough: true }) res: ApiResponse) {
    this.actor(req);
    const at = q.at === undefined ? this.clock.nowMs() : Date.parse(q.at);
    res.setHeader("Cache-Control", "private, no-store");
    // Same composer as the shopper read (<= 8 slides, sponsored spacing); the kill switch is not applied here.
    return { items: (await this.preview.execute(at)).map((b) => publicWire(b, this.images, at)), as_of: new Date(at).toISOString() };
  }

  @Get(":id")
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: HOME_BANNER_ADMIN_RESOLVER, idParam: "none" })
  @RateLimit(rl(60))
  async one(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>, @Res({ passthrough: true }) res: ApiResponse) {
    this.actor(req);
    const v = await this.view(p.id.toLowerCase());
    res.setHeader("ETag", `"v${v.banner.version}"`);
    res.setHeader("Cache-Control", "private, no-store");
    return this.wire(v);
  }

  @Post()
  @HttpCode(201)
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: HOME_BANNER_ADMIN_RESOLVER, idParam: "none" })
  @Idempotent({ required: true })
  @RateLimit(rl(60))
  async createRoute(@Req() req: ApiRequest, @Body(new ZodPipe(CreateBody)) b: z.output<typeof CreateBody>) {
    const a = this.actor(req);
    const draft: BannerDraft = {
      titleAr: b.title.ar,
      titleEn: b.title.en ?? null,
      subtitleAr: b.subtitle?.ar ?? null,
      subtitleEn: b.subtitle?.en ?? null,
      imageKey: b.image_key ?? null,
      artVariant: b.art_variant ?? null,
      priority: b.priority,
      startsAtMs: Date.parse(b.starts_at),
      endsAtMs: Date.parse(b.ends_at),
      sponsored: b.sponsored,
      sponsorRef: b.sponsor_ref ?? null,
      cta: ctaOf(b.cta),
    };
    const created = unwrap(await this.create.execute(a, draft));
    return this.wire(await this.view(created.id));
  }

  @Patch(":id")
  @HttpCode(200)
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: HOME_BANNER_ADMIN_RESOLVER, idParam: "none" })
  @Idempotent({ required: true })
  @RateLimit(rl(60))
  async patch(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>, @Body(new ZodPipe(PatchBody)) b: z.output<typeof PatchBody>) {
    const a = this.actor(req);
    const patch: { -readonly [K in keyof BannerPatch]: BannerPatch[K] } = {};
    if (b.title !== undefined) {
      patch.titleAr = b.title.ar;
      patch.titleEn = b.title.en ?? null;
    }
    if (b.subtitle !== undefined) {
      patch.subtitleAr = b.subtitle === null ? null : b.subtitle.ar;
      patch.subtitleEn = b.subtitle === null ? null : (b.subtitle.en ?? null);
    }
    if (b.image_key !== undefined) patch.imageKey = b.image_key;
    if (b.art_variant !== undefined) patch.artVariant = b.art_variant;
    if (b.priority !== undefined) patch.priority = b.priority;
    if (b.starts_at !== undefined) patch.startsAtMs = Date.parse(b.starts_at);
    if (b.ends_at !== undefined) patch.endsAtMs = Date.parse(b.ends_at);
    if (b.sponsored !== undefined) patch.sponsored = b.sponsored;
    if (b.sponsor_ref !== undefined) patch.sponsorRef = b.sponsor_ref;
    if (b.cta !== undefined) patch.cta = ctaOf(b.cta);
    const raw = headerValue(req, "if-match");
    if (raw === undefined) throw new ProblemError(428, "precondition-required", "If-Match is required", { code: "precondition_required" });
    const m = /^"?v(\d{1,9})"?$/.exec(raw.trim());
    if (m === null) throw Problems.validation([{ pointer: "/headers/if-match", code: "invalid" }]);
    const r = await this.update.execute(a, p.id.toLowerCase(), patch, Number(m[1]));
    if (r.kind === "conflict" && r.code === "version_conflict") {
      throw new ProblemError(412, "precondition-failed", "The banner changed, reload and retry", { code: "version_conflict" });
    }
    unwrap(r);
    return this.wire(await this.view(p.id.toLowerCase()));
  }

  private async transition(req: ApiRequest, id: string, action: "schedule" | "pause" | "resume") {
    const a = this.actor(req);
    unwrap(await this.change.execute(a, id.toLowerCase(), action));
    return this.wire(await this.view(id.toLowerCase()));
  }

  @Post(":id/schedule")
  @HttpCode(200)
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: HOME_BANNER_ADMIN_RESOLVER, idParam: "none" })
  @Idempotent({ required: true })
  @RateLimit(rl(60))
  schedule(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    return this.transition(req, p.id, "schedule");
  }

  @Post(":id/pause")
  @HttpCode(200)
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: HOME_BANNER_ADMIN_RESOLVER, idParam: "none" })
  @Idempotent({ required: true })
  @RateLimit(rl(60))
  pause(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    return this.transition(req, p.id, "pause");
  }

  @Post(":id/resume")
  @HttpCode(200)
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: HOME_BANNER_ADMIN_RESOLVER, idParam: "none" })
  @Idempotent({ required: true })
  @RateLimit(rl(60))
  resume(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    return this.transition(req, p.id, "resume");
  }

  @Delete(":id")
  @HttpCode(204)
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: HOME_BANNER_ADMIN_RESOLVER, idParam: "none" })
  @Idempotent({ required: true })
  @RateLimit(rl(30))
  async del(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>): Promise<void> {
    const a = this.actor(req);
    unwrap(await this.remove.execute(a, p.id.toLowerCase()));
  }
}
