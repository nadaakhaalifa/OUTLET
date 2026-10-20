import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import { MoneySchema, moneyToWire, type MoneyWire } from "@outlet/validation";
import { z } from "zod";
import { Authorize, AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import { DEFAULT_ADS_CONFIG, type AdStatsView, type AdsConfig } from "../domain/bridge";
import type { CampaignResult, CampaignView, ChangeCampaignStatus, CreateCampaign, GetCampaign, ListCampaigns, UpdateCampaign } from "../application/campaigns";
import type { GetBalance, RequestTopUp } from "../application/billing";
import type { RecordClick } from "../application/clicks";
import type { GetAdsConfig, PutAdsConfig } from "../application/config";
import type { GetAdReports } from "../application/reports";
import { AdStoreAccess } from "./store-access";
import {
  ADS_ADMIN_RESOLVER,
  CAMPAIGN_RESOLVER,
  CHANGE_CAMPAIGN_STATUS,
  CREATE_CAMPAIGN,
  GET_ADS_CONFIG,
  GET_AD_REPORTS,
  GET_BALANCE,
  GET_CAMPAIGN,
  LIST_CAMPAIGNS,
  PUT_ADS_CONFIG,
  RECORD_CLICK,
  REQUEST_TOPUP,
  UPDATE_CAMPAIGN,
} from "./tokens";

const egp = (amount: bigint): MoneyWire => moneyToWire({ amount, currency: "EGP" });
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

const Egp = MoneySchema.refine((m) => m.currency === "EGP", { message: "currency must be EGP" });
const IdParam = z.object({ id: z.uuid() }).strict();
const Bid = z.object({ product_id: z.uuid(), bid: Egp }).strict();
const Words = z.array(z.string().min(1).max(60)).max(20);
const CreateBody = z
  .object({
    store_id: z.uuid(),
    name: z.string().min(2).max(80),
    daily_budget: Egp,
    max_cpc: Egp,
    keywords: Words.default([]),
    categories: Words.default([]),
    starts_at: z.iso.datetime({ offset: true }),
    ends_at: z.iso.datetime({ offset: true }).nullable().default(null),
    bids: z.array(Bid).min(1).max(50),
  })
  .strict();
const PatchBody = z
  .object({
    name: z.string().min(2).max(80).optional(),
    daily_budget: Egp.optional(),
    max_cpc: Egp.optional(),
    keywords: Words.optional(),
    categories: Words.optional(),
    ends_at: z.iso.datetime({ offset: true }).nullable().optional(),
    bids: z.array(Bid).min(1).max(50).optional(),
  })
  .strict();
const StoreQuery = z.object({ store_id: z.uuid() }).strict();
const ListQuery = z.object({ store_id: z.uuid(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
const ReportQuery = z
  .object({
    store_id: z.uuid(),
    campaign_id: z.uuid().optional(),
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
  })
  .strict();
const TopUpBody = z.object({ store_id: z.uuid(), amount: Egp }).strict();
const ClickBody = z
  .object({ click_token: z.string().min(40).max(200), session_id: z.string().min(16).max(64) })
  .strict();
const ConfigBody = z
  .object({
    floor_price: Egp,
    slots: z.number().int().min(0).max(4),
    pricing: z.enum(["gsp", "first_price"]),
    frequency_cap_per_session_day: z.number().int().min(1).max(100),
    click_token_ttl_ms: z.number().int().min(60_000).max(86_400_000),
    click_dedupe_window_ms: z.number().int().min(1_000).max(86_400_000),
    min_dwell_ms: z.number().int().min(0).max(10_000),
    max_clicks_per_session_per_minute: z.number().int().min(1).max(100),
    max_clicks_per_campaign_session_day: z.number().int().min(1).max(100),
    bot_score_block_bps: z.number().int().min(0).max(10_000),
    vat_bps: z.number().int().min(0).max(10_000),
    min_top_up: Egp,
    max_top_up: Egp,
  })
  .strict();

const ADMIN_ROLES = ["marketing", "ops", "finance", "super_admin"] as const;

const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};
const problem = (status: number, slug: string, title: string, code: string) => new ProblemError(status, slug, title, { code });

export function campaignWire(c: CampaignView) {
  return {
    id: c.id,
    store_id: c.storeId,
    name: c.name,
    status: c.status,
    daily_budget: egp(c.dailyBudget),
    max_cpc: egp(c.maxCpc),
    keywords: c.keywords,
    categories: c.categories,
    starts_at: iso(c.startsAtMs),
    ends_at: iso(c.endsAtMs),
    bids: c.bids.map((b) => ({ product_id: b.productId, bid: egp(b.bid) })),
    vat_inclusive: false,
    created_at: iso(c.createdAtMs),
  };
}

const statsWire = (s: AdStatsView) => ({
  impressions: s.impressions,
  clicks: s.clicks,
  spend: egp(s.spend),
  attributed_revenue: egp(s.attributedRevenue),
  ctr_bp: s.ctrBp,
  cpc: s.cpc === null ? null : egp(s.cpc),
  roas_bp: s.roasBp === null ? null : s.roasBp.toString(),
});

const configWire = (c: AdsConfig) => ({
  floor_price: egp(c.floorPrice),
  slots: c.slots,
  pricing: c.pricing,
  frequency_cap_per_session_day: c.frequencyCapPerSessionDay,
  click_token_ttl_ms: c.clickTokenTtlMs,
  click_dedupe_window_ms: c.clickDedupeWindowMs,
  min_dwell_ms: c.minDwellMs,
  max_clicks_per_session_per_minute: c.maxClicksPerSessionPerMinute,
  max_clicks_per_campaign_session_day: c.maxClicksPerCampaignPerSessionDay,
  bot_score_block_bps: c.botScoreBlockBps,
  vat_bps: Number(c.vatBps),
  min_top_up: egp(c.minTopUp),
  max_top_up: egp(c.maxTopUp),
});

function unwrap(r: CampaignResult): CampaignView {
  switch (r.kind) {
    case "ok":
      return r.campaign;
    case "invalid":
      throw Problems.validation(r.errors.map((e) => ({ pointer: `/body/${e.field}`, code: e.code })));
    case "advertising_blocked":
      throw problem(403, "advertising-blocked", "This store cannot advertise while a price enforcement action is active", "advertising_blocked");
    case "product_not_owned":
      throw Problems.validation([{ pointer: "/body/bids", code: "product_not_owned" }]);
    case "not_found":
      throw Problems.notFound();
    case "invalid_transition":
      throw problem(409, "invalid-transition", "That action is not possible for this campaign's status", "invalid_transition");
    case "no_balance":
      throw problem(409, "no-balance", "Top up the ad balance before resuming", "no_balance");
  }
}

@Controller()
export class AdsController {
  constructor(
    @Inject(AdStoreAccess) private readonly access: AdStoreAccess,
    @Inject(CREATE_CAMPAIGN) private readonly create: CreateCampaign,
    @Inject(UPDATE_CAMPAIGN) private readonly update: UpdateCampaign,
    @Inject(CHANGE_CAMPAIGN_STATUS) private readonly status: ChangeCampaignStatus,
    @Inject(GET_CAMPAIGN) private readonly getOne: GetCampaign,
    @Inject(LIST_CAMPAIGNS) private readonly list: ListCampaigns,
    @Inject(REQUEST_TOPUP) private readonly topUp: RequestTopUp,
    @Inject(GET_BALANCE) private readonly balance: GetBalance,
    @Inject(GET_AD_REPORTS) private readonly reports: GetAdReports,
    @Inject(RECORD_CLICK) private readonly click: RecordClick,
    @Inject(GET_ADS_CONFIG) private readonly getConfig: GetAdsConfig,
    @Inject(PUT_ADS_CONFIG) private readonly putConfig: PutAdsConfig,
  ) {}

  // ---- seller: campaigns ----

  @Post("seller/ads/campaigns")
  @AuthenticatedSelf("seller_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async createCampaign(@Req() req: ApiRequest, @Body(new ZodPipe(CreateBody)) b: z.output<typeof CreateBody>) {
    await this.access.require(principalOf(req).actor, b.store_id, "create", "store_product");
    const c = unwrap(
      await this.create.execute({
        storeId: b.store_id,
        name: b.name,
        dailyBudget: b.daily_budget.amount,
        maxCpc: b.max_cpc.amount,
        keywords: b.keywords,
        categories: b.categories,
        startsAtMs: Date.parse(b.starts_at),
        endsAtMs: b.ends_at === null ? null : Date.parse(b.ends_at),
        bids: b.bids.map((x) => ({ productId: x.product_id, bid: x.bid.amount })),
      }),
    );
    return campaignWire(c);
  }

  @Get("seller/ads/campaigns")
  @AuthenticatedSelf("seller_api")
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async listCampaigns(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) q: z.output<typeof ListQuery>) {
    await this.access.require(principalOf(req).actor, q.store_id, "read", "store_product");
    return { items: (await this.list.execute(q.store_id, q.limit)).map(campaignWire) };
  }

  @Get("seller/ads/campaigns/:id")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_product", resolver: CAMPAIGN_RESOLVER, idParam: "id" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async one(@Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    const c = await this.getOne.execute(p.id);
    if (c === null) throw Problems.notFound();
    return campaignWire(c);
  }

  @Patch("seller/ads/campaigns/:id")
  @Authorize({ audience: "seller_api", action: "update", resourceType: "store_product", resolver: CAMPAIGN_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async patch(@Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>, @Body(new ZodPipe(PatchBody)) b: z.output<typeof PatchBody>) {
    const c = unwrap(
      await this.update.execute({
        campaignId: p.id,
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.daily_budget !== undefined ? { dailyBudget: b.daily_budget.amount } : {}),
        ...(b.max_cpc !== undefined ? { maxCpc: b.max_cpc.amount } : {}),
        ...(b.keywords !== undefined ? { keywords: b.keywords } : {}),
        ...(b.categories !== undefined ? { categories: b.categories } : {}),
        ...(b.ends_at !== undefined ? { endsAtMs: b.ends_at === null ? null : Date.parse(b.ends_at) } : {}),
        ...(b.bids !== undefined ? { bids: b.bids.map((x) => ({ productId: x.product_id, bid: x.bid.amount })) } : {}),
      }),
    );
    return campaignWire(c);
  }

  @Post("seller/ads/campaigns/:id/pause")
  @HttpCode(200)
  @Authorize({ audience: "seller_api", action: "update", resourceType: "store_product", resolver: CAMPAIGN_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async pause(@Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    return campaignWire(unwrap(await this.status.execute({ campaignId: p.id, event: "seller_pause" })));
  }

  @Post("seller/ads/campaigns/:id/resume")
  @HttpCode(200)
  @Authorize({ audience: "seller_api", action: "update", resourceType: "store_product", resolver: CAMPAIGN_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async resume(@Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    return campaignWire(unwrap(await this.status.execute({ campaignId: p.id, event: "seller_resume" })));
  }

  // ---- seller: money and reports ----

  @Post("seller/ads/topup")
  @AuthenticatedSelf("seller_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 5, windowSeconds: 3600 }])
  async topup(@Req() req: ApiRequest, @Body(new ZodPipe(TopUpBody)) b: z.output<typeof TopUpBody>) {
    const principal = principalOf(req);
    await this.access.require(principal.actor, b.store_id, "update", "store_settings");
    const key = req.headers["idempotency-key"];
    const idempotencyKey = Array.isArray(key) ? key[0] : key;
    if (idempotencyKey === undefined) throw Problems.invalidIdempotencyKey();
    const r = await this.topUp.execute({ storeId: b.store_id, net: b.amount.amount, idempotencyKey });
    switch (r.kind) {
      case "ok":
        return {
          top_up_id: r.topUp.id,
          status: r.topUp.status,
          net: egp(r.quote.net),
          vat: egp(r.quote.vat),
          gross: egp(r.quote.gross),
          payment: { intent_ref: r.topUp.intentRef, client_action: r.clientAction },
          replayed: r.replayed,
        };
      case "invalid_amount":
        throw Problems.validation([{ pointer: "/body/amount", code: "out_of_range" }]);
      case "psp_unavailable":
        throw Problems.unavailable("psp_unavailable");
    }
  }

  @Get("seller/ads/balance")
  @AuthenticatedSelf("seller_api")
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async getBalanceRoute(@Req() req: ApiRequest, @Query(new ZodPipe(StoreQuery, "/query")) q: z.infer<typeof StoreQuery>) {
    await this.access.require(principalOf(req).actor, q.store_id, "read", "store_payout");
    const r = await this.balance.execute(q.store_id);
    return {
      balance: egp(r.balance),
      vat_inclusive: false,
      top_ups: r.topUps.map((t) => ({ id: t.id, status: t.status, net: egp(t.net), vat: egp(t.vat), gross: egp(t.gross) })),
    };
  }

  @Get("seller/ads/reports")
  @AuthenticatedSelf("seller_api")
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async report(@Req() req: ApiRequest, @Query(new ZodPipe(ReportQuery, "/query")) q: z.output<typeof ReportQuery>) {
    await this.access.require(principalOf(req).actor, q.store_id, "read", "store_payout");
    const fromMs = Date.parse(q.from);
    const toMs = Date.parse(q.to);
    if (toMs <= fromMs) throw Problems.validation([{ pointer: "/query/to", code: "before_from" }]);
    if (q.campaign_id !== undefined) {
      const c = await this.getOne.execute(q.campaign_id);
      if (c === null || c.storeId !== q.store_id) throw Problems.notFound();
    }
    const r = await this.reports.execute({ storeId: q.store_id, campaignId: q.campaign_id ?? null, fromMs, toMs });
    return {
      from: iso(r.fromMs),
      to: iso(r.toMs),
      total: statsWire(r.total),
      campaigns: r.campaigns.map((c) => ({ campaign_id: c.campaignId, name: c.name, ...statsWire(c.stats) })),
    };
  }

  // ---- shopper click ----

  @Post("ads/click")
  @HttpCode(200)
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async clicked(@Req() req: ApiRequest, @Body(new ZodPipe(ClickBody)) b: z.output<typeof ClickBody>) {
    const actor = principalOf(req).actor;
    const viewerStoreIds = actor.grants.flatMap((g) => (g.kind === "brand" ? [g.storeId] : []));
    const r = await this.click.execute({ token: b.click_token, sessionId: b.session_id, viewerStoreIds });
    if (r.kind === "invalid_token") throw problem(400, "invalid-click-token", "That click token is not valid", "invalid_click_token");
    // The shopper always reaches the product; billing is a separate, internal outcome.
    return { product_id: r.productId };
  }

  // ---- admin ----

  private requireAdmin(req: ApiRequest): string {
    const actor = principalOf(req).actor;
    const ok = actor.grants.some((g) => g.kind === "admin" && (ADMIN_ROLES as readonly string[]).includes(g.role));
    if (!ok) throw Problems.forbidden();
    return actor.id;
  }

  @Get("admin/ads/config")
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: ADS_ADMIN_RESOLVER, idParam: "none" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async config(@Req() req: ApiRequest) {
    this.requireAdmin(req);
    return configWire(await this.getConfig.execute());
  }

  @Put("admin/ads/config")
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: ADS_ADMIN_RESOLVER, idParam: "none" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async putConfigRoute(@Req() req: ApiRequest, @Body(new ZodPipe(ConfigBody)) b: z.output<typeof ConfigBody>) {
    const actorId = this.requireAdmin(req);
    const next: AdsConfig = {
      ...DEFAULT_ADS_CONFIG,
      floorPrice: b.floor_price.amount,
      slots: b.slots,
      pricing: b.pricing,
      frequencyCapPerSessionDay: b.frequency_cap_per_session_day,
      clickTokenTtlMs: b.click_token_ttl_ms,
      clickDedupeWindowMs: b.click_dedupe_window_ms,
      minDwellMs: b.min_dwell_ms,
      maxClicksPerSessionPerMinute: b.max_clicks_per_session_per_minute,
      maxClicksPerCampaignPerSessionDay: b.max_clicks_per_campaign_session_day,
      botScoreBlockBps: b.bot_score_block_bps,
      vatBps: BigInt(b.vat_bps),
      minTopUp: b.min_top_up.amount,
      maxTopUp: b.max_top_up.amount,
    };
    const r = await this.putConfig.execute(actorId, next);
    if (r.kind === "invalid") throw Problems.validation([{ pointer: `/body/${r.field}`, code: "invalid" }]);
    return configWire(r.config);
  }
}
