import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Req } from "@nestjs/common";
import type { Actor, BrandRole } from "@outlet/policy";
import { sellerSettings as ss } from "@outlet/domain";
import { z } from "zod";
import { Authorize, AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import { NameMismatchError, type SettingsService } from "../application/service";
import type { ProfileRecord } from "../domain/ports";
import { SETTINGS_PAYOUT_RESOLVER, SETTINGS_PRODUCT_RESOLVER, SETTINGS_SERVICE, SETTINGS_STAFF_RESOLVER, SETTINGS_STORE_RESOLVER } from "./tokens";

const StoreParam = z.object({ id: z.uuid() }).strict();
const InviteParam = z.object({ id: z.uuid(), inviteId: z.uuid() }).strict();
const UploadParam = z.object({ id: z.uuid(), uploadId: z.uuid() }).strict();
const MemberParam = z.object({ id: z.uuid(), userId: z.uuid() }).strict();

const Money = z.object({ amount: z.string().regex(/^\d{1,12}$/), currency: z.literal("EGP") }).strict();
const ProfileBody = z
  .object({
    name_ar: z.string().max(400),
    name_en: z.string().max(400).nullish(),
    description_ar: z.string().max(4000).nullish(),
    description_en: z.string().max(4000).nullish(),
    social_links: z.record(z.string().max(20), z.string().max(400)).default({}),
    return_policy: z
      .object({
        change_of_mind_days: z.number().int(),
        defect_days: z.number().int(),
        text_ar: z.string().max(4000).nullish(),
        text_en: z.string().max(4000).nullish(),
      })
      .strict(),
    free_delivery_threshold: Money,
  })
  .strict();
const VacationBody = z
  .object({ enabled: z.boolean(), until: z.iso.datetime().nullish(), eta_extra_days: z.number().int().default(0) })
  .strict();
const UploadBody = z
  .object({ slot: z.enum(["logo", "cover"]), content_type: z.string().max(60), byte_size: z.number().int() })
  .strict();
const BulkBody = z
  .object({ items: z.array(z.object({ content_type: z.string().max(60), byte_size: z.number().int() }).strict()).min(1).max(50) })
  .strict();
const BankBody = z.object({ iban: z.string().min(5).max(50), account_holder_name: z.string().min(2).max(300) }).strict();
const ShippingBody = z
  .object({
    origin: z
      .object({
        governorate_code: z.string().max(10),
        city_code: z.string().max(60),
        street: z.string().max(400),
        building: z.string().max(100).nullish(),
        landmark: z.string().max(300),
        contact_name: z.string().max(200),
        contact_phone: z.string().max(30),
        pin: z.object({ lat: z.number(), lng: z.number() }).strict().nullish(),
      })
      .strict(),
    handling_time_hours: z.number().int(),
    courier_preferences: z.record(z.string().max(10), z.array(z.string().max(20)).max(5)).default({ default: ["bosta"] }),
    packaging_options: z.array(z.string().max(30)).min(1).max(10),
  })
  .strict();
const ChannelPatch = z.partialRecord(z.enum(ss.SELLER_CHANNELS), z.boolean());
const PrefsBody = z.object({ preferences: z.partialRecord(z.enum(ss.SELLER_NOTIFICATION_EVENTS), ChannelPatch) }).strict();
const InviteBody = z.object({ phone: z.string().min(1).max(30), role: z.enum(ss.SELLER_TEAM_ROLES) }).strict();
const TokenBody = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const RoleBody = z.object({ role: z.enum(ss.SELLER_TEAM_ROLES) }).strict();

function principalOf(req: ApiRequest) {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
}

/** The actor's role at this store, from the verified token grants. */
function roleAt(actor: Actor, storeId: string): BrandRole | null {
  const g = actor.grants.find((x) => x.kind === "brand" && x.storeId === storeId);
  return g !== undefined && g.kind === "brand" ? g.role : null;
}

/**
 * Settings are owner/manager functions and the payout bank is owner/finance. The central policy has
 * already proven the actor belongs to this store (foreign store is 404); this adds the finer role
 * and the write scope for mutations.
 */
function requireWrite(req: ApiRequest, storeId: string, roles: readonly BrandRole[]): string {
  const { actor } = principalOf(req);
  const role = roleAt(actor, storeId);
  if (role === null || !roles.includes(role) || !actor.tokenScopes.includes("seller:write")) throw Problems.forbidden();
  return actor.id;
}

const NOT_FOUND = new Set(["store_not_found", "upload_not_found", "invite_not_found", "member_not_found"]);
const CONFLICT = new Set([
  "version_conflict",
  "invite_not_pending",
  "invite_expired",
  "last_owner",
  "duplicate_pending_invite",
  "already_member",
  "iban_unchanged",
  "upload_not_pending",
  "scan_pending",
  "upload_missing_in_storage",
  "upload_expired",
  "eta_invalid_transition",
  "too_many_pending_invites",
]);

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof NameMismatchError) {
      throw new ProblemError(422, "name-mismatch", "The account holder name does not match the registered legal name", {
        code: "name_mismatch",
        extensions: { score: e.score, required_score: ss.NAME_MATCH_MIN_SCORE },
      });
    }
    if (e instanceof ss.SellerSettingsError) {
      if (NOT_FOUND.has(e.code)) throw Problems.notFound();
      if (e.code === "owner_only") throw Problems.forbidden();
      const status = CONFLICT.has(e.code) ? 409 : 422;
      throw new ProblemError(status, e.code.replace(/_/g, "-"), "The request cannot be applied", { code: e.code });
    }
    throw e;
  }
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const money = (v: bigint) => ({ amount: v.toString(), currency: "EGP" as const });

function profileWire(p: ProfileRecord, nowMs: number) {
  return {
    store_id: p.storeId,
    name_ar: p.nameAr,
    name_en: p.nameEn,
    description_ar: p.descriptionAr,
    description_en: p.descriptionEn,
    logo_key: p.logoKey,
    cover_key: p.coverKey,
    social_links: p.socialLinks,
    return_policy: {
      change_of_mind_days: p.returnPolicy.changeOfMindDays,
      defect_days: p.returnPolicy.defectDays,
      text_ar: p.returnPolicy.textAr,
      text_en: p.returnPolicy.textEn,
      statutory_minimum: { change_of_mind_days: ss.LEGAL_MIN_CHANGE_OF_MIND_DAYS, defect_days: ss.LEGAL_MIN_DEFECT_DAYS },
    },
    free_delivery_threshold: money(p.freeDeliveryThreshold),
    vacation: {
      enabled: ss.isOnVacation(p.vacation, nowMs),
      until: iso(ss.isOnVacation(p.vacation, nowMs) ? p.vacation.untilMs : null),
      eta_extra_days: ss.etaExtraDaysFor(p.vacation, nowMs),
    },
    version: p.version,
  };
}

function etaWire(e: { status: string; failureCode: string | null; requestedAtMs: number | null; lastCheckedAtMs: number | null; lastVerifiedAtMs: number | null }) {
  return {
    status: e.status,
    failure_code: e.failureCode,
    requested_at: iso(e.requestedAtMs),
    last_checked_at: iso(e.lastCheckedAtMs),
    last_verified_at: iso(e.lastVerifiedAtMs),
  };
}

const uploadWire = (u: { uploadId: string; key: string; signed: { url: string; method: "PUT"; headers: Readonly<Record<string, string>>; expiresAtMs: number } }) => ({
  upload_id: u.uploadId,
  object_key: u.key,
  upload_url: u.signed.url,
  method: u.signed.method,
  headers: u.signed.headers,
  expires_at: iso(u.signed.expiresAtMs),
});

@Controller("seller")
export class SellerSettingsController {
  constructor(
    @Inject(SETTINGS_SERVICE) private readonly svc: SettingsService,
    @Inject("SETTINGS_NOW") private readonly now: () => number,
  ) {}

  // ----------------------------------------------------------------- profile
  @Get("stores/:id/profile")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_settings", resolver: SETTINGS_STORE_RESOLVER, idParam: "id" })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  getProfile(@Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>) {
    return run(async () => profileWire(await this.svc.getProfile(p.id), this.now()));
  }

  @Put("stores/:id/profile")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_settings", resolver: SETTINGS_STORE_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  putProfile(@Req() req: ApiRequest, @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>, @Body(new ZodPipe(ProfileBody)) b: z.infer<typeof ProfileBody>) {
    const actor = requireWrite(req, p.id, ["owner", "manager"]);
    return run(async () =>
      profileWire(
        await this.svc.updateProfile(p.id, actor, {
          nameAr: b.name_ar,
          nameEn: b.name_en,
          descriptionAr: b.description_ar,
          descriptionEn: b.description_en,
          socialLinks: b.social_links,
          returnPolicy: {
            changeOfMindDays: b.return_policy.change_of_mind_days,
            defectDays: b.return_policy.defect_days,
            textAr: b.return_policy.text_ar,
            textEn: b.return_policy.text_en,
          },
          freeDeliveryThreshold: BigInt(b.free_delivery_threshold.amount),
        }),
        this.now(),
      ),
    );
  }

  @Put("stores/:id/vacation")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_settings", resolver: SETTINGS_STORE_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  putVacation(@Req() req: ApiRequest, @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>, @Body(new ZodPipe(VacationBody)) b: z.infer<typeof VacationBody>) {
    const actor = requireWrite(req, p.id, ["owner", "manager"]);
    return run(async () =>
      profileWire(
        await this.svc.setVacation(p.id, actor, {
          enabled: b.enabled,
          untilMs: b.until === null || b.until === undefined ? null : Date.parse(b.until),
          etaExtraDays: b.eta_extra_days,
        }),
        this.now(),
      ),
    );
  }

  @Get("stores/:id/storefront-preview")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_settings", resolver: SETTINGS_STORE_RESOLVER, idParam: "id" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  preview(@Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>) {
    return run(async () => {
      const v = await this.svc.preview(p.id);
      return {
        slug: v.slug,
        kind: v.kind,
        verified_badge: v.verifiedBadge,
        name: { ar: v.nameAr, ...(v.nameEn !== null ? { en: v.nameEn } : {}) },
        description: { ...(v.descriptionAr !== null ? { ar: v.descriptionAr } : {}), ...(v.descriptionEn !== null ? { en: v.descriptionEn } : {}) },
        logo_url: v.logoUrl,
        cover_url: v.coverUrl,
        social_links: v.socialLinks,
        return_policy: {
          change_of_mind_days: v.returnPolicy.changeOfMindDays,
          defect_days: v.returnPolicy.defectDays,
          text_ar: v.returnPolicy.textAr,
          text_en: v.returnPolicy.textEn,
        },
        free_delivery_threshold: money(v.freeDeliveryThreshold),
        accepting_orders: v.acceptingOrders,
        on_vacation_until: iso(v.onVacationUntilMs),
        eta_extra_days: v.etaExtraDays,
        handling_time_hours: v.handlingHours,
        legal_identity: {
          legal_name: v.legalIdentity.legalName,
          commercial_register_no: v.legalIdentity.commercialRegisterNo,
          tax_card_no: v.legalIdentity.taxCardNo,
          governorate_code: v.legalIdentity.governorateCode,
        },
      };
    });
  }

  // ----------------------------------------------------------------- media
  @Post("stores/:id/media/uploads")
  @HttpCode(201)
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_settings", resolver: SETTINGS_STORE_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  upload(@Req() req: ApiRequest, @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>, @Body(new ZodPipe(UploadBody)) b: z.infer<typeof UploadBody>) {
    const actor = requireWrite(req, p.id, ["owner", "manager"]);
    return run(async () => uploadWire(await this.svc.requestUpload(p.id, actor, b.slot, b.content_type, b.byte_size)));
  }

  @Post("stores/:id/media/uploads/:uploadId/confirm")
  @HttpCode(200)
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_settings", resolver: SETTINGS_STORE_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  confirm(@Req() req: ApiRequest, @Param(new ZodPipe(UploadParam, "/params")) p: z.infer<typeof UploadParam>) {
    const actor = requireWrite(req, p.id, ["owner", "manager"]);
    return run(async () => {
      const u = await this.svc.confirmUpload(p.id, actor, p.uploadId);
      return { upload_id: u.id, slot: u.slot, status: u.status, width: u.width, height: u.height };
    });
  }

  @Post("stores/:id/media/product-uploads")
  @HttpCode(201)
  @Authorize({ audience: "seller_api", action: "create", resourceType: "store_product", resolver: SETTINGS_PRODUCT_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  bulk(@Req() req: ApiRequest, @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>, @Body(new ZodPipe(BulkBody)) b: z.infer<typeof BulkBody>) {
    const actor = requireWrite(req, p.id, ["owner", "manager", "catalog"]);
    return run(async () => ({
      items: (await this.svc.requestBulkProductUploads(p.id, actor, b.items.map((i) => ({ contentType: i.content_type, byteSize: i.byte_size })))).map(uploadWire),
    }));
  }

  // ----------------------------------------------------------------- payout account
  @Get("stores/:id/payout-account")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_payout", resolver: SETTINGS_PAYOUT_RESOLVER, idParam: "id" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  getBank(@Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>) {
    return run(async () => {
      const a = await this.svc.getPayoutAccount(p.id);
      return a === null ? { configured: false } : bankWire(a);
    });
  }

  @Put("stores/:id/payout-account")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_payout", resolver: SETTINGS_PAYOUT_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 5, windowSeconds: 3600 }])
  putBank(@Req() req: ApiRequest, @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>, @Body(new ZodPipe(BankBody)) b: z.infer<typeof BankBody>) {
    const actor = requireWrite(req, p.id, ["owner", "finance"]);
    return run(async () => bankWire(await this.svc.setPayoutAccount(p.id, actor, { iban: b.iban, holderName: b.account_holder_name })));
  }

  @Get("stores/:id/payout-account/history")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_payout", resolver: SETTINGS_PAYOUT_RESOLVER, idParam: "id" })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  bankHistory(@Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>) {
    return run(async () => ({
      items: (await this.svc.history(p.id, "payout_account")).map((e) => ({ kind: e.kind, at: iso(e.occurredAtMs), detail: e.detail })),
    }));
  }

  // ----------------------------------------------------------------- shipping
  @Get("stores/:id/shipping")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_settings", resolver: SETTINGS_STORE_RESOLVER, idParam: "id" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  getShipping(@Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>) {
    return run(async () => {
      const s = await this.svc.getShipping(p.id);
      return s === null ? { configured: false, handling_time_hours: ss.DEFAULT_HANDLING_HOURS } : shippingWire(s);
    });
  }

  @Put("stores/:id/shipping")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_settings", resolver: SETTINGS_STORE_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  putShipping(@Req() req: ApiRequest, @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>, @Body(new ZodPipe(ShippingBody)) b: z.infer<typeof ShippingBody>) {
    const actor = requireWrite(req, p.id, ["owner", "manager"]);
    return run(async () =>
      shippingWire(
        await this.svc.putShipping(p.id, actor, {
          origin: {
            governorateCode: b.origin.governorate_code,
            cityCode: b.origin.city_code,
            street: b.origin.street,
            building: b.origin.building ?? null,
            landmark: b.origin.landmark,
            contactName: b.origin.contact_name,
            contactPhoneE164: b.origin.contact_phone,
            pin: b.origin.pin ?? null,
          },
          handlingHours: b.handling_time_hours,
          courierPreferences: b.courier_preferences,
          packaging: b.packaging_options,
        }),
      ),
    );
  }

  // ----------------------------------------------------------------- notification prefs
  @Get("stores/:id/notification-preferences")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_settings", resolver: SETTINGS_STORE_RESOLVER, idParam: "id" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  getPrefs(@Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>) {
    return run(async () => ({ preferences: await this.svc.getPrefs(p.id), transactional_events: [...ss.TRANSACTIONAL_EVENTS] }));
  }

  @Put("stores/:id/notification-preferences")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_settings", resolver: SETTINGS_STORE_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  putPrefs(@Req() req: ApiRequest, @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>, @Body(new ZodPipe(PrefsBody)) b: z.infer<typeof PrefsBody>) {
    const actor = requireWrite(req, p.id, ["owner", "manager"]);
    return run(async () => ({ preferences: await this.svc.updatePrefs(p.id, actor, b.preferences), transactional_events: [...ss.TRANSACTIONAL_EVENTS] }));
  }

  // ----------------------------------------------------------------- team
  @Get("stores/:id/team")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_staff", resolver: SETTINGS_STAFF_RESOLVER, idParam: "id" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  team(@Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>) {
    return run(async () => {
      const t = await this.svc.listTeam(p.id);
      return {
        members: t.members.map((m) => ({
          user_id: m.userId,
          role: m.role,
          phone_masked: m.phoneE164 === null ? null : ss.maskPhone(m.phoneE164),
          joined_at: iso(m.joinedAtMs),
        })),
        invites: t.invites.map((i) => ({
          id: i.id,
          role: i.role,
          phone_masked: i.phoneMasked,
          status: i.status,
          created_at: iso(i.createdAtMs),
          expires_at: iso(i.expiresAtMs),
        })),
      };
    });
  }

  @Post("stores/:id/team/invites")
  @HttpCode(201)
  @Authorize({ audience: "seller_api", action: "create", resourceType: "store_staff", resolver: SETTINGS_STAFF_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 3600 }])
  invite(@Req() req: ApiRequest, @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>, @Body(new ZodPipe(InviteBody)) b: z.infer<typeof InviteBody>) {
    const actor = requireWrite(req, p.id, ["owner"]);
    return run(async () => {
      const i = await this.svc.invite(p.id, actor, { phone: b.phone, role: b.role });
      return { id: i.id, role: i.role, phone_masked: i.phoneMasked, status: i.status, expires_at: iso(i.expiresAtMs) };
    });
  }

  @Delete("stores/:id/team/invites/:inviteId")
  @HttpCode(204)
  @Authorize({ audience: "seller_api", action: "delete", resourceType: "store_staff", resolver: SETTINGS_STAFF_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  async revoke(@Req() req: ApiRequest, @Param(new ZodPipe(InviteParam, "/params")) p: z.infer<typeof InviteParam>): Promise<void> {
    const actor = requireWrite(req, p.id, ["owner"]);
    await run(() => this.svc.revokeInvite(p.id, actor, p.inviteId));
  }

  @Patch("stores/:id/team/members/:userId")
  @Authorize({ audience: "seller_api", action: "update", resourceType: "store_staff", resolver: SETTINGS_STAFF_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  async changeRole(@Req() req: ApiRequest, @Param(new ZodPipe(MemberParam, "/params")) p: z.infer<typeof MemberParam>, @Body(new ZodPipe(RoleBody)) b: z.infer<typeof RoleBody>) {
    const actor = requireWrite(req, p.id, ["owner"]);
    await run(() => this.svc.changeMember(p.id, actor, p.userId, b.role));
    return { user_id: p.userId, role: b.role };
  }

  @Delete("stores/:id/team/members/:userId")
  @HttpCode(204)
  @Authorize({ audience: "seller_api", action: "delete", resourceType: "store_staff", resolver: SETTINGS_STAFF_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  async removeMember(@Req() req: ApiRequest, @Param(new ZodPipe(MemberParam, "/params")) p: z.infer<typeof MemberParam>): Promise<void> {
    const actor = requireWrite(req, p.id, ["owner"]);
    await run(() => this.svc.changeMember(p.id, actor, p.userId, null));
  }

  @Post("team-invites/accept")
  @HttpCode(200)
  @AuthenticatedSelf("seller_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 3600 }, { dimension: "ip", limit: 30, windowSeconds: 3600 }])
  accept(@Req() req: ApiRequest, @Body(new ZodPipe(TokenBody)) b: z.infer<typeof TokenBody>) {
    return run(async () => {
      const r = await this.svc.acceptInvite(principalOf(req).actor.id, b.token);
      return { store_id: r.storeId, role: r.role };
    });
  }

  @Post("team-invites/decline")
  @HttpCode(204)
  @AuthenticatedSelf("seller_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 3600 }, { dimension: "ip", limit: 30, windowSeconds: 3600 }])
  async decline(@Req() req: ApiRequest, @Body(new ZodPipe(TokenBody)) b: z.infer<typeof TokenBody>): Promise<void> {
    await run(() => this.svc.declineInvite(principalOf(req).actor.id, b.token));
  }

  // ----------------------------------------------------------------- eta
  @Get("stores/:id/eta-enrolment")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_settings", resolver: SETTINGS_STORE_RESOLVER, idParam: "id" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  eta(@Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>) {
    return run(async () => etaWire(await this.svc.getEta(p.id)));
  }

  @Post("stores/:id/eta-enrolment/request")
  @HttpCode(200)
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_settings", resolver: SETTINGS_STORE_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 3600 }])
  etaRequest(@Req() req: ApiRequest, @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>) {
    const actor = requireWrite(req, p.id, ["owner", "manager"]);
    return run(async () => etaWire(await this.svc.requestEta(p.id, actor)));
  }

  @Post("stores/:id/eta-enrolment/revoke")
  @HttpCode(200)
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_settings", resolver: SETTINGS_STORE_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 3600 }])
  etaRevoke(@Req() req: ApiRequest, @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>) {
    const actor = requireWrite(req, p.id, ["owner", "manager"]);
    return run(async () => etaWire(await this.svc.revokeEta(p.id, actor)));
  }
}

function bankWire(a: { ibanLast4: string; activatesAtMs: number; legalNameScore: number; createdAtMs: number; hold: { held: boolean; untilMs: number | null } }) {
  return {
    configured: true,
    iban_masked: ss.maskIban(a.ibanLast4),
    iban_last4: a.ibanLast4,
    name_match_score: a.legalNameScore,
    payouts_held: a.hold.held,
    held_until: iso(a.hold.untilMs),
    activates_at: iso(a.activatesAtMs),
    created_at: iso(a.createdAtMs),
  };
}

function shippingWire(s: {
  governorateCode: string;
  cityCode: string;
  street: string;
  building: string | null;
  landmark: string;
  contactName: string;
  contactPhoneMasked: string;
  pin: { lat: number; lng: number } | null;
  handlingHours: number;
  courierPreferences: ss.CourierPreferences;
  packaging: readonly string[];
}) {
  return {
    configured: true,
    origin: {
      governorate_code: s.governorateCode,
      city_code: s.cityCode,
      street: s.street,
      building: s.building,
      landmark: s.landmark,
      contact_name: s.contactName,
      contact_phone_masked: s.contactPhoneMasked,
      pin: s.pin,
    },
    handling_time_hours: s.handlingHours,
    courier_preferences: s.courierPreferences,
    packaging_options: s.packaging,
  };
}
