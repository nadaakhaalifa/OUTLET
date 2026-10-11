import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { Authorize, Idempotent, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { ConnectChannel, RegisterCrawlTarget, VerifyCrawlTarget } from "../application/crawler";
import type { ChannelRecord, CrawlStore, MatchRecord, TargetRecord } from "../domain/ports";
import {
  CONNECT_CHANNEL,
  CRAWL_CONFIG_RESOLVER,
  CRAWL_STORE,
  CRAWL_STORE_PRODUCT_RESOLVER,
  CRAWL_STORE_RESOLVER,
  REGISTER_CRAWL_TARGET,
  VERIFY_CRAWL_TARGET,
} from "./tokens";

const StoreParam = z.object({ storeId: z.uuid() }).strict();
const TargetParam = StoreParam.extend({ targetId: z.uuid() }).strict();
const TargetBody = z
  .object({
    domain: z.string().min(4).max(253),
    verification_method: z.enum(["dns_txt", "file"]),
    consent_to_monitoring: z.literal(true),
  })
  .strict();
const ChannelBody = z
  .object({
    kind: z.enum(["shopify", "woocommerce", "odoo", "google_sheets", "crawler"]),
    token_ref: z.string().min(8).max(256),
    kms_key_ref: z.string().min(8).max(256),
    target_id: z.uuid().nullable().default(null),
  })
  .strict();

const targetWire = (t: TargetRecord) => ({
  id: t.id,
  domain: t.domain,
  kind: t.kind,
  status: t.status,
  verification_method: t.verificationMethod,
  verified_at: t.verifiedAtMs === null ? null : new Date(t.verifiedAtMs).toISOString(),
  robots_checked_at: t.robotsFetchedAtMs === null ? null : new Date(t.robotsFetchedAtMs).toISOString(),
});
/** The secret reference is never returned: the seller only learns that one is attached. */
const channelWire = (c: ChannelRecord) => ({
  id: c.id,
  kind: c.kind,
  status: c.status,
  target_id: c.targetId,
  has_secret: true,
  created_at: new Date(c.createdAtMs).toISOString(),
});
const matchWire = (m: MatchRecord) => ({
  id: m.id,
  sku_id: m.skuId,
  method: m.method,
  confidence_bp: m.confBp,
  gate: m.gate,
  scored_at: new Date(m.scoredAtMs).toISOString(),
});

const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};

const settings = (action: "read" | "update") =>
  Authorize({ audience: "seller_api", action, resourceType: "store_settings", resolver: CRAWL_STORE_RESOLVER, idParam: "storeId" });

@Controller()
export class CrawlerController {
  constructor(
    @Inject(CRAWL_STORE) private readonly store: CrawlStore,
    @Inject(REGISTER_CRAWL_TARGET) private readonly register: RegisterCrawlTarget,
    @Inject(VERIFY_CRAWL_TARGET) private readonly verify: VerifyCrawlTarget,
    @Inject(CONNECT_CHANNEL) private readonly connect: ConnectChannel,
  ) {}

  @Post("seller/stores/:storeId/crawl-targets")
  @settings("update")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 3600 }])
  async create(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>,
    @Body(new ZodPipe(TargetBody)) b: z.infer<typeof TargetBody>,
  ) {
    principalOf(req);
    const r = await this.register.execute({ storeId: p.storeId.toLowerCase(), domain: b.domain, method: b.verification_method, consent: b.consent_to_monitoring });
    switch (r.kind) {
      case "created":
        return { ...targetWire(r.target), verification_token: r.verificationToken };
      case "exists":
        return targetWire(r.target);
      case "invalid_domain":
        throw Problems.validation([{ pointer: "/domain", code: "invalid_domain" }]);
      case "consent_required":
        throw Problems.validation([{ pointer: "/consent_to_monitoring", code: "consent_required" }]);
    }
  }

  @Get("seller/stores/:storeId/crawl-targets")
  @settings("read")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async list(@Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>) {
    return { items: (await this.store.listTargets(p.storeId.toLowerCase())).map(targetWire) };
  }

  @Post("seller/stores/:storeId/crawl-targets/:targetId/verify")
  @HttpCode(200)
  @settings("update")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 3600 }])
  async verifyTarget(@Param(new ZodPipe(TargetParam, "/params")) p: z.infer<typeof TargetParam>) {
    const r = await this.verify.execute(p.storeId.toLowerCase(), p.targetId.toLowerCase());
    if (r.kind === "not_found") throw Problems.notFound();
    return { result: r.kind };
  }

  @Post("seller/stores/:storeId/channels")
  @settings("update")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 3600 }])
  async connectChannel(
    @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>,
    @Body(new ZodPipe(ChannelBody)) b: z.infer<typeof ChannelBody>,
  ) {
    const r = await this.connect.execute({
      storeId: p.storeId.toLowerCase(),
      kind: b.kind,
      tokenRef: b.token_ref,
      kmsKeyRef: b.kms_key_ref,
      targetId: b.target_id === null ? null : b.target_id.toLowerCase(),
    });
    switch (r.kind) {
      case "connected":
        return channelWire(r.channel);
      case "invalid_ref":
        throw Problems.validation([{ pointer: "/token_ref", code: "invalid_reference" }]);
      case "secret_missing":
        throw Problems.validation([{ pointer: "/token_ref", code: "secret_not_found" }]);
      case "target_required":
        throw Problems.validation([{ pointer: "/target_id", code: "verified_target_required" }]);
    }
  }

  @Get("seller/stores/:storeId/channels")
  @settings("read")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async channels(@Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>) {
    return { items: (await this.store.listChannels(p.storeId.toLowerCase())).map(channelWire) };
  }

  @Get("seller/stores/:storeId/price-matches")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_product", resolver: CRAWL_STORE_PRODUCT_RESOLVER, idParam: "storeId" })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async matches(@Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>) {
    return { items: (await this.store.matchesForStore(p.storeId.toLowerCase(), 100)).map(matchWire) };
  }

  @Get("admin/price-matching/config")
  @Authorize({ audience: "admin_api", action: "read", resourceType: "feature_flag", resolver: CRAWL_CONFIG_RESOLVER, idParam: "none" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async config() {
    const c = await this.store.getConfig();
    const l = await this.store.labelStats();
    return { tau_bp: c.tauBp, shadow_only: c.shadowOnly, version: c.version, labelled_pairs: l.pairs, kappa_milli: l.kappaMilli };
  }
}
